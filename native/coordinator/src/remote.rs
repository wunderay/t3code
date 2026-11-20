//! Cloud runs, kept collectable across restarts (ported from the Guild's `remote.py`).
//!
//! One row per hand-out, reserved before the cloud is called and never replaced, so a
//! restart or crash never leaves a started run untracked. States:
//! out -> collected | abandoned | lost -> ended | unstopped -> ended.
//! Neither cloud can be stopped, so a cancelled run is `unstopped`: listed as
//! still running until the owner confirms it ended.

use crate::{Error, Result, field, identifier};
use rusqlite::{OptionalExtension, Row, Transaction, params};
use serde::Serialize;
use serde_json::{Value, json};

const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS remote_run (
    id INTEGER PRIMARY KEY AUTOINCREMENT, assignment_id TEXT NOT NULL, kind TEXT NOT NULL,
    branch TEXT NOT NULL, base TEXT NOT NULL, repository TEXT NOT NULL, handle TEXT NOT NULL,
    model TEXT, effort TEXT, head TEXT, state TEXT NOT NULL, started_at INTEGER NOT NULL,
    deadline_at INTEGER NOT NULL, ended_at INTEGER, due_waited_ms INTEGER NOT NULL DEFAULT 0,
    login TEXT, branch_head TEXT, moved_at INTEGER);
  CREATE INDEX IF NOT EXISTS remote_run_state ON remote_run(state,assignment_id);";

pub fn migrate(tx: &Transaction<'_>) -> Result<()> {
    tx.execute_batch(SCHEMA).map_err(Error::internal)?;
    // Stores made by earlier builds of this branch lack the later columns.
    for column in ["login", "branch_head", "moved_at"] {
        let present: bool = tx
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('remote_run') WHERE name=?1",
                [column],
                |r| r.get(0),
            )
            .map_err(Error::internal)?;
        if !present {
            let kind = if column == "moved_at" {
                "INTEGER"
            } else {
                "TEXT"
            };
            tx.execute_batch(&format!(
                "ALTER TABLE remote_run ADD COLUMN {column} {kind}"
            ))
            .map_err(Error::internal)?;
        }
    }
    Ok(())
}

// Until a stop route is verified, a cancelled run is reported as still running, never as stopped.
fn unstoppable(kind: &str) -> &'static str {
    match kind {
        "claude-cloud" => "Claude cloud sessions have no stop command in the Claude CLI",
        _ => "no Codex cloud stop or archive command is known",
    }
}

// Nothing collects these, and nothing has shown that they ended.
const UNRESOLVED: &str = "('lost','unstopped')";
const MAY_PUSH: &str = "('out','lost','unstopped')";
// A longer gap between two polls (the server was down, the host slept) counts nothing.
const STEP_CAP_MS: u64 = 600_000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Run {
    id: i64,
    assignment_id: String,
    kind: String,
    branch: String,
    base: String,
    repository: String,
    /// Empty while the cloud is being called.
    handle: String,
    model: Option<String>,
    effort: Option<String>,
    head: Option<String>,
    state: String,
    started_at: u64,
    deadline_at: u64,
    ended_at: Option<u64>,
    due_waited_ms: u64,
    login: Option<String>,
    /// The last commit seen on the run's branch, and when it was first seen.
    branch_head: Option<String>,
    moved_at: Option<u64>,
}

fn run(row: &Row<'_>) -> rusqlite::Result<Run> {
    Ok(Run {
        id: row.get("id")?,
        assignment_id: row.get("assignment_id")?,
        kind: row.get("kind")?,
        branch: row.get("branch")?,
        base: row.get("base")?,
        repository: row.get("repository")?,
        handle: row.get("handle")?,
        model: row.get("model")?,
        effort: row.get("effort")?,
        head: row.get("head")?,
        state: row.get("state")?,
        started_at: row.get("started_at")?,
        deadline_at: row.get("deadline_at")?,
        ended_at: row.get("ended_at")?,
        due_waited_ms: row.get("due_waited_ms")?,
        login: row.get("login")?,
        branch_head: row.get("branch_head")?,
        moved_at: row.get("moved_at")?,
    })
}

fn rows(tx: &Transaction<'_>, sql: &str, values: impl rusqlite::Params) -> Result<Vec<Run>> {
    let mut statement = tx.prepare(sql).map_err(Error::internal)?;
    statement
        .query_map(values, run)
        .map_err(Error::internal)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(Error::internal)
}

