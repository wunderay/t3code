//! What the owner's dashboard and settings read in one request; nothing here writes.
use crate::{Error, Result, board::Limits, model::*, store};
use rusqlite::{Transaction, types::Value as Sql};
use serde_json::{Map, Value, json};

const DAY_MS: u64 = 86_400_000;
const LIVE: &str =
    "json_extract(body,'$.status') NOT IN ('completed','verified','cancelled','failed')";
const ACTIVE_GOALS: &str = "SELECT id FROM documents WHERE kind='goal' AND json_extract(body,'$.status') IN ('active','blocked','merging')";

/// Each row as an object keyed by its column names.
fn objects(tx: &Transaction<'_>, sql: &str, values: impl rusqlite::Params) -> Result<Vec<Value>> {
    let mut statement = tx.prepare(sql).map_err(Error::internal)?;
    let names: Vec<String> = statement
        .column_names()
        .into_iter()
        .map(str::to_owned)
        .collect();
    statement
        .query_map(values, |row| {
            let mut object = Map::new();
            for (index, name) in names.iter().enumerate() {
                let value = match row.get::<_, Sql>(index)? {
                    Sql::Null => Value::Null,
                    Sql::Integer(value) => json!(value),
                    Sql::Real(value) => json!(value),
                    Sql::Text(value) => json!(value),
                    Sql::Blob(_) => Value::Null,
                };
                object.insert(name.clone(), value);
            }
            Ok(Value::Object(object))
        })
        .map_err(Error::internal)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(Error::internal)
}

/// Every row of a kind the filter selects: the owner's view is never cut at a page.
fn every<T: serde::de::DeserializeOwned>(
    tx: &Transaction<'_>,
    kind: &str,
    filter: &str,
) -> Result<Vec<T>> {
    store::list(tx, kind, filter, "", i64::MAX as usize)
}

