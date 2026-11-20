use crate::{Error, Result, config, field, model::*, pause_state, registry, store};
use rusqlite::Transaction;
use serde_json::{Value, json};

pub(crate) fn enqueue(tx: &Transaction<'_>, goal: &Goal, revision: u64, now: u64) -> Result<()> {
    for id in &goal.assignment_ids {
        let assignment: Assignment = store::required(tx, "assignment", id)?;
        queue(tx, Some(&goal.id), &assignment, None, revision, now)?;
    }
    Ok(())
}

/// Work that ended without being done settles at once: cancelled, replaced by later work, or
/// left when its goal was cancelled.
fn ended(tx: &Transaction<'_>, id: &str, reason: &str, revision: u64, now: u64) -> Result<()> {
    let Some(assignment) = store::get::<Assignment>(tx, "assignment", id)? else {
        return Ok(());
    };
    if crate::supervision::live(&assignment.status) || !ended_proof(tx, &assignment, reason)? {
        return Ok(());
    }
    queue(
        tx,
        assignment.goal_id.as_deref(),
        &assignment,
        Some(reason),
        revision,
        now,
    )
}

fn ended_proof(tx: &Transaction<'_>, assignment: &Assignment, reason: &str) -> Result<bool> {
    Ok(match reason {
        "cancelled" => assignment.status == "cancelled",
        "replaced" => {
            ["failed", "cancelled"].contains(&assignment.status.as_str())
                && tx
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM documents WHERE kind='assignment' AND EXISTS(SELECT 1 FROM json_each(body,'$.supersedes') WHERE value=?1))",
                        [&assignment.id],
                        |row| row.get::<_, bool>(0),
                    )
                    .map_err(Error::internal)?
        }
        "abandoned" => match &assignment.goal_id {
            Some(goal) => store::get::<Goal>(tx, "goal", goal)?
                .is_some_and(|goal| goal.status == "cancelled"),
            None => false,
        },
        _ => false,
    })
}