pub fn call(tx: &Transaction<'_>, method: &str, p: &Value, now: u64) -> Result<Value> {
    match method {
        "remote.reserve" => reserve(tx, p, now),
        "remote.handle" => handle(tx, p),
        "remote.progress" => progress(tx, p, now),
        "remote.get" => {
            let found = rows(
                tx,
                "SELECT * FROM remote_run WHERE assignment_id=?1 ORDER BY id DESC LIMIT 1",
                [field(p, "assignmentId")?],
            )?;
            Ok(json!({ "run": found.into_iter().next() }))
        }
        "remote.close" => close(tx, p, now),
        "remote.wait" => wait(tx, p),
        "remote.release" => release(tx, p),
        "remote.unresolved" => unresolved(tx, now),
        "remote.ended" => ended(tx, p, now),
        _ => Err(Error {
            code: -32601,
            message: format!("Unknown method: {method}"),
        }),
    }
}

fn optional<'a>(p: &'a Value, key: &str) -> Result<Option<&'a str>> {
    match p.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => identifier(value).map(|()| Some(value.as_str())),
        Some(_) => Err(Error::invalid(format!("{key} must be a string"))),
    }
}

fn reserve(tx: &Transaction<'_>, p: &Value, now: u64) -> Result<Value> {
    let assignment = field(p, "assignmentId")?;
    let kind = field(p, "kind")?;
    if !matches!(kind, "codex-cloud" | "claude-cloud") {
        return Err(Error::invalid("kind must be codex-cloud or claude-cloud"));
    }
    let base = field(p, "base")?;
    let repository = field(p, "repository")?;
    for value in [assignment, base, repository] {
        identifier(value)?;
    }
    let model = optional(p, "model")?;
    let effort = optional(p, "effort")?;
    let login = optional(p, "login")?;
    let deadline = p
        .get("deadlineAt")
        .and_then(Value::as_u64)
        .ok_or_else(|| Error::invalid("Missing integer deadlineAt"))?;
    // Nothing collects an earlier run of this assignment now, and it may still be running.
    tx.execute(
        "UPDATE remote_run SET state='unstopped' WHERE assignment_id=?1 AND state='out'",
        [assignment],
    )
    .map_err(Error::internal)?;
    tx.execute(
        "INSERT INTO remote_run(assignment_id,kind,branch,base,repository,handle,model,effort,login,state,started_at,deadline_at)
         VALUES (?1,?2,'',?3,?4,'',?5,?6,?7,'out',?8,?9)",
        params![assignment, kind, base, repository, model, effort, login, now, deadline],
    )
    .map_err(Error::internal)?;
    let id = tx.last_insert_rowid();
    // Its own branch: a late push by an earlier run can never read as this run's work.
    let slug: String = assignment
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || "._-".contains(c) {
                c
            } else {
                '-'
            }
        })
        .collect();
    tx.execute(
        "UPDATE remote_run SET branch=?2 WHERE id=?1",
        params![id, format!("coordinator/{slug}-{id}")],
    )
    .map_err(Error::internal)?;
    let mut created = rows(tx, "SELECT * FROM remote_run WHERE id=?1", [id])?;
    Ok(json!({ "run": created.pop() }))
}

/// The cloud accepted the run reserved as `id`; its handle is stored once.
fn handle(tx: &Transaction<'_>, p: &Value) -> Result<Value> {
    let id = p
        .get("id")
        .and_then(Value::as_i64)
        .ok_or_else(|| Error::invalid("Missing integer id"))?;
    // A session URL's query or fragment may carry a token; it is never stored.
    let handle = field(p, "handle")?
        .split(['?', '#'])
        .next()
        .unwrap_or_default();
    identifier(handle)?;
    let changed = tx
        .execute(
            "UPDATE remote_run SET handle=?2 WHERE id=?1 AND state='out' AND handle=''",
            params![id, handle],
        )
        .map_err(Error::internal)?;
    if changed == 0 {
        return Err(Error::conflict(
            "The cloud run is no longer waiting for its handle",
        ));
    }
    let mut updated = rows(tx, "SELECT * FROM remote_run WHERE id=?1", [id])?;
    Ok(json!({ "run": updated.pop() }))
}

// Claude Code cloud pushes its branch as it works: no movement for this long means stalled.
const STALL_MS: u64 = 3 * 3_600_000;

