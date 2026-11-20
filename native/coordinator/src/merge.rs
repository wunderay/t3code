//! A goal whose review passed and whose author changed something waits in `merging` until its
//! change is merged; only then is it completed, its threads settled and its outcome recorded.
use crate::{Error, Result, board, field, model::*, results::git, settlement, store, text};
use rusqlite::Transaction;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
    process::Command,
};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Target {
    /// The reviewed commit; only this commit is merged.
    pub head: String,
    /// The branch the author's worktree was made from, which the change lands on.
    pub target: String,
    /// The project's checkout: merges into one repository run one at a time.
    pub repository: String,
    /// The project whose switch says whether the host merges it or the owner does.
    #[serde(default)]
    pub project_id: Option<String>,
    /// The author's branch, which its pull request is found by once its worktree is gone.
    #[serde(default)]
    pub branch: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Merge {
    pub goal_id: String,
    pub assignment_id: String,
    pub target: Target,
    /// The accepted outcome, recorded only once the change is merged.
    pub feedback: Action,
    #[serde(default)]
    pub merged: Option<Value>,
    #[serde(default)]
    pub reverted: Option<Value>,
    /// What the merge waits for, and whether that is the owner.
    #[serde(default)]
    pub waiting: Option<Value>,
    pub revision: u64,
}

fn sha(value: &str) -> bool {
    value.len() == 40 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

pub(crate) fn target(parameters: &Value) -> Result<Option<Target>> {
    let Some(value) = parameters.get("merge").filter(|value| !value.is_null()) else {
        return Ok(None);
    };
    let target: Target =
        serde_json::from_value(value.clone()).map_err(|error| Error::invalid(error.to_string()))?;
    text(&target.target, 256, "target branch")?;
    text(&target.repository, 4096, "repository")?;
    if !sha(&target.head) || !Path::new(&target.repository).is_absolute() {
        return Err(Error::invalid(
            "A merge needs the full reviewed commit and the absolute repository path",
        ));
    }
    Ok(Some(target))
}

pub(crate) fn start(
    tx: &Transaction<'_>,
    goal: &Goal,
    owner: &Assignment,
    target: Target,
    feedback: Action,
    revision: u64,
) -> Result<()> {
    let merge = Merge {
        goal_id: goal.id.clone(),
        assignment_id: owner.id.clone(),
        target,
        feedback,
        merged: None,
        reverted: None,
        waiting: None,
        revision,
    };
    store::put(tx, "merge", &goal.id, &merge, revision)
}

/// Reviewed changes waiting to merge in a project whose automatic merge the owner switched off.
/// Every reviewed change that waits on the owner, whatever for, with why and whether the owner's
/// go-ahead (`goal.merge`) is what it needs; otherwise the owner merges it on the host.
pub(crate) fn for_owner(tx: &Transaction<'_>, limit: usize) -> Result<Value> {
    let manual = crate::config(tx)?.manual_merge_projects;
    let mut items = Vec::new();
    for goal in store::every::<Goal>(tx, "goal", "json_extract(body,'$.status')='merging'")? {
        let merge: Merge = store::required(tx, "merge", &goal.id)?;
        let switched_off = merge
            .target
            .project_id
            .as_ref()
            .is_some_and(|project| manual.contains(project));
        let waiting = merge.waiting.clone().unwrap_or(Value::Null);
        if waiting["owner"] != true && !switched_off {
            continue;
        }
        let reason = waiting["reason"]
            .as_str()
            .unwrap_or("Automatic merge is off in this project.");
        let action = waiting["action"]
            .as_str()
            .or(switched_off.then_some("merge"));
        items.push(json!({"goalId":goal.id,"purpose":goal.purpose,"head":merge.target.head,"target":merge.target.target,"reason":reason,"action":action}));
    }
    items.truncate(limit);
    Ok(Value::Array(items))
}

/// The host's report that the reviewed commit is on its target branch.
pub(crate) fn merged(
    tx: &Transaction<'_>,
    parameters: &Value,
    revision: u64,
    now: u64,
) -> Result<Value> {
    let mut goal: Goal = store::required(tx, "goal", field(parameters, "id")?)?;
    let mut merge: Merge = store::required(tx, "merge", &goal.id)?;
    let head = field(parameters, "head")?;
    // Merged by hand at another head: the code is on the target, so the goal is done, but the
    // record says which head landed and that no review saw it. The host verifies only its own.
    let unreviewed = parameters.get("byHand").and_then(Value::as_bool) == Some(true)
        && head != merge.target.head;
    if !unreviewed && parameters.get("hostVerified").and_then(Value::as_bool) != Some(true) {
        return Err(Error::forbidden("Only the host reports a merge"));
    }
    if goal.status != "merging" || (!unreviewed && head != merge.target.head) {
        return Err(Error::conflict(
            "The merged commit is not the one the review passed",
        ));
    }
    if unreviewed {
        text(head, 256, "head")?;
    }
    goal.status = "completed".into();
    goal.revision = revision;
    store::put(tx, "goal", &goal.id, &goal, revision)?;
    settlement::enqueue(tx, &goal, revision, now)?;
    let mut feedback = merge.feedback.clone();
    feedback.revision = revision;
    store::put(tx, "action", &feedback.id, &feedback, revision)?;
    let mut record = json!({"at":now,"how":parameters.get("how").cloned().unwrap_or(Value::Null)});
    if unreviewed {
        record["head"] = json!(head);
        record["byHand"] = json!(true);
        record["unreviewed"] = json!(true);
    }
    merge.merged = Some(record);
    merge.waiting = None;
    merge.revision = revision;
    store::put(tx, "merge", &goal.id, &merge, revision)?;
    if unreviewed {
        let summary = format!(
            "Goal {} was merged by hand at {head}, which no review saw; the review passed {}.",
            goal.id, merge.target.head
        );
        let decision = Decision {
            id: format!("merged-unreviewed:{}", goal.id),
            summary: summary.clone(),
            provenance: "coordinator-merge".into(),
            card_ids: vec![],
            goal_ids: vec![goal.id.clone()],
            expires_at: None,
            revision,
        };
        store::put(tx, "decision", &decision.id, &decision, revision)?;
        tell(tx, &merge, "merged-unreviewed", Some(&summary), now)?;
    } else {
        tell(tx, &merge, "merged", None, now)?;
    }
    Ok(json!({"goal":goal}))
}

/// The author's pull request moved past the reviewed commit (a rebase, a fix): the goal goes back
/// to review of the new head. Its merge is dropped and the author's work counts as just finished,
/// which the Coordinator hears of and has reviewed as any finished work.
pub(crate) fn rereview(
    tx: &Transaction<'_>,
    parameters: &Value,
    revision: u64,
    now: u64,
) -> Result<Value> {
    if parameters.get("hostVerified").and_then(Value::as_bool) != Some(true) {
        return Err(Error::forbidden(
            "Only the host sends a change back to review",
        ));
    }
    let mut goal: Goal = store::required(tx, "goal", field(parameters, "id")?)?;
    let merge: Merge = store::required(tx, "merge", &goal.id)?;
    if goal.status != "merging" || merge.merged.is_some() {
        return Err(Error::conflict(
            "Only a change waiting to merge goes back to review",
        ));
    }
    let run = field(parameters, "latestRunId")?;
    crate::identifier(run)?;
    let mut owner: Assignment = store::required(tx, "assignment", &merge.assignment_id)?;
    owner.status = "completed".into();
    let mut receipt = owner.receipt.take().unwrap_or_else(|| json!({}));
    receipt["latestRunId"] = json!(run);
    // A cloud author's head is its run's branch head: the next review and merge are of it.
    if let Some(head) = parameters.get("head").and_then(Value::as_str) {
        if !sha(head) {
            return Err(Error::invalid("head must be a full commit id"));
        }
        receipt["head"] = json!(head);
    }
    owner.receipt = Some(receipt);
    owner.revision = revision;
    crate::events::put_assignment(tx, &owner, revision, &json!({}), now)?;
    goal.status = "active".into();
    goal.verified = false;
    goal.revision = revision;
    store::put(tx, "goal", &goal.id, &goal, revision)?;
    store::remove(tx, "merge", &goal.id, revision)?;
    store::remove(tx, "goalResolution", &goal.id, revision)?;
    Ok(json!({"goal":goal}))
}

/// Tells the Coordinator of a merge, under the author's thread so the event goes once it settled.
fn tell(
    tx: &Transaction<'_>,
    merge: &Merge,
    status: &str,
    summary: Option<&str>,
    now: u64,
) -> Result<()> {
    let thread = store::get::<Assignment>(tx, "assignment", &merge.assignment_id)?
        .and_then(|owner| {
            store::get::<Card>(tx, "card", &owner.card_id)
                .ok()
                .flatten()
        })
        .map(|card| card.thread_id);
    let mut event =
        json!({"kind":"merge","subject":merge.goal_id,"status":status,"threadId":thread});
    if let Some(summary) = summary {
        event["summary"] = json!(summary.chars().take(500).collect::<String>());
    }
    crate::events::record(tx, "host", event, now)?;
    Ok(())
}

/// What a merge waits for, and whether that is the owner; the Coordinator hears of each change.
pub(crate) fn wait(
    tx: &Transaction<'_>,
    parameters: &Value,
    revision: u64,
    now: u64,
) -> Result<Value> {
    let mut merge: Merge = store::required(tx, "merge", field(parameters, "id")?)?;
    let reason = field(parameters, "reason")?;
    text(reason, 1000, "reason")?;
    let owner = parameters.get("owner").and_then(Value::as_bool) == Some(true);
    let mut waiting = json!({"reason":reason,"owner":owner});
    // What the owner's go-ahead does: `merge` when the host merges it on their word.
    if let Some(action) = parameters.get("action").and_then(Value::as_str) {
        if action != "merge" {
            return Err(Error::invalid("action must be merge"));
        }
        waiting["action"] = json!(action);
    }
    if merge.merged.is_some() || merge.waiting.as_ref() == Some(&waiting) {
        return Ok(json!({"merge":merge}));
    }
    merge.waiting = Some(waiting);
    merge.revision = revision;
    store::put(tx, "merge", &merge.goal_id, &merge, revision)?;
    tell(
        tx,
        &merge,
        if owner { "owner" } else { "waiting" },
        Some(reason),
        now,
    )?;
    Ok(json!({"merge":merge}))
}

/// Goals waiting to merge, in the board's order: what unblocks others first, then first accepted.
pub(crate) fn list(tx: &Transaction<'_>) -> Result<Value> {
    let mut goals: BTreeMap<String, Goal> = store::every::<Goal>(
        tx,
        "goal",
        "json_extract(body,'$.status') IN ('active','blocked','merging')",
    )?
    .into_iter()
    .map(|goal| (goal.id.clone(), goal))
    .collect();
    let wanted: Vec<String> = goals
        .values()
        .flat_map(|goal| goal.dependencies.clone())
        .filter(|id| !goals.contains_key(id))
        .collect();
    for id in wanted {
        if let Some(goal) = store::get::<Goal>(tx, "goal", &id)? {
            goals.insert(id, goal);
        }
    }
    let goals: Vec<Goal> = goals.into_values().collect();
    let classes = board::classes(&goals);
    let mut items = Vec::new();
    for goal in goals.iter().filter(|goal| goal.status == "merging") {
        let merge: Merge = store::required(tx, "merge", &goal.id)?;
        items.push((classes.get(goal.id.as_str()).copied(), merge));
    }
    items.sort_by_key(|(class, merge)| (*class, merge.revision));
    Ok(json!({"items":items.into_iter().map(|(_, merge)| merge).collect::<Vec<_>>()}))
}

/// What reverting a goal takes back, newest first: its merged change and every merged change
/// built on it.
pub(crate) fn reverts(tx: &Transaction<'_>, parameters: &Value) -> Result<Value> {
    crate::user(parameters)?;
    let mut merges: Vec<Merge> = store::every(
        tx,
        "merge",
        "json_extract(body,'$.merged') IS NOT NULL AND json_extract(body,'$.reverted') IS NULL",
    )?;
    // Built on it through any goal, one that changed nothing and so never merged included.
    let goals: Vec<Goal> = store::every(tx, "goal", "1")?;
    let mut taken = BTreeSet::from([field(parameters, "id")?.to_owned()]);
    loop {
        let before = taken.len();
        for goal in &goals {
            if goal.dependencies.iter().any(|id| taken.contains(id)) {
                taken.insert(goal.id.clone());
            }
        }
        if taken.len() == before {
            break;
        }
    }
    merges.retain(|merge| taken.contains(&merge.goal_id));
    merges.sort_by_key(|merge| std::cmp::Reverse(merge.revision));
    Ok(json!({"items":merges}))
}

/// The host's report that a merged change was taken back.
pub(crate) fn reverted(
    tx: &Transaction<'_>,
    parameters: &Value,
    revision: u64,
    now: u64,
) -> Result<Value> {
    if parameters.get("hostVerified").and_then(Value::as_bool) != Some(true) {
        return Err(Error::forbidden("Only the host reports a revert"));
    }
    let mut merge: Merge = store::required(tx, "merge", field(parameters, "id")?)?;
    if merge.merged.is_none() || merge.reverted.is_some() {
        return Err(Error::conflict(
            "Only a merged change not yet reverted can be",
        ));
    }
    merge.reverted =
        Some(json!({"at":now,"how":parameters.get("how").cloned().unwrap_or(Value::Null)}));
    merge.revision = revision;
    store::put(tx, "merge", &merge.goal_id, &merge, revision)?;
    tell(tx, &merge, "reverted", None, now)?;
    Ok(json!({"merge":merge}))
}

fn exit_code(repository: &str, arguments: &[&str]) -> Result<(i32, String)> {
    let output = Command::new("git")
        .args(crate::results::HARDENED)
        .arg("-C")
        .arg(repository)
        .args(arguments)
        .output()
        .map_err(Error::internal)?;
    Ok((
        output.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&output.stdout).into_owned(),
    ))
}

/// Whether the reviewed commit is in any of these commits or refs: a merged pull request at
/// another head is this work only if it holds it. A commit this checkout lacks holds nothing.
pub(crate) fn contains(parameters: &Value) -> Result<Value> {
    let repository = field(parameters, "repository")?;
    text(repository, 4096, "repository")?;
    let head = field(parameters, "head")?;
    if !sha(head) || !Path::new(repository).is_absolute() {
        return Err(Error::invalid(
            "contains needs a full commit and an absolute repository",
        ));
    }
    let tips: Vec<String> = crate::decode(parameters, "tips")?;
    for tip in &tips {
        text(tip, 256, "tip")?;
        if tip.starts_with('-') {
            return Err(Error::invalid("A tip is a commit or a ref"));
        }
        if exit_code(repository, &["merge-base", "--is-ancestor", head, tip])?.0 == 0 {
            return Ok(json!({"contains":true,"tip":tip}));
        }
    }
    Ok(json!({"contains":false}))
}

/// With no pull-request host, the host merges the reviewed commit into its target branch itself,
/// touching refs only: a branch checked out in some worktree is someone's working copy, so that
/// merge waits for the owner. Merged is the reviewed commit being on the target branch.
pub(crate) fn local(parameters: &Value) -> Result<Value> {
    let Some(target) = self::target(parameters)? else {
        return Err(Error::invalid("Missing merge"));
    };
    let repository = target.repository.as_str();
    let branch = format!("refs/heads/{}", target.target);
    git(repository, &["check-ref-format", &branch])?;
    let head = crate::results::commit(repository, &target.head)?;
    let tip = crate::results::commit(repository, &branch)?;
    let ancestor = |a: &str, b: &str| -> Result<bool> {
        Ok(exit_code(repository, &["merge-base", "--is-ancestor", a, b])?.0 == 0)
    };
    if ancestor(&head, &tip)? {
        return Ok(json!({"merged":true,"commit":tip}));
    }
    // Only asked whether it landed: someone else may have merged it.
    if parameters.get("detect").and_then(Value::as_bool) == Some(true) {
        return Ok(json!({"merged":false}));
    }
    let worktrees = git(repository, &["worktree", "list", "--porcelain"])?;
    if worktrees
        .lines()
        .any(|line| line.strip_prefix("branch ") == Some(branch.as_str()))
    {
        return Ok(json!({"merged":false,"owner":true,"waiting":format!(
            "{} is checked out in a working copy; merge {head} into it there and the Coordinator sees the merge",
            target.target
        )}));
    }
    let commit = if ancestor(&tip, &head)? {
        head.clone()
    } else {
        let (code, out) = exit_code(
            repository,
            &["merge-tree", "--write-tree", "--no-messages", &tip, &head],
        )?;
        if code != 0 {
            return Ok(json!({"merged":false,"waiting":format!(
                "{head} conflicts with {}; the author's thread must bring it up to date",
                target.target
            )}));
        }
        let tree = out.lines().next().unwrap_or("").trim().to_owned();
        let message = parameters
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("Merge reviewed work");
        text(message, 2000, "message")?;
        git(
            repository,
            &["commit-tree", &tree, "-p", &tip, "-p", &head, "-m", message],
        )?
        .trim()
        .to_owned()
    };
    // The old value makes this a lease: a branch that moved since it was read is left alone.
    git(repository, &["update-ref", &branch, &commit, &tip])?;
    Ok(json!({"merged":true,"commit":commit}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_waiting_and_every_merged_goal_is_read_however_many() {
        let mut connection = store::open(Path::new(":memory:")).unwrap();
        let tx = connection.transaction().unwrap();
        let count = 1_001;
        for index in 0..count {
            let id = format!("goal-{index:04}");
            let goal: Goal = serde_json::from_value(
                json!({"id":id,"purpose":"p","status":"merging","dependencies":if index == 0 { vec![] } else { vec!["goal-0000".to_owned()] }}),
            )
            .unwrap();
            store::put(&tx, "goal", &id, &goal, 1).unwrap();
            let merge: Merge = serde_json::from_value(json!({
                "goalId":id,"assignmentId":"a","target":{"head":"0".repeat(40),"target":"main","repository":"/r"},
                "feedback":{"id":"f","kind":"outcome.accepted","assignmentId":null,"threadId":null,"environmentId":null,"payload":{},"status":"held","revision":1,"createdAt":0,"pauseRevision":0,"instructionRevision":null,"grantRevision":null},
                "merged":{"at":1},"revision":index
            }))
            .unwrap();
            store::put(&tx, "merge", &id, &merge, 1).unwrap();
        }
        assert_eq!(list(&tx).unwrap()["items"].as_array().unwrap().len(), count);
        let reverts = reverts(&tx, &json!({"id":"goal-0000","actor":"user"})).unwrap();
        assert_eq!(reverts["items"].as_array().unwrap().len(), count);
    }
}