/// After a call that can end work without its being done, its threads settle at once.
pub(crate) fn after(
    tx: &Transaction<'_>,
    method: &str,
    parameters: &Value,
    result: &Value,
    revision: u64,
    now: u64,
) -> Result<()> {
    match method {
        "assignments.update" | "assignments.ack" | "assignments.cancel" => {
            match parameters.get("id").and_then(Value::as_str) {
                Some(id) => ended(tx, id, "cancelled", revision, now),
                None => Ok(()),
            }
        }
        "actions.ack" => {
            let Some(id) = parameters.get("id").and_then(Value::as_str) else {
                return Ok(());
            };
            match store::get::<Action>(tx, "action", id)?.and_then(|action| action.assignment_id) {
                Some(id) => ended(tx, &id, "cancelled", revision, now),
                None => Ok(()),
            }
        }
        "stop" => {
            for assignment in store::every::<Assignment>(
                tx,
                "assignment",
                "json_extract(body,'$.status')='cancelled' AND NOT EXISTS(SELECT 1 FROM documents AS a WHERE a.kind='action' AND a.id='settle:cancelled:'||json_extract(documents.body,'$.id'))",
            )? {
                ended(tx, &assignment.id, "cancelled", revision, now)?;
            }
            Ok(())
        }
        "assignments.prepare" => {
            for id in result["assignment"]["supersedes"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
            {
                ended(tx, id, "replaced", revision, now)?;
            }
            Ok(())
        }
        "goals.upsert" if result["goal"]["status"] == "cancelled" => {
            for id in result["goal"]["assignmentIds"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
            {
                ended(tx, id, "abandoned", revision, now)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

fn queue(
    tx: &Transaction<'_>,
    goal_id: Option<&str>,
    assignment: &Assignment,
    ended: Option<&str>,
    revision: u64,
    now: u64,
) -> Result<()> {
    {
        let card: Card = store::required(tx, "card", &assignment.card_id)?;
        if card.settled
            || card.archived
            || card.thread_id.starts_with("coordinator-lead:")
            || assignment.execution_id.is_none()
            || assignment.receipt.is_none()
        {
            return Ok(());
        }
        let local_binding = assignment
            .receipt
            .as_ref()
            .and_then(|receipt| receipt.get("threadId"))
            .and_then(Value::as_str)
            == Some(card.thread_id.as_str());
        let cloud_binding = assignment
            .route
            .destination
            .as_deref()
            .is_some_and(|destination| destination.starts_with("cloud:"))
            && assignment.execution_id.as_deref() == Some(card.thread_id.as_str());
        if !local_binding && !cloud_binding {
            return Ok(());
        }
        let action_id = format!(
            "settle:{}:{}",
            ended.or(goal_id).unwrap_or(""),
            assignment.id
        );
        if store::get::<Action>(tx, "action", &action_id)?.is_some() {
            return Ok(());
        }
        let expected_run = assignment
            .receipt
            .as_ref()
            .and_then(|receipt| receipt.get("latestRunId").or_else(|| receipt.get("runId")))
            .cloned()
            .unwrap_or_else(|| json!(assignment.execution_id));
        let mut payload = json!({"goalId":goal_id,"assignmentId":assignment.id,"cardId":card.id,"cardRevision":card.revision,"expectedRunId":expected_run,"cloud":cloud_binding});
        if let Some(reason) = ended {
            payload["ended"] = json!(reason);
        }
        let action = Action {
            id: action_id,
            kind: "thread.settle".into(),
            assignment_id: None,
            thread_id: Some(card.thread_id.clone()),
            environment_id: Some(card.environment_id.clone()),
            payload,
            status: "pending".into(),
            revision,
            created_at: now,
            pause_revision: pause_state(tx)?.revision,
            instruction_revision: Some(card.instruction_revision),
            grant_revision: None,
        };
        store::put(tx, "action", &action.id, &action, revision)?;
    }
    Ok(())
}
fn proof_matches(tx: &Transaction<'_>, action: &Action) -> Result<bool> {
    if let Some(reason) = action.payload["ended"].as_str() {
        let assignment: Assignment =
            store::required(tx, "assignment", field(&action.payload, "assignmentId")?)?;
        let card: Card = store::required(tx, "card", field(&action.payload, "cardId")?)?;
        return Ok(ended_proof(tx, &assignment, reason)?
            && assignment.card_id == card.id
            && Some(card.instruction_revision) == action.instruction_revision
            && !card.archived);
    }
    let goal: Goal = store::required(tx, "goal", field(&action.payload, "goalId")?)?;
    let assignment: Assignment =
        store::required(tx, "assignment", field(&action.payload, "assignmentId")?)?;
    let card: Card = store::required(tx, "card", field(&action.payload, "cardId")?)?;
    let proof: Option<Value> = store::get(tx, "goalResolution", &goal.id)?;
    Ok(goal.status == "completed"
        && goal.verified
        && proof.is_some()
        && assignment.goal_id.as_deref() == Some(goal.id.as_str())
        && assignment.card_id == card.id
        && goal.assignment_ids.contains(&assignment.id)
        && (assignment.status == "verified"
            || registry::supersession_approved(tx, &goal, &assignment.id)?)
        && Some(card.instruction_revision) == action.instruction_revision
        && !card.archived)
}
pub(crate) fn claim(tx: &Transaction<'_>, action: &mut Action, revision: u64) -> Result<bool> {
    let configuration = config(tx)?;
    if !configuration.enabled || configuration.coordinator_paused || pause_state(tx)?.active {
        return Err(Error::forbidden(
            "Automatic settlement waits for coordinator resume",
        ));
    }
    let card: Card = store::required(tx, "card", field(&action.payload, "cardId")?)?;
    // Only a reopen (which marks the card stale) or a settlement already made ends it; a change of
    // status, title or blocker on the card does not, or the thread would never settle.
    if !proof_matches(tx, action)? || card.settled || card.stale {
        action.status = "invalidated".into();
        action.revision = revision;
        store::put(tx, "action", &action.id, action, revision)?;
        return Ok(false);
    }
    Ok(true)
}
pub(crate) fn acknowledge(
    tx: &Transaction<'_>,
    action: &Action,
    status: &str,
    result: &Value,
    revision: u64,
) -> Result<()> {
    if status != "completed" {
        return Ok(());
    }
    if result["settled"] != true
        || result["cardId"] != action.payload["cardId"]
        || !proof_matches(tx, action)?
    {
        return Err(Error::conflict(
            "Automatic settlement requires current proof and destination receipt",
        ));
    }
    let mut card: Card = store::required(tx, "card", field(&action.payload, "cardId")?)?;
    // A more recent explicit reopen must not be overwritten by a late destination ACK.
    if card.stale && !card.settled {
        return Ok(());
    }
    card.settled = true;
    card.revision = revision;
    store::put(tx, "card", &card.id, &card, revision)?;
    crate::grant::forget_proposals_for(tx, &card, revision)
}

/// Settlements the host made whose steps after it (its worktree, its archive) the host has not
/// yet reported done: what a crash may have left unfinished, and nothing the owner settled.
pub(crate) fn unfinished(tx: &Transaction<'_>) -> Result<Value> {
    Ok(json!({"items":store::every::<Action>(
        tx,
        "action",
        "json_extract(body,'$.kind')='thread.settle' AND json_extract(body,'$.status')='completed' AND json_extract(body,'$.payload.finished') IS NULL",
    )?}))
}

/// The host's report that a settlement's steps after it are done; recovery leaves it alone.
pub(crate) fn finished(tx: &Transaction<'_>, parameters: &Value, revision: u64) -> Result<Value> {
    let mut action: Action = store::required(tx, "action", field(parameters, "id")?)?;
    if action.kind != "thread.settle" {
        return Err(Error::invalid("Only a settlement is finished"));
    }
    action.payload["finished"] = json!(true);
    action.revision = revision;
    store::put(tx, "action", &action.id, &action, revision)?;
    Ok(json!({"action":action}))
}