/// Records the head seen on a pushing run's branch. It is `ready` only once its provider says
/// the session ended (`ended`) with a head pushed: a pause after a push is not an end. A run
/// whose head has not moved for `stallMs` since submit or its last commit is lost (its branch
/// stays held, it may still push); a later commit revives it, and a lost run with a head is
/// `ready` once its provider says it ended. A commit after collection is
/// recorded as `late`. Returns `moved`, `waiting`, `ready`, `stalled`, `revived` or `late`.
fn progress(tx: &Transaction<'_>, p: &Value, now: u64) -> Result<Value> {
    let assignment = field(p, "assignmentId")?;
    let head = field(p, "head")?;
    let stall = p.get("stallMs").and_then(Value::as_u64).unwrap_or(STALL_MS);
    let ended = p.get("ended").and_then(Value::as_bool) == Some(true);
    let found = rows(
        tx,
        "SELECT * FROM remote_run WHERE assignment_id=?1 AND kind='claude-cloud'
         AND state IN ('out','lost','collected') AND handle<>'' ORDER BY id DESC LIMIT 1",
        [assignment],
    )?;
    let Some(item) = found.into_iter().next() else {
        return Err(Error::not_found("No pushing cloud run is out or lost"));
    };
    let mut outcome = "waiting";
    if item.state == "collected" {
        // Never lost silently: a commit after collection is kept on the run for the owner.
        if !head.is_empty() && item.branch_head.as_deref() != Some(head) {
            identifier(head)?;
            tx.execute(
                "UPDATE remote_run SET branch_head=?2,moved_at=?3 WHERE id=?1",
                params![item.id, head, now],
            )
            .map_err(Error::internal)?;
            outcome = "late";
        }
    } else if !head.is_empty() && item.branch_head.as_deref() != Some(head) {
        identifier(head)?;
        let other_out: u64 = tx
            .query_row(
                "SELECT COUNT(*) FROM remote_run WHERE assignment_id=?1 AND state='out' AND id<>?2",
                params![assignment, item.id],
                |r| r.get(0),
            )
            .map_err(Error::internal)?;
        let revive = item.state == "lost" && other_out == 0;
        tx.execute(
            "UPDATE remote_run SET branch_head=?2,moved_at=?3,deadline_at=?4,
             state=CASE WHEN ?5 THEN 'out' ELSE state END,ended_at=CASE WHEN ?5 THEN NULL ELSE ended_at END
             WHERE id=?1",
            params![item.id, head, now, now.saturating_add(stall), revive],
        )
        .map_err(Error::internal)?;
        outcome = if revive { "revived" } else { "moved" };
    } else if item.state == "lost"
        && item.branch_head.is_some()
        && ended
        // A run another has replaced stays lost: only the one still out may finish the work.
        && tx
            .query_row(
                "SELECT COUNT(*) FROM remote_run WHERE assignment_id=?1 AND state='out' AND id<>?2",
                params![assignment, item.id],
                |r| r.get::<_, u64>(0),
            )
            .map_err(Error::internal)?
            == 0
    {
        // Lost only because its end could not be read: once a readable answer says it ended, its
        // pushed head is the result, as if it had never been lost.
        tx.execute(
            "UPDATE remote_run SET state='out',ended_at=NULL WHERE id=?1",
            [item.id],
        )
        .map_err(Error::internal)?;
        outcome = "ready";
    } else if item.state == "out" {
        let since = item.moved_at.unwrap_or(item.started_at);
        if item.branch_head.is_some() && ended {
            outcome = "ready";
        } else if now.saturating_sub(since) >= stall {
            tx.execute(
                "UPDATE remote_run SET state='lost',ended_at=?2 WHERE id=?1",
                params![item.id, now],
            )
            .map_err(Error::internal)?;
            outcome = "stalled";
        }
    }
    let mut updated = rows(tx, "SELECT * FROM remote_run WHERE id=?1", [item.id])?;
    Ok(json!({ "run": updated.pop(), "progress": outcome }))
}

fn close(tx: &Transaction<'_>, p: &Value, now: u64) -> Result<Value> {
    let state = field(p, "state")?;
    if !matches!(state, "collected" | "abandoned" | "lost") {
        return Err(Error::invalid("state must be collected, abandoned or lost"));
    }
    let head = optional(p, "head")?;
    let changed = tx
        .execute(
            "UPDATE remote_run SET state=?2,ended_at=?3,head=COALESCE(?4,head)
             WHERE assignment_id=?1 AND state='out'",
            params![field(p, "assignmentId")?, state, now, head],
        )
        .map_err(Error::internal)?;
    Ok(json!({ "closed": changed > 0 }))
}

