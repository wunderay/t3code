//! The Coordinator's inbox: an append-only log of what changed in the threads it manages.
//!
//! Its thread is woken by what it has not been told of yet, and reads the rest with
//! `coordinator_inbox`; what a read passed is cut at the next read.

use crate::{Error, Result, field, model::Assignment, store, text};
use rusqlite::{Transaction, params};
use serde_json::{Map, Value, json};

const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT NOT NULL,
    body TEXT NOT NULL CHECK(json_valid(body)));
  INSERT OR IGNORE INTO meta VALUES ('eventsRead', 0), ('eventsWoken', 0);
  INSERT OR IGNORE INTO meta SELECT 'eventsConfirmed', value FROM meta WHERE key='eventsRead';
  CREATE TABLE IF NOT EXISTS inbox_run (id INTEGER PRIMARY KEY CHECK(id=1), run TEXT NOT NULL);";

// What the Coordinator did itself never wakes it.
const OWN: &str = "('coordinator','coordinator-model')";

pub fn migrate(tx: &Transaction<'_>) -> Result<()> {
    tx.execute_batch(SCHEMA).map_err(Error::internal)
}

fn mark(tx: &Transaction<'_>, key: &str) -> Result<u64> {
    tx.query_row("SELECT value FROM meta WHERE key=?1", [key], |r| r.get(0))
        .map_err(Error::internal)
}

/// The Coordinator turn whose reads `eventsRead` holds; they count only once it completed.
fn reading_run(tx: &Transaction<'_>) -> Result<Option<String>> {
    tx.query_row("SELECT run FROM inbox_run WHERE id=1", [], |r| r.get(0))
        .map(Some)
        .or_else(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            error => Err(Error::internal(error)),
        })
}

/// Where the inbox stands: the turn reading it, how far it read, and how far completed turns read.
pub fn position(tx: &Transaction<'_>) -> Result<Value> {
    Ok(
        json!({"runId":reading_run(tx)?,"read":mark(tx, "eventsRead")?,
        "confirmed":mark(tx, "eventsConfirmed")?}),
    )
}

/// The turn `runId` completed: what it read was read.
pub fn confirm(tx: &Transaction<'_>, parameters: &Value) -> Result<Value> {
    let run = field(parameters, "runId")?;
    if reading_run(tx)?.as_deref() == Some(run) {
        raise(tx, "eventsConfirmed", mark(tx, "eventsRead")?)?;
    }
    Ok(json!({}))
}

fn raise(tx: &Transaction<'_>, key: &str, seq: u64) -> Result<()> {
    tx.execute(
        "UPDATE meta SET value=MAX(value,?2) WHERE key=?1",
        params![key, seq],
    )
    .map_err(Error::internal)?;
    Ok(())
}

/// With the Coordinator off nothing is recorded: no one would read it.
pub fn record(tx: &Transaction<'_>, actor: &str, event: Value, now: u64) -> Result<Option<u64>> {
    if !crate::config(tx)?.enabled {
        return Ok(None);
    }
    let mut event = event;
    event["at"] = json!(now);
    tx.execute(
        "INSERT INTO events(actor,body) VALUES (?1,?2)",
        params![actor, event.to_string()],
    )
    .map_err(Error::internal)?;
    Ok(Some(tx.last_insert_rowid() as u64))
}

/// Writes an assignment; one that ended or became blocked is an event of whoever asked for the
/// change, the host unless the request names another.
pub fn put_assignment(
    tx: &Transaction<'_>,
    assignment: &Assignment,
    revision: u64,
    parameters: &Value,
    now: u64,
) -> Result<()> {
    let actor = parameters
        .get("actor")
        .and_then(Value::as_str)
        .unwrap_or("host");
    let before = store::get::<Assignment>(tx, "assignment", &assignment.id)?.map(|a| a.status);
    store::put(tx, "assignment", &assignment.id, assignment, revision)?;
    let status = assignment.status.as_str();
    if before.as_deref() != Some(status)
        && ["completed", "verified", "failed", "cancelled", "blocked"].contains(&status)
    {
        let card: Option<crate::model::Card> = store::get(tx, "card", &assignment.card_id)?;
        let mut event = json!({"kind":"assignment","subject":assignment.id,"status":status,
            "threadId":card.as_ref().map(|card| &card.thread_id),"goalId":assignment.goal_id});
        // Blocked for what: as whoever blocked it says, or else as its thread's card does.
        if status == "blocked"
            && let Some(reason) = parameters
                .get("reason")
                .and_then(Value::as_str)
                .or(card.as_ref().and_then(|card| card.blocker.as_deref()))
        {
            event["reason"] = json!(reason.chars().take(500).collect::<String>());
        }
        record(tx, actor, event, now)?;
    }
    Ok(())
}

/// The host's own facts about a managed thread, such as a question waiting in it.
pub fn append(tx: &Transaction<'_>, parameters: &Value, now: u64) -> Result<Value> {
    let actor = field(parameters, "actor")?;
    text(actor, 80, "actor")?;
    let event = parameters
        .get("event")
        .and_then(Value::as_object)
        .ok_or_else(|| Error::invalid("event must be an object"))?;
    let mut kept = Map::new();
    for key in ["kind", "subject", "status", "threadId", "summary"] {
        if let Some(value) = event.get(key).and_then(Value::as_str) {
            // The subject may be a provider's own request id: data, longer than an identifier.
            let max = match key {
                "summary" => 500,
                "subject" => 1024,
                _ => 256,
            };
            text(value, max, key)?;
            kept.insert(key.into(), json!(value));
        }
    }
    if !kept.contains_key("kind") {
        return Err(Error::invalid("Missing string kind"));
    }
    Ok(json!({"seq":record(tx, actor, Value::Object(kept), now)?}))
}

