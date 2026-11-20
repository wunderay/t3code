// Corrective work reuses immutable assignment lineage and the existing transactional outbox.
// This is not a spend ledger: initial work, successful integration and reviewer reruns are free.
use crate::{Error, Result, model::*, store};
use rusqlite::Transaction;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Repairs {
    sources: Vec<String>,
    attempts: Vec<String>,
}

pub(crate) fn reject_sources(
    tx: &Transaction<'_>,
    goal_id: &str,
    ids: &[String],
    revision: u64,
) -> Result<()> {
    let mut state: Repairs = store::get(tx, "goalRepairs", goal_id)?.unwrap_or_default();
    for id in ids {
        let source: Assignment = store::required(tx, "assignment", id)?;
        if source.goal_id.as_deref() != Some(goal_id)
            || source.role == "reviewer"
            || !["completed", "failed"].contains(&source.status.as_str())
            || source.execution_id.is_none()
            || source.receipt.is_none()
        {
            return Err(Error::conflict(
                "Repair sources require terminal same-goal author execution receipts",
            ));
        }
        if !state.sources.contains(id) {
            state.sources.push(id.clone());
        }
    }
    store::put(tx, "goalRepairs", goal_id, &state, revision)?;
    if ids.iter().any(|id| state.attempts.contains(id)) {
        escalate_if_used(tx, goal_id, &state, revision)?;
    }
    Ok(())
}

pub(crate) fn failed(tx: &Transaction<'_>, assignment: &Assignment, revision: u64) -> Result<()> {
    if assignment.status == "failed"
        && assignment.role != "reviewer"
        && assignment.execution_id.is_some()
        && assignment.receipt.is_some()
        && let Some(goal_id) = &assignment.goal_id
    {
        // Only a terminal destination execution is a source. Launch failures and unknown transport
        // outcomes have no such receipt and must never be classified as unsuccessful implementation.
        let mut state: Repairs = store::get(tx, "goalRepairs", goal_id)?.unwrap_or_default();
        if !state.sources.contains(&assignment.id) {
            state.sources.push(assignment.id.clone());
        }
        store::put(tx, "goalRepairs", goal_id, &state, revision)?;
        if state.attempts.contains(&assignment.id) {
            escalate_if_used(tx, goal_id, &state, revision)?;
        }
    }
    Ok(())
}

fn used(tx: &Transaction<'_>, state: &Repairs) -> Result<usize> {
    let mut total = 0;
    for id in &state.attempts {
        let assignment: Assignment = store::required(tx, "assignment", id)?;
        // A queued launch reserves a slot atomically with prepare. Once claimed/uncertain, retain
        // it across restart even before an execution ID arrives. Only proven unlaunched terminal
        // attempts release that slot. A terminal action was necessarily claimed before ACK; a
        // generic failed/unsupported ACK does not prove that submission never happened.
        let claimed: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM documents WHERE kind='action' AND json_extract(body,'$.kind')='dispatch' AND json_extract(body,'$.assignmentId')=?1 AND json_extract(body,'$.status')<>'pending' AND (json_extract(body,'$.status') NOT IN ('failed','unsupported') OR COALESCE(json_extract(body,'$.payload.acknowledgement.status'),'')<>'not-dispatched'))", [id], |row| row.get(0)).map_err(Error::internal)?;
        if assignment.execution_id.is_some()
            || claimed
            || !["failed", "cancelled"].contains(&assignment.status.as_str())
        {
            total += 1;
        }
    }
    Ok(total)
}

fn limit_reason(limit: usize) -> String {
    format!(
        "The goal's {limit} corrective implementation attempts are used or reserved. Ask the user before another repair; independent review remains available."
    )
}

fn escalate_if_used(
    tx: &Transaction<'_>,
    goal_id: &str,
    state: &Repairs,
    revision: u64,
) -> Result<()> {
    let goal: Goal = store::required(tx, "goal", goal_id)?;
    let limit = goal.max_attempts.unwrap_or(3) as usize;
    if ["active", "blocked"].contains(&goal.status.as_str()) && used(tx, state)? >= limit {
        block(tx, &goal, &limit_reason(limit), revision)?;
    }
    Ok(())
}

pub(crate) fn reason(
    tx: &Transaction<'_>,
    goal: &Goal,
    id: &str,
    role: &str,
    supersedes: &[String],
) -> Result<Option<String>> {
    if !["active", "blocked"].contains(&goal.status.as_str()) {
        return Err(Error::conflict("Goal is already terminal"));
    }
    if role == "reviewer" {
        return Ok(None);
    }
    let state: Repairs = store::get(tx, "goalRepairs", &goal.id)?.unwrap_or_default();
    if state.sources.is_empty() || state.attempts.iter().any(|existing| existing == id) {
        return Ok(None);
    }
    if !supersedes
        .iter()
        .any(|source| state.sources.contains(source) || state.attempts.contains(source))
    {
        return Ok(Some("Corrective work must name the rejected or failed same-goal source in supersedes; a new assignment ID does not reset repairs.".into()));
    }
    let limit = goal.max_attempts.unwrap_or(3) as usize;
    if used(tx, &state)? >= limit {
        return Ok(Some(limit_reason(limit)));
    }
    Ok(None)
}

pub(crate) fn block(tx: &Transaction<'_>, goal: &Goal, reason: &str, revision: u64) -> Result<()> {
    let lineage_missing = reason.starts_with("Corrective work must name");
    let marker = if lineage_missing {
        "repair-lineage"
    } else {
        "repair-limit"
    };
    let decision_id = format!("{marker}:{}", goal.id);
    if goal.status == "blocked"
        && store::get::<Decision>(tx, "decision", &decision_id)?
            .is_some_and(|decision| decision.summary == reason)
    {
        return Ok(());
    }
    let mut blocked = goal.clone();
    blocked.status = "blocked".into();
    blocked.verified = false;
    blocked.revision = revision;
    store::put(tx, "goal", &goal.id, &blocked, revision)?;
    let decision = Decision {
        id: decision_id,
        summary: reason.into(),
        provenance: format!("coordinator-{marker}"),
        card_ids: vec![],
        goal_ids: vec![goal.id.clone()],
        expires_at: None,
        revision,
    };
    store::put(tx, "decision", &decision.id, &decision, revision)
}

pub(crate) fn reserve(tx: &Transaction<'_>, assignment: &Assignment, revision: u64) -> Result<()> {
    if assignment.role == "reviewer" {
        return Ok(());
    }
    if let Some(goal_id) = &assignment.goal_id {
        let mut state: Repairs = store::get(tx, "goalRepairs", goal_id)?.unwrap_or_default();
        if !state.sources.is_empty() && !state.attempts.contains(&assignment.id) {
            state.attempts.push(assignment.id.clone());
            store::put(tx, "goalRepairs", goal_id, &state, revision)?;
        }
    }
    Ok(())
}

pub(crate) fn routing_reason(
    tx: &Transaction<'_>,
    entry: &Value,
    revision: u64,
) -> Result<Option<String>> {
    let goal: Goal = store::required(tx, "goal", crate::field(entry, "goalId")?)?;
    let supersedes: Vec<String> = serde_json::from_value(
        entry["intent"]["supersedes"]
            .as_array()
            .cloned()
            .map_or(json!([]), Value::Array),
    )
    .map_err(Error::internal)?;
    let reason = reason(
        tx,
        &goal,
        crate::field(entry, "id")?,
        entry["intent"]["role"].as_str().unwrap_or("adventurer"),
        &supersedes,
    )?;
    if let Some(reason) = &reason {
        block(tx, &goal, reason, revision)?;
    }
    Ok(reason)
}