/// Adds the time an out run has been due; `lost` once it reaches the bound. The caller
/// declares it lost only if its cloud still answers that it is running.
fn wait(tx: &Transaction<'_>, p: &Value) -> Result<Value> {
    let assignment = field(p, "assignmentId")?;
    let step = p.get("stepMs").and_then(Value::as_u64).unwrap_or(0);
    let bound = p
        .get("boundMs")
        .and_then(Value::as_u64)
        .ok_or_else(|| Error::invalid("Missing integer boundMs"))?;
    if step > 0 && step <= STEP_CAP_MS {
        tx.execute(
            "UPDATE remote_run SET due_waited_ms=due_waited_ms+?2 WHERE assignment_id=?1 AND state='out'",
            params![assignment, step],
        )
        .map_err(Error::internal)?;
    }
    let waited: Option<u64> = tx
        .query_row(
            "SELECT due_waited_ms FROM remote_run WHERE assignment_id=?1 AND state='out'",
            [assignment],
            |r| r.get(0),
        )
        .optional()
        .map_err(Error::internal)?;
    let waited = waited.unwrap_or(0);
    Ok(json!({ "waitedMs": waited, "lost": bound > 0 && waited >= bound }))
}

fn with_why(tx: &Transaction<'_>, runs: Vec<Run>) -> Result<Vec<Value>> {
    runs.into_iter()
        .map(|item| {
            let label = label(tx, &item)?;
            let why = if item.state == "collected" {
                "commits reached its branch after its result was collected"
            } else {
                unstoppable(&item.kind)
            };
            let mut value = serde_json::to_value(item).map_err(Error::internal)?;
            value["why"] = json!(why);
            value["label"] = json!(label);
            Ok(value)
        })
        .collect()
}

/// The assignment was cancelled while its run was out: nothing collects it and nothing can stop it.
fn release(tx: &Transaction<'_>, p: &Value) -> Result<Value> {
    let assignment = field(p, "assignmentId")?;
    let held = rows(
        tx,
        "SELECT * FROM remote_run WHERE assignment_id=?1 AND state='out'",
        [assignment],
    )?;
    tx.execute(
        "UPDATE remote_run SET state='unstopped' WHERE assignment_id=?1 AND state='out'",
        [assignment],
    )
    .map_err(Error::internal)?;
    let held = held
        .into_iter()
        .map(|item| Run {
            state: "unstopped".into(),
            ..item
        })
        .collect();
    Ok(json!({ "items": with_why(tx, held)? }))
}

/// Runs that may still be running, and collected ones whose branch moved on after; `recent`
/// names the collected pushing runs worth looking at again for late commits.
pub(crate) fn unresolved(tx: &Transaction<'_>, now: u64) -> Result<Value> {
    let found = rows(
        tx,
        &format!(
            "SELECT * FROM remote_run WHERE state IN {UNRESOLVED} OR (state='collected'
             AND branch_head IS NOT NULL AND head IS NOT NULL AND branch_head<>head)
             ORDER BY started_at,id"
        ),
        [],
    )?;
    let recent: Vec<String> = rows(
        tx,
        "SELECT * FROM remote_run WHERE kind='claude-cloud' AND state='collected' AND ended_at>=?1",
        [now.saturating_sub(STALL_MS)],
    )?
    .into_iter()
    .map(|item| item.assignment_id)
    .collect();
    Ok(json!({ "items": with_why(tx, found)?, "recent": recent }))
}

/// The last run of each assignment `assignments` (a query of ids) selects.
pub(crate) fn latest(tx: &Transaction<'_>, assignments: &str) -> Result<Vec<Run>> {
    rows(
        tx,
        &format!(
            "SELECT * FROM remote_run WHERE id IN (SELECT MAX(id) FROM remote_run
             WHERE assignment_id IN ({assignments}) GROUP BY assignment_id) ORDER BY started_at,id"
        ),
        [],
    )
}

fn shared(tx: &Transaction<'_>, assignment: &str) -> Result<u64> {
    tx.query_row(
        &format!("SELECT COUNT(*) FROM remote_run WHERE assignment_id=?1 AND state IN {MAY_PUSH}"),
        [assignment],
        |r| r.get(0),
    )
    .map_err(Error::internal)
}