/// What came since `cursor`, oldest first; without one, since what was last read, so a reader that
/// lost its cursor, as after a compaction, is never handed again what it read. A read in a turn
/// (`runId`) counts once that turn completed: a new turn goes on from what completed turns read, so
/// what a stopped, failed or lost turn read comes back. The cursor is the reader's word, so it counts
/// only up to what was handed out before: nothing unread is skipped or cut. What completed turns
/// read is cut once its thread settled; the rest stays until then.
pub fn read(tx: &Transaction<'_>, parameters: &Value) -> Result<Value> {
    let run = parameters.get("runId").and_then(Value::as_str);
    if let Some(run) = run
        && reading_run(tx)?.as_deref() != Some(run)
    {
        text(run, 256, "runId")?;
        tx.execute(
            "UPDATE meta SET value=(SELECT value FROM meta WHERE key='eventsConfirmed') WHERE key='eventsRead'",
            [],
        )
        .map_err(Error::internal)?;
        tx.execute("INSERT OR REPLACE INTO inbox_run VALUES (1, ?1)", [run])
            .map_err(Error::internal)?;
    }
    let delivered = mark(tx, "eventsRead")?;
    let confirmed = mark(tx, "eventsConfirmed")?;
    let cursor = parameters
        .get("cursor")
        .and_then(Value::as_u64)
        .unwrap_or(delivered)
        .min(delivered);
    let limit = crate::page_limit(parameters)?;
    tx.execute(
        "DELETE FROM events WHERE seq<=?1 AND (json_extract(body,'$.threadId') IS NULL OR EXISTS (
            SELECT 1 FROM documents WHERE kind='card'
            AND json_extract(documents.body,'$.threadId')=json_extract(events.body,'$.threadId')
            AND (json_extract(documents.body,'$.settled')=1 OR json_extract(documents.body,'$.archived')=1)))",
        [confirmed],
    )
    .map_err(Error::internal)?;
    let mut statement = tx
        .prepare("SELECT seq,actor,body FROM events WHERE seq>?1 ORDER BY seq LIMIT ?2")
        .map_err(Error::internal)?;
    let rows = statement
        .query_map(params![cursor, limit as u64 + 1], |r| {
            Ok((
                r.get::<_, u64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .map_err(Error::internal)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(Error::internal)?;
    let more = rows.len() > limit;
    let mut events = Vec::new();
    for (seq, actor, body) in rows.into_iter().take(limit) {
        let mut event: Value = serde_json::from_str(&body).map_err(Error::internal)?;
        event["seq"] = json!(seq);
        event["actor"] = json!(actor);
        events.push(event);
    }
    let next = events
        .last()
        .and_then(|e| e["seq"].as_u64())
        .unwrap_or(cursor);
    raise(tx, "eventsRead", next)?;
    // A read outside any turn has no turn to complete: it counts at once.
    if run.is_none() {
        raise(tx, "eventsConfirmed", next)?;
    }
    Ok(json!({"events":events,"nextCursor":next,"more":more}))
}

fn kinds_after(tx: &Transaction<'_>, after: u64) -> Result<(Map<String, Value>, u64)> {
    let mut statement = tx
        .prepare(&format!(
            "SELECT json_extract(body,'$.kind'),COUNT(*),MAX(seq) FROM events
             WHERE seq>?1 AND actor NOT IN {OWN} GROUP BY 1"
        ))
        .map_err(Error::internal)?;
    let rows = statement
        .query_map([after], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, u64>(1)?,
                r.get::<_, u64>(2)?,
            ))
        })
        .map_err(Error::internal)?;
    let (mut kinds, mut through) = (Map::new(), after);
    for row in rows {
        let (kind, count, last) = row.map_err(Error::internal)?;
        kinds.insert(kind, json!(count));
        through = through.max(last);
    }
    Ok((kinds, through))
}

/// By kind: what no completed wake has told the Coordinator of and it has not read (`kinds`, up
/// to `through`), and everything it has not read (`unread`). Its own events are left out.
pub fn pending(tx: &Transaction<'_>) -> Result<Value> {
    let read = mark(tx, "eventsConfirmed")?;
    let (kinds, through) = kinds_after(tx, read.max(mark(tx, "eventsWoken")?))?;
    let (unread, _) = kinds_after(tx, read)?;
    Ok(json!({"kinds":kinds,"through":through,"unread":unread}))
}

/// The turn that carried a wake completed: everything through `through` was told, and what the
/// turn (`runId`) read was read.
pub fn woken(tx: &Transaction<'_>, parameters: &Value) -> Result<Value> {
    let through = parameters
        .get("through")
        .and_then(Value::as_u64)
        .ok_or_else(|| Error::invalid("through must be an integer"))?;
    raise(tx, "eventsWoken", through)?;
    // The same turn read the inbox: that read counts too.
    if parameters.get("runId").is_some() {
        confirm(tx, parameters)?;
    }
    Ok(json!({}))
}