pub(crate) fn board(tx: &Transaction<'_>, parameters: &Value, now: u64) -> Result<Value> {
    let day = now / DAY_MS;
    let limits: Limits = store::get(tx, "system", "boardLimits")?.unwrap_or_default();
    let open = format!(
        "SELECT id FROM documents WHERE kind='assignment' AND (json_extract(body,'$.status') NOT IN ('completed','verified','cancelled','failed') OR json_extract(body,'$.goalId') IN ({ACTIVE_GOALS}))"
    );
    Ok(json!({
        "cards": every::<Card>(tx, "card", "COALESCE(json_extract(body,'$.settled'),0)=0 AND COALESCE(json_extract(body,'$.archived'),0)=0")?,
        "assignments": every::<Assignment>(tx, "assignment", LIVE)?,
        "goals": every::<Goal>(tx, "goal", "json_extract(body,'$.status') IN ('active','blocked','merging')")?,
        // What each merging goal waits for, and whether the owner is who it waits for.
        "merges": objects(tx, &format!("SELECT json_extract(body,'$.goalId') AS goalId, json_extract(body,'$.waiting.reason') AS reason, json_extract(body,'$.waiting.owner') AS owner FROM documents WHERE kind='merge' AND json_extract(body,'$.merged') IS NULL AND json_extract(body,'$.goalId') IN ({ACTIVE_GOALS}) ORDER BY 1"), [])?,
        // Merged changes not yet taken back: what the owner may revert.
        // A hand merge at a head no review saw says so, with the head that landed.
        "merged": objects(tx, "SELECT m.id AS goalId, json_extract(g.body,'$.purpose') AS purpose, json_extract(m.body,'$.merged.head') AS head, json_extract(m.body,'$.merged.unreviewed') AS unreviewed FROM documents m JOIN documents g ON g.kind='goal' AND g.id=m.id WHERE m.kind='merge' AND json_extract(m.body,'$.merged') IS NOT NULL AND json_extract(m.body,'$.reverted') IS NULL ORDER BY m.revision DESC", [])?,
        // Goals whose merged change was taken back: done, but their doubled cost stays in view.
        "reverted": objects(tx, "SELECT m.id AS goalId, json_extract(g.body,'$.purpose') AS purpose FROM documents m JOIN documents g ON g.kind='goal' AND g.id=m.id WHERE m.kind='merge' AND json_extract(m.body,'$.reverted') IS NOT NULL ORDER BY m.revision DESC", [])?,
        // Worktrees kept after settling because they hold files git does not track unchanged.
        "kept": objects(tx, "SELECT substr(id, 15) AS threadId, json_extract(body,'$.summary') AS summary FROM documents WHERE kind='decision' AND id LIKE 'worktree-kept:%' AND (json_extract(body,'$.expiresAt') IS NULL OR json_extract(body,'$.expiresAt')>?1) ORDER BY id", [now])?,
        "weights": crate::router::weights(tx)?,
        "limits": limits,
        "danger": crate::danger::list(tx)?,
        "budgets": objects(tx, "SELECT id AS projectId, json_extract(body,'$.micros') AS micros, json_extract(body,'$.seconds') AS seconds FROM documents WHERE kind='budget' ORDER BY id", [])?,
        "today": objects(tx, "SELECT json_extract(body,'$.projectId') AS projectId, SUM(json_extract(body,'$.micros')) AS micros, SUM(json_extract(body,'$.seconds')) AS seconds FROM documents WHERE kind='spend' AND json_extract(body,'$.day')=?1 AND json_extract(body,'$.projectId') IS NOT NULL GROUP BY 1 ORDER BY 1", [day])?,
        "dayStartedAt": day * DAY_MS,
        // The host's clock, against which clients measure time in state and stalls.
        "now": now,
        "spend": objects(tx, &format!("SELECT json_extract(body,'$.assignmentId') AS assignmentId, json_extract(body,'$.goalId') AS goalId, SUM(json_extract(body,'$.micros')) AS micros, SUM(json_extract(body,'$.seconds')) AS seconds FROM documents WHERE kind='spend' AND json_extract(body,'$.assignmentId') IN ({open}) GROUP BY 1,2 ORDER BY 1"), [])?,
        "costs": costs(tx, parameters)?,
        "runs": crate::remote::latest(tx, &open)?,
        "unresolved": crate::remote::unresolved(tx, now)?["items"],
        "settled": store::count(tx, "card", "COALESCE(json_extract(body,'$.settled'),0)=1 AND COALESCE(json_extract(body,'$.archived'),0)=0")?,
    }))
}

/// Each open goal's repairs and finished rounds, and its time and reverts as routing counts them,
/// with the rounds still running (`running`, from the host's clock) added.
fn costs(tx: &Transaction<'_>, parameters: &Value) -> Result<Vec<Value>> {
    let mut times: std::collections::HashMap<String, Value> =
        crate::router::goal_times(tx, parameters.get("running").unwrap_or(&Value::Null))?
            .into_iter()
            .map(|time| (time["goalId"].as_str().unwrap_or_default().to_owned(), time))
            .collect();
    let mut rows = objects(
        tx,
        &format!(
            "SELECT g.id AS goalId,
            (SELECT json_array_length(body,'$.attempts') FROM documents WHERE kind='goalRepairs' AND id=g.id) AS repairs,
            (SELECT SUM(json_array_length(body,'$.rounds')) FROM documents WHERE kind='outcome' AND json_extract(body,'$.goalId')=g.id) AS rounds
            FROM (SELECT id FROM documents WHERE kind='goal' AND ({costed})) AS g ORDER BY g.id",
            costed = crate::router::COSTED_GOALS
        ),
        [],
    )?;
    for row in &mut rows {
        let time = times.remove(row["goalId"].as_str().unwrap_or_default());
        row["seconds"] = time
            .as_ref()
            .map_or(Value::Null, |time| time["seconds"].clone());
        row["useMicros"] = time
            .as_ref()
            .map_or(Value::Null, |time| time["useMicros"].clone());
        row["reverts"] = time.map_or(json!(0), |time| time["reverts"].clone());
    }
    Ok(rows)
}