/// How the owner names a run: its assignment, with `~id` when another run that may still be
/// running shares it, so each name settles exactly one run.
fn label(tx: &Transaction<'_>, item: &Run) -> Result<String> {
    Ok(if shared(tx, &item.assignment_id)? > 1 {
        format!("{}~{}", item.assignment_id, item.id)
    } else {
        item.assignment_id.clone()
    })
}

/// The owner checked the provider and a lost or unstopped run has ended.
fn ended(tx: &Transaction<'_>, p: &Value, now: u64) -> Result<Value> {
    // Only the owner has checked the cloud; nothing a model can shape ends a run.
    crate::user(p)?;
    let assignment = field(p, "assignmentId")?;
    let id = p.get("id").and_then(Value::as_i64);
    if id.is_none() && shared(tx, assignment)? > 1 {
        return Ok(json!({ "ended": false }));
    }
    let changed = tx
        .execute(
            // A collected run that pushed later kept working; its result and end stay as collected.
            &format!(
                "UPDATE remote_run SET state='ended',ended_at=COALESCE(ended_at,?2)
                 WHERE assignment_id=?1 AND (?3 IS NULL OR id=?3) AND (state IN {UNRESOLVED}
                 OR (state='collected' AND branch_head IS NOT NULL AND head IS NOT NULL AND branch_head<>head))"
            ),
            params![assignment, now, id],
        )
        .map_err(Error::internal)?;
    Ok(json!({ "ended": changed > 0 }))
}

#[cfg(test)]
mod tests {
    use crate::Supervisor;
    use serde_json::{Value, json};
    use std::path::Path;

    const HOUR: u64 = 3_600_000;

    fn call(supervisor: &mut Supervisor, method: &str, params: Value) -> Value {
        supervisor
            .call_at(method, params, 1_000)
            .unwrap_or_else(|error| panic!("{method}: {error}"))
    }

    fn reserve(supervisor: &mut Supervisor, assignment: &str, kind: &str) -> Value {
        call(
            supervisor,
            "remote.reserve",
            json!({"assignmentId":assignment,"kind":kind,"base":"b".repeat(40),"repository":"/repo",
                   "model":"opus","effort":"high","deadlineAt":1_000 + HOUR}),
        )["run"]
            .clone()
    }

    fn out(supervisor: &mut Supervisor, assignment: &str, kind: &str, handle: &str) -> Value {
        let run = reserve(supervisor, assignment, kind);
        call(
            supervisor,
            "remote.handle",
            json!({"id":run["id"],"handle":handle}),
        )["run"]
            .clone()
    }

    fn state(supervisor: &mut Supervisor, assignment: &str) -> Value {
        call(supervisor, "remote.get", json!({"assignmentId":assignment}))["run"]["state"].clone()
    }

    fn open() -> Supervisor {
        Supervisor::open(Path::new(":memory:")).unwrap()
    }

    #[test]
    fn a_cancelled_run_stays_listed_as_running_until_the_owner_confirms_it_ended() {
        let mut s = open();
        out(
            &mut s,
            "a1",
            "claude-cloud",
            "https://claude.ai/code/session_x",
        );
        let released = call(&mut s, "remote.release", json!({"assignmentId":"a1"}));
        assert_eq!(released["items"][0]["state"], "unstopped");
        assert_eq!(
            released["items"][0]["why"],
            "Claude cloud sessions have no stop command in the Claude CLI"
        );
        assert_eq!(state(&mut s, "a1"), "unstopped");
        let listed = call(&mut s, "remote.unresolved", json!({}));
        assert_eq!(listed["items"].as_array().unwrap().len(), 1);
        assert_eq!(listed["items"][0]["label"], "a1");
        assert_eq!(
            call(&mut s, "board.view", json!({}))["unresolved"],
            listed["items"]
        );
        assert_eq!(
            call(
                &mut s,
                "remote.ended",
                json!({"assignmentId":"a1","actor":"user"})
            )["ended"],
            true
        );
        assert_eq!(state(&mut s, "a1"), "ended");
        assert_eq!(
            call(&mut s, "remote.unresolved", json!({}))["items"],
            json!([])
        );
        assert_eq!(
            call(&mut s, "board.view", json!({}))["unresolved"],
            json!([])
        );
    }

    #[test]
    fn the_board_shows_only_the_last_run_of_each_assignment_it_asks_for() {
        let mut s = open();
        reserve(&mut s, "a1", "codex-cloud");
        let last = reserve(&mut s, "a1", "codex-cloud");
        reserve(&mut s, "a2", "claude-cloud");
        let tx = s.connection.transaction().unwrap();
        let runs = super::latest(&tx, "SELECT 'a1'").unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(json!(runs[0].id), last["id"]);
    }

