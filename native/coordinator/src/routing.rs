use crate::{
    Error, Result, config, field, identifier, model::*, pause_state, policy_revision, store, text,
};
use rusqlite::{Transaction, params};
use serde_json::{Value, json};

fn goal_binding(goal: &Goal) -> Value {
    json!({"id":goal.id,"purpose":goal.purpose,"criteria":goal.acceptance_criteria,"scope":goal.authorized_scope,"dependencies":goal.dependencies})
}
fn valid_source(tx: &Transaction<'_>, entry: &Value) -> Result<bool> {
    let goal: Goal = store::required(tx, "goal", field(entry, "goalId")?)?;
    let card: Card = store::required(tx, "card", field(entry, "cardId")?)?;
    Ok(["active", "blocked"].contains(&goal.status.as_str())
        && goal_binding(&goal) == entry["goalBinding"]
        && !card.settled
        && !card.archived
        && entry["instructionRevision"].as_u64() == Some(card.instruction_revision)
        && goal.authorized_scope.iter().any(|id| {
            [
                &card.id,
                &card.thread_id,
                &card.project_id,
                &card.environment_id,
            ]
            .contains(&id)
        }))
}
fn save(tx: &Transaction<'_>, entry: &mut Value, revision: u64) -> Result<()> {
    entry["revision"] = json!(revision);
    store::put(tx, "routingIntent", field(entry, "id")?, entry, revision)
}
pub(crate) fn enqueue(
    tx: &Transaction<'_>,
    parameters: &Value,
    revision: u64,
    now: u64,
) -> Result<Value> {
    let id = field(parameters, "id")?;
    identifier(id)?;
    let goal: Goal = store::required(tx, "goal", field(parameters, "goalId")?)?;
    let card: Card = store::required(tx, "card", field(parameters, "cardId")?)?;
    let intent = parameters
        .get("intent")
        .ok_or_else(|| Error::invalid("Missing bounded delegate intent"))?;
    if intent["kind"] != "delegate"
        || intent["goalId"].as_str() != Some(goal.id.as_str())
        || intent["parentThreadId"].as_str() != Some(card.thread_id.as_str())
        || serde_json::to_string(intent)
            .map_err(Error::internal)?
            .len()
            > 20000
    {
        return Err(Error::invalid(
            "Routing stores only bounded source-bound delegate intents",
        ));
    }
    let binding = goal_binding(&goal);
    for previous in store::list::<Value>(
        tx,
        "routingIntent",
        "json_extract(body,'$.status')='waiting'",
        "",
        100,
    )? {
        if previous["cardId"] == json!(card.id)
            && previous["goalBinding"] == binding
            && previous["instructionRevision"] == parameters["instructionRevision"]
            && previous["intent"] == *intent
        {
            return Ok(json!({"routingIntent":previous,"deduplicated":true}));
        }
    }
    if store::count(
        tx,
        "routingIntent",
        "json_extract(body,'$.status')='waiting'",
    )? >= 100
    {
        return Err(Error::conflict("Pending routing queue is full"));
    }
    if store::get::<Assignment>(tx, "assignment", id)?.is_some()
        || store::get::<Value>(tx, "routingIntent", id)?.is_some()
    {
        return Err(Error::conflict("Routing identity already exists"));
    }
    let mut entry = json!({"id":id,"goalId":goal.id,"cardId":card.id,"intent":intent,"goalBinding":binding,"instructionRevision":parameters["instructionRevision"],"status":"waiting","reason":"Awaiting a supported Guild capacity reservation","nextAttemptAt":now,"attempts":0,"generation":0,"pauseRevision":pause_state(tx)?.revision,"grantRevision":policy_revision(tx)?,"revision":revision});
    if !valid_source(tx, &entry)? {
        return Err(Error::conflict("Routing source is no longer authorized"));
    }
    save(tx, &mut entry, revision)?;
    Ok(json!({"routingIntent":entry}))
}
pub(crate) fn ready(
    tx: &Transaction<'_>,
    parameters: &Value,
    revision: u64,
    now: u64,
) -> Result<Value> {
    let configuration = config(tx)?;
    if !configuration.enabled || configuration.coordinator_paused || pause_state(tx)?.active {
        return Ok(json!({"items":[]}));
    }
    let limit = crate::page_limit(parameters)?.min(5);
    let mut statement=tx.prepare("SELECT body FROM documents WHERE kind='routingIntent' AND json_extract(body,'$.status')='waiting' AND json_extract(body,'$.nextAttemptAt')<=?1 ORDER BY json_extract(body,'$.nextAttemptAt'),id LIMIT ?2").map_err(Error::internal)?;
    let rows = statement
        .query_map(params![now, limit as u64], |row| row.get::<_, String>(0))
        .map_err(Error::internal)?;
    let entries: Vec<Value> = rows
        .map(|row| serde_json::from_str(&row.map_err(Error::internal)?).map_err(Error::internal))
        .collect::<Result<_>>()?;
    let mut ready = Vec::new();
    for mut entry in entries {
        if store::get::<Assignment>(tx, "assignment", field(&entry, "id")?)?.is_some() {
            entry["status"] = json!("prepared");
            save(tx, &mut entry, revision)?;
        } else if !valid_source(tx, &entry)? {
            entry["status"] = json!("cancelled");
            entry["reason"] = json!("Source user goal, scope, or instructions changed");
            save(tx, &mut entry, revision)?;
        } else {
            ready.push(entry);
        }
    }
    Ok(json!({"items":ready}))
}
pub(crate) fn claim(
    tx: &Transaction<'_>,
    parameters: &Value,
    revision: u64,
    now: u64,
) -> Result<Value> {
    let mut entry: Value = store::required(tx, "routingIntent", field(parameters, "id")?)?;
    if store::get::<Assignment>(tx, "assignment", field(&entry, "id")?)?.is_some() {
        entry["status"] = json!("prepared");
        save(tx, &mut entry, revision)?;
        return Ok(json!({"claimed":false,"routingIntent":entry}));
    }
    let configuration = config(tx)?;
    if entry["status"] != "waiting"
        || entry["nextAttemptAt"].as_u64().is_some_and(|due| due > now)
        || !configuration.enabled
        || configuration.coordinator_paused
        || pause_state(tx)?.active
    {
        return Ok(json!({"claimed":false,"routingIntent":entry}));
    }
    if !valid_source(tx, &entry)? {
        entry["status"] = json!("cancelled");
        entry["reason"] = json!("Source user goal, scope, or thread instructions changed");
        save(tx, &mut entry, revision)?;
        return Ok(json!({"claimed":false,"routingIntent":entry}));
    }
    if let Some(reason) = crate::repairs::routing_reason(tx, &entry, revision)? {
        entry["status"] = json!("repair-blocked");
        entry["reason"] = json!(reason);
        save(tx, &mut entry, revision)?;
        return Ok(json!({"claimed":false,"routingIntent":entry}));
    }
    let generation = entry["generation"]
        .as_u64()
        .unwrap_or(0)
        .checked_add(1)
        .ok_or_else(|| Error::conflict("Routing generation exhausted"))?;
    entry["generation"] = json!(generation);
    entry["attempts"] = json!(generation);
    entry["nextAttemptAt"] = json!(now.saturating_add(60000));
    entry["pauseRevision"] = json!(pause_state(tx)?.revision);
    entry["grantRevision"] = json!(policy_revision(tx)?);
    // A route claim only reserves capacity. No execution may start before assignments.prepare commits.
    entry["reservationKey"] = json!(format!("{}:routing:{generation}", field(&entry, "id")?));
    save(tx, &mut entry, revision)?;
    Ok(json!({"claimed":true,"routingIntent":entry}))
}
pub(crate) fn defer(
    tx: &Transaction<'_>,
    parameters: &Value,
    revision: u64,
    now: u64,
) -> Result<Value> {
    let mut entry: Value = store::required(tx, "routingIntent", field(parameters, "id")?)?;
    if store::get::<Assignment>(tx, "assignment", field(&entry, "id")?)?.is_some() {
        entry["status"] = json!("prepared");
    } else if entry["status"] == "waiting" {
        let reason = field(parameters, "reason")?;
        text(reason, 1000, "routing reason")?;
        entry["reason"] = json!(reason);
        entry["nextAttemptAt"] = json!(now.saturating_add(60000));
    }
    save(tx, &mut entry, revision)?;
    Ok(json!({"routingIntent":entry}))
}
/// An assignment that ends may free what held waiting work, so that work is due at once.
pub(crate) fn due(tx: &Transaction<'_>, revision: u64, now: u64) -> Result<()> {
    let filter = format!(
        "json_extract(body,'$.status')='waiting' AND json_extract(body,'$.nextAttemptAt')>{now}"
    );
    for mut entry in store::every::<Value>(tx, "routingIntent", &filter)? {
        entry["nextAttemptAt"] = json!(now);
        save(tx, &mut entry, revision)?;
    }
    Ok(())
}
pub(crate) fn prepared(
    tx: &Transaction<'_>,
    parameters: &Value,
    assignment: &Value,
    revision: u64,
) -> Result<()> {
    let Some(id) = parameters.get("routingIntentId").and_then(Value::as_str) else {
        return Ok(());
    };
    let mut entry: Value = store::required(tx, "routingIntent", id)?;
    if entry["status"] == "prepared" && assignment["id"].as_str() == Some(id) {
        return Ok(());
    }
    if entry["status"] != "waiting"
        || entry["generation"] != parameters["routingGeneration"]
        || assignment["id"].as_str() != Some(id)
        || assignment["idempotencyKey"].as_str() != Some(id)
        || assignment["cardId"] != entry["cardId"]
        || assignment["goalId"] != entry["goalId"]
        || !valid_source(tx, &entry)?
    {
        return Err(Error::conflict(
            "Routing source or generation changed before preparation",
        ));
    }
    entry["status"] = json!("prepared");
    entry["reason"] = json!("Durable assignment/outbox prepared; routing retries are disabled");
    save(tx, &mut entry, revision)
}
pub(crate) fn compact(tx: &Transaction<'_>, limit: usize) -> Result<Vec<Value>> {
    Ok(store::list::<Value>(tx,"routingIntent","json_extract(body,'$.status')='waiting'","",limit)?.into_iter().map(|entry|json!({"id":entry["id"],"goalId":entry["goalId"],"cardId":entry["cardId"],"status":entry["status"],"reason":entry["reason"],"nextAttemptAt":entry["nextAttemptAt"],"attempts":entry["attempts"],"revision":entry["revision"]})).collect())
}

pub(crate) fn cancel(tx: &Transaction<'_>, parameters: &Value, revision: u64) -> Result<Value> {
    let mut entry: Value = store::required(tx, "routingIntent", field(parameters, "id")?)?;
    if entry["status"] == "waiting"
        && store::get::<Assignment>(tx, "assignment", field(&entry, "id")?)?.is_none()
    {
        let reason = field(parameters, "reason")?;
        text(reason, 1000, "routing cancellation reason")?;
        entry["status"] = json!("cancelled");
        entry["reason"] = json!(reason);
        save(tx, &mut entry, revision)?;
    }
    Ok(json!({"routingIntent":entry}))
}