    #[test]
    fn a_session_url_is_stored_without_its_query_or_fragment() {
        let mut s = open();
        for (assignment, url) in [
            (
                "a1",
                "https://claude.ai/code/session_x?from=cli&token=secret",
            ),
            ("a2", "https://claude.ai/code/session_x#token=secret"),
        ] {
            let run = out(&mut s, assignment, "claude-cloud", url);
            assert_eq!(run["handle"], "https://claude.ai/code/session_x");
        }
    }

    #[test]
    fn a_run_is_reserved_before_its_cloud_is_called_and_its_handle_is_set_once() {
        let mut s = open();
        let run = reserve(&mut s, "a1", "codex-cloud");
        assert_eq!(
            (run["state"].clone(), run["handle"].clone()),
            (json!("out"), json!(""))
        );
        call(
            &mut s,
            "remote.handle",
            json!({"id":run["id"],"handle":"task_a"}),
        );
        let again = s.call_at(
            "remote.handle",
            json!({"id":run["id"],"handle":"task_b"}),
            1_000,
        );
        assert_eq!(again.unwrap_err().code, -32009);
    }

    #[test]
    fn every_run_has_its_own_branch_and_an_earlier_out_run_stays_listed_as_running() {
        let mut s = open();
        let first = out(&mut s, "a/1", "codex-cloud", "task_old");
        let second = out(&mut s, "a/1", "codex-cloud", "task_new");
        assert_eq!(first["branch"], format!("coordinator/a-1-{}", first["id"]));
        assert_eq!(
            second["branch"],
            format!("coordinator/a-1-{}", second["id"])
        );
        assert_eq!(state(&mut s, "a/1"), "out");
        let listed = call(&mut s, "remote.unresolved", json!({}));
        assert_eq!(listed["items"][0]["handle"], "task_old");
        assert_eq!(listed["items"][0]["state"], "unstopped");
    }

    #[test]
    fn two_runs_that_may_still_run_are_each_named_and_settled_by_id() {
        let mut s = open();
        let first = out(&mut s, "a1", "codex-cloud", "task_a");
        call(&mut s, "remote.release", json!({"assignmentId":"a1"}));
        let second = out(&mut s, "a1", "codex-cloud", "task_b");
        call(
            &mut s,
            "remote.close",
            json!({"assignmentId":"a1","state":"lost"}),
        );
        let labels: Vec<Value> = call(&mut s, "remote.unresolved", json!({}))["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["label"].clone())
            .collect();
        assert_eq!(
            labels,
            [
                json!(format!("a1~{}", first["id"])),
                json!(format!("a1~{}", second["id"]))
            ]
        );
        assert!(
            s.call_at(
                "remote.ended",
                json!({"assignmentId":"a1","id":second["id"],"actor":"coordinator"}),
                1_000
            )
            .is_err()
        );
        assert_eq!(
            call(
                &mut s,
                "remote.ended",
                json!({"assignmentId":"a1","actor":"user"})
            )["ended"],
            false
        );
        assert_eq!(
            call(
                &mut s,
                "remote.ended",
                json!({"assignmentId":"a1","id":second["id"],"actor":"user"})
            )["ended"],
            true
        );
        let left = call(&mut s, "remote.unresolved", json!({}));
        assert_eq!(left["items"][0]["label"], "a1");
        assert_eq!(left["items"][0]["state"], "unstopped");
    }

    #[test]
    fn a_due_run_is_lost_only_after_the_bound_and_a_long_gap_counts_nothing() {
        let mut s = open();
        out(&mut s, "a1", "codex-cloud", "task_a");
        let wait = |s: &mut Supervisor, step: u64| {
            call(
                s,
                "remote.wait",
                json!({"assignmentId":"a1","stepMs":step,"boundMs":900_000}),
            )
        };
        assert_eq!(wait(&mut s, 500_000)["lost"], false);
        assert_eq!(wait(&mut s, 5 * HOUR)["waitedMs"], 500_000);
        assert_eq!(wait(&mut s, 400_000)["lost"], true);
        call(
            &mut s,
            "remote.close",
            json!({"assignmentId":"a1","state":"lost"}),
        );
        let listed = call(&mut s, "remote.unresolved", json!({}));
        assert_eq!(listed["items"][0]["state"], "lost");
        assert_eq!(
            listed["items"][0]["why"],
            "no Codex cloud stop or archive command is known"
        );
    }

    #[test]
    fn only_an_out_run_is_closed_and_collection_keeps_its_head() {
        let mut s = open();
        out(&mut s, "a1", "codex-cloud", "task_a");
        let collected = call(
            &mut s,
            "remote.close",
            json!({"assignmentId":"a1","state":"collected","head":"c".repeat(40)}),
        );
        assert_eq!(collected["closed"], true);
        let again = call(
            &mut s,
            "remote.close",
            json!({"assignmentId":"a1","state":"lost"}),
        );
        assert_eq!(again["closed"], false);
        let run = call(&mut s, "remote.get", json!({"assignmentId":"a1"}))["run"].clone();
        assert_eq!(
            (run["state"].clone(), run["head"].clone()),
            (json!("collected"), json!("c".repeat(40)))
        );
        assert!(
            s.call_at(
                "remote.close",
                json!({"assignmentId":"a1","state":"ended"}),
                1
            )
            .is_err()
        );
        assert!(
            s.call_at(
                "remote.reserve",
                json!({"assignmentId":"a2","kind":"relay","base":"b","repository":"/r","deadlineAt":1}),
                1
            )
            .is_err()
        );
    }

    #[test]
    fn a_run_reserved_before_a_restart_is_found_after_it() {
        let dir = std::env::temp_dir().join(format!("remote-run-{}", std::process::id()));
        let path = dir.join("store.sqlite");
        let _ = std::fs::remove_dir_all(&dir);
        {
            let mut s = Supervisor::open(&path).unwrap();
            reserve(&mut s, "a1", "claude-cloud");
        }
        let mut s = Supervisor::open(&path).unwrap();
        let run = call(&mut s, "remote.get", json!({"assignmentId":"a1"}))["run"].clone();
        assert_eq!(
            (run["state"].clone(), run["handle"].clone()),
            (json!("out"), json!(""))
        );
        assert_eq!(run["model"], "opus");
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn progress(s: &mut Supervisor, head: &str, now: u64) -> Value {
        s.call_at(
            "remote.progress",
            json!({"assignmentId":"a1","head":head}),
            now,
        )
        .unwrap()
    }

    #[test]
    fn a_moving_head_is_recorded_and_is_the_result_only_once_its_session_ended() {
        let mut s = open();
        out(
            &mut s,
            "a1",
            "claude-cloud",
            "https://claude.ai/code/session_x",
        );
        assert_eq!(progress(&mut s, "", 2_000)["progress"], "waiting");
        let moved = progress(&mut s, "c1", 60_000);
        assert_eq!(moved["progress"], "moved");
        assert_eq!(
            (
                moved["run"]["branchHead"].clone(),
                moved["run"]["movedAt"].clone()
            ),
            (json!("c1"), json!(60_000))
        );
        assert_eq!(progress(&mut s, "c2", 120_000)["run"]["movedAt"], 120_000);
        // A pause after a push is not an end, however long, short of the stall.
        assert_eq!(
            progress(&mut s, "c2", 120_000 + 3 * HOUR - 1)["progress"],
            "waiting"
        );
        let ended = |s: &mut Supervisor, ended: bool, now: u64| {
            s.call_at(
                "remote.progress",
                json!({"assignmentId":"a1","head":"c2","ended":ended}),
                now,
            )
            .unwrap()["progress"]
                .clone()
        };
        assert_eq!(ended(&mut s, false, 120_001), "waiting");
        assert_eq!(ended(&mut s, true, 120_001), "ready");
    }

    #[test]
    fn a_head_that_never_moves_past_the_limit_stalls_and_a_later_commit_revives_it() {
        let mut s = open();
        out(
            &mut s,
            "a1",
            "claude-cloud",
            "https://claude.ai/code/session_x",
        );
        assert_eq!(
            progress(&mut s, "", 1_000 + 3 * HOUR - 1)["progress"],
            "waiting"
        );
        let stalled = progress(&mut s, "", 1_000 + 3 * HOUR);
        assert_eq!(stalled["progress"], "stalled");
        assert_eq!(state(&mut s, "a1"), "lost");
        let listed = call(&mut s, "remote.unresolved", json!({}));
        assert_eq!(listed["items"][0]["branch"], stalled["run"]["branch"]);
        let revived = progress(&mut s, "c1", 4 * HOUR);
        assert_eq!(revived["progress"], "revived");
        assert_eq!(state(&mut s, "a1"), "out");
        assert_eq!(revived["run"]["deadlineAt"], 7 * HOUR);
        let custom = s
            .call_at(
                "remote.progress",
                json!({"assignmentId":"a1","head":"c1","stallMs":1_000}),
                4 * HOUR + 1_000,
            )
            .unwrap();
        assert_eq!(custom["progress"], "stalled");
        // Stalled with a head because its end could not be read: a readable end takes the head.
        let ended = s
            .call_at(
                "remote.progress",
                json!({"assignmentId":"a1","head":"c1","ended":true}),
                5 * HOUR,
            )
            .unwrap();
        assert_eq!(ended["progress"], "ready");
        assert_eq!(state(&mut s, "a1"), "out");
    }

    #[test]
    fn a_lost_run_another_replaced_is_not_taken_when_it_reads_as_ended() {
        let mut s = open();
        out(
            &mut s,
            "a1",
            "claude-cloud",
            "https://claude.ai/code/session_x",
        );
        progress(&mut s, "c1", 1_000);
        assert_eq!(
            progress(&mut s, "c1", 1_000 + 3 * HOUR)["progress"],
            "stalled"
        );
        // Its replacement is out, its handle not yet recorded.
        let replacement = reserve(&mut s, "a1", "claude-cloud");
        let ended = s
            .call_at(
                "remote.progress",
                json!({"assignmentId":"a1","head":"c1","ended":true}),
                4 * HOUR,
            )
            .unwrap();
        assert_eq!(ended["progress"], "waiting");
        assert_eq!(ended["run"]["state"], "lost");
        assert_eq!(state(&mut s, "a1"), replacement["state"]);
    }

    #[test]
    fn a_commit_after_collection_is_kept_on_the_run_and_listed_for_the_owner() {
        let mut s = open();
        out(
            &mut s,
            "a1",
            "claude-cloud",
            "https://claude.ai/code/session_x",
        );
        progress(&mut s, "c1", 2_000);
        call(
            &mut s,
            "remote.close",
            json!({"assignmentId":"a1","state":"collected","head":"c1"}),
        );
        let listed = s.call_at("remote.unresolved", json!({}), 3_000).unwrap();
        assert_eq!(
            (listed["items"].clone(), listed["recent"].clone()),
            (json!([]), json!(["a1"]))
        );
        let late = progress(&mut s, "c2", 4_000);
        assert_eq!(late["progress"], "late");
        assert_eq!(late["run"]["state"], "collected");
        assert_eq!(
            (
                late["run"]["head"].clone(),
                late["run"]["branchHead"].clone()
            ),
            (json!("c1"), json!("c2"))
        );
        let listed = s.call_at("remote.unresolved", json!({}), 5_000).unwrap();
        assert_eq!(
            listed["items"][0]["why"],
            "commits reached its branch after its result was collected"
        );
        let later = s.call_at("remote.unresolved", json!({}), 4 * HOUR).unwrap();
        assert_eq!(later["recent"], json!([]));
        // The owner says it has ended: it leaves the list and keeps the result it gave.
        assert_eq!(
            call(
                &mut s,
                "remote.ended",
                json!({"assignmentId":"a1","actor":"user"})
            )["ended"],
            true
        );
        assert_eq!(
            call(&mut s, "remote.unresolved", json!({}))["items"],
            json!([])
        );
        assert_eq!(
            call(&mut s, "remote.get", json!({"assignmentId":"a1"}))["run"]["head"],
            "c1"
        );
    }

    #[test]
    fn a_store_made_before_logins_were_recorded_gains_the_column() {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE remote_run (id INTEGER PRIMARY KEY AUTOINCREMENT, assignment_id TEXT NOT NULL,
                 kind TEXT NOT NULL, branch TEXT NOT NULL, base TEXT NOT NULL, repository TEXT NOT NULL,
                 handle TEXT NOT NULL, model TEXT, effort TEXT, head TEXT, state TEXT NOT NULL,
                 started_at INTEGER NOT NULL, deadline_at INTEGER NOT NULL, ended_at INTEGER,
                 due_waited_ms INTEGER NOT NULL DEFAULT 0);",
            )
            .unwrap();
        let mut connection = connection;
        let tx = connection.transaction().unwrap();
        super::migrate(&tx).unwrap();
        super::migrate(&tx).unwrap();
        let columns: u32 = tx
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('remote_run')
                 WHERE name IN ('login','branch_head','moved_at')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(columns, 3);
    }
}
