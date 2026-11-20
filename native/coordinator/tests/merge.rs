use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};
use t3_coordinator::Supervisor;

const NOW: u64 = 1_000_000;

fn call(supervisor: &mut Supervisor, method: &str, params: Value) -> Value {
    supervisor
        .call_at(method, params, NOW)
        .unwrap_or_else(|error| panic!("{method}: {error}"))
}

fn card(id: &str) -> Value {
    json!({"id":id,"threadId":id,"environmentId":"env","projectId":"project","purpose":format!("Purpose of {id}"),"status":"running","instructionRevision":1})
}

fn ready() -> Supervisor {
    let mut supervisor = Supervisor::open(Path::new(":memory:")).unwrap();
    call(
        &mut supervisor,
        "configure",
        json!({"actor":"user","enabled":true,"restrictionVerified":true,"hostAttested":true,"coordinatorProvider":"replay","coordinatorModel":"replay"}),
    );
    call(
        &mut supervisor,
        "cards.sync",
        json!({"cards":[card("parent")]}),
    );
    let model = |id: &str| json!({"id":format!("catalog:local:{id}"),"sourceId":"provider","provider":"replay","model":id,"destination":"local","account":null,"efforts":["high"],"compatible":true,"accessible":true,"policyAllowed":true,"qualificationVerified":true,"identityVerified":true,"evidence":["qualification:exact-model-and-options"]});
    call(
        &mut supervisor,
        "catalog.sync",
        json!({"sourceId":"provider","models":[model("model"),model("review-model")]}),
    );
    supervisor
}

fn finished(supervisor: &mut Supervisor, id: &str, goal: &str, review: Option<&str>) {
    ended(supervisor, id, goal, review, "completed");
}

fn ended(supervisor: &mut Supervisor, id: &str, goal: &str, review: Option<&str>, status: &str) {
    let mut work = json!({"id":id,"idempotencyKey":format!("request:{id}"),"cardId":"parent","goalId":goal,"route":{"provider":"replay","model":"model","effort":"high","destination":"local"},"instructionRevision":1,"pauseRevision":0,"grantRevision":0,"reservation":{"id":format!("reservation:{id}"),"owner":"t3:local","expiresAt":NOW+60_000,"policyRevision":"policy-v1","sharedCapacity":true},"brief":"Build the bounded result, verify acceptance, and preserve user scope.","returnRoute":"coordinator:coordinator"});
    if let Some(model) = review {
        work["role"] = json!("reviewer");
        work["route"]["model"] = json!(model);
        work["reviewGoalDigest"] = json!("a".repeat(64));
        work["reviewSubjects"] = json!([{"assignmentId":format!("{goal}-author"),"executionId":format!("run:{goal}-author"),"digest":"b".repeat(64)}]);
    }
    let child = format!("thread:{id}");
    call(supervisor, "cards.sync", json!({"cards":[card(&child)]}));
    let snapshot = call(supervisor, "snapshot", json!({}));
    work["pauseRevision"] = snapshot["pause"]["revision"].clone();
    work["grantRevision"] = snapshot["policyRevision"].clone();
    let prepared = call(
        supervisor,
        "assignments.prepare",
        json!({"assignment":work}),
    );
    call(
        supervisor,
        "actions.claim",
        json!({"id":prepared["action"]["id"]}),
    );
    call(
        supervisor,
        "actions.ack",
        json!({"id":prepared["action"]["id"],"status":"completed","result":{"status":"running","receipt":{"threadId":child,"runId":format!("run:{id}"),"latestRunId":format!("run:{id}")},"executionId":child,"cardId":child}}),
    );
    call(
        supervisor,
        "assignments.update",
        json!({"id":id,"status":status}),
    );
}

const HEAD: &str = "0123456789abcdef0123456789abcdef01234567";

/// A goal whose author and reviewer finished; the resolution is returned unsent.
fn reviewed(supervisor: &mut Supervisor, goal: &str) -> Value {
    call(
        supervisor,
        "goals.upsert",
        json!({"goal":{"id":goal,"purpose":format!("Deliver {goal}"),"acceptanceCriteria":["It works"],"authorizedScope":["project"]}}),
    );
    finished(supervisor, &format!("{goal}-author"), goal, None);
    finished(
        supervisor,
        &format!("{goal}-review"),
        goal,
        Some("review-model"),
    );
    let mut resolution = reviewed_resolution(supervisor, goal);
    resolution["merge"] = json!({"head":HEAD,"target":"main","repository":"/repo"});
    resolution
}

fn reviewed_resolution(supervisor: &mut Supervisor, goal: &str) -> Value {
    let revision = call(supervisor, "goals.get", json!({"id":goal}))["goal"]["revision"].clone();
    let reviewer = format!("{goal}-review");
    json!({"id":goal,"expectedGoalRevision":revision,"hostVerified":true,"reviewerAssignmentId":reviewer,
        "reviewerReceipt":{"assignmentId":reviewer,"executionId":format!("run:{reviewer}"),"digest":"e".repeat(64)},
        "subjects":[{"assignmentId":format!("{goal}-author"),"executionId":format!("run:{goal}-author"),"digest":"b".repeat(64)}],
        "integrationOwner":format!("{goal}-author"),
        "evidence":[format!("review:{reviewer}:run:{reviewer}:{}", "e".repeat(64))]})
}

fn pending(supervisor: &mut Supervisor, kind: &str) -> Vec<Value> {
    call(supervisor, "actions.list", json!({"limit":100}))["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|a| a["kind"] == kind && a["status"] == "pending")
        .cloned()
        .collect()
}

#[test]
fn a_reviewed_change_is_done_only_at_its_merge() {
    let mut supervisor = ready();
    let resolution = reviewed(&mut supervisor, "feature");
    call(
        &mut supervisor,
        "goals.upsert",
        json!({"goal":{"id":"after","purpose":"Build on it","dependencies":["feature"],"authorizedScope":["project"]}}),
    );
    let goal = call(&mut supervisor, "goals.resolve", resolution)["goal"].clone();
    assert_eq!(goal["status"], "merging");
    // Nothing settles, no outcome is recorded and nothing built on it starts before the merge.
    assert!(pending(&mut supervisor, "thread.settle").is_empty());
    assert!(pending(&mut supervisor, "outcome.accepted").is_empty());
    let board = call(&mut supervisor, "board.next", json!({}));
    assert!(!board.to_string().contains("\"after\""));
    let snapshot = call(&mut supervisor, "snapshot", json!({}));
    assert!(
        snapshot["goals"]
            .as_array()
            .unwrap()
            .iter()
            .any(|goal| goal["id"] == "feature")
    );
    let queue = call(&mut supervisor, "merges.list", json!({}))["items"].clone();
    assert_eq!(queue[0]["target"]["head"], HEAD);
    assert_eq!(queue[0]["assignmentId"], "feature-author");
    // Neither the Coordinator nor its model can skip the merge.
    let mut skipped = goal.clone();
    skipped["status"] = json!("completed");
    assert!(
        supervisor
            .call_at("goals.upsert", json!({"goal":skipped}), NOW)
            .is_err()
    );
    let mut started = call(&mut supervisor, "goals.get", json!({"id":"after"}))["goal"].clone();
    started["status"] = json!("merging");
    assert!(
        supervisor
            .call_at("goals.upsert", json!({"goal":started}), NOW)
            .is_err()
    );
    for refused in [
        json!({"id":"feature","head":HEAD}),
        json!({"id":"feature","head":"f".repeat(40),"hostVerified":true}),
    ] {
        assert!(supervisor.call_at("goals.merged", refused, NOW).is_err());
    }
    let merged = call(
        &mut supervisor,
        "goals.merged",
        json!({"id":"feature","head":HEAD,"hostVerified":true,"how":{"pullRequest":7}}),
    );
    assert_eq!(merged["goal"]["status"], "completed");
    assert_eq!(pending(&mut supervisor, "outcome.accepted").len(), 1);
    assert_eq!(pending(&mut supervisor, "thread.settle").len(), 2);
    assert!(
        call(&mut supervisor, "merges.list", json!({}))["items"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert!(
        call(&mut supervisor, "board.next", json!({}))
            .to_string()
            .contains("\"after\"")
    );
    assert!(
        supervisor
            .call_at(
                "goals.merged",
                json!({"id":"feature","head":HEAD,"hostVerified":true}),
                NOW
            )
            .is_err()
    );
}

#[test]
fn work_that_changed_nothing_is_done_when_its_result_is_taken() {
    let mut supervisor = ready();
    let mut nothing_changed = reviewed(&mut supervisor, "unchanged");
    nothing_changed["merge"] = Value::Null;
    assert_eq!(
        call(&mut supervisor, "goals.resolve", nothing_changed)["goal"]["status"],
        "completed"
    );
    assert_eq!(pending(&mut supervisor, "outcome.accepted").len(), 1);
    assert_eq!(pending(&mut supervisor, "thread.settle").len(), 2);
    assert!(
        call(&mut supervisor, "merges.list", json!({}))["items"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn merges_wait_in_the_boards_order_and_a_reopened_goal_leaves_the_queue() {
    let mut supervisor = ready();
    let first = reviewed(&mut supervisor, "first");
    call(&mut supervisor, "goals.resolve", first);
    let second = reviewed(&mut supervisor, "second");
    call(&mut supervisor, "goals.resolve", second);
    call(
        &mut supervisor,
        "goals.upsert",
        json!({"goal":{"id":"waits","purpose":"Needs second","dependencies":["second"],"authorizedScope":["project"]}}),
    );
    let order = |supervisor: &mut Supervisor| -> Vec<String> {
        call(supervisor, "merges.list", json!({}))["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["goalId"].as_str().unwrap().to_owned())
            .collect()
    };
    // Accepted later, but merging it is what lets another goal start.
    assert_eq!(order(&mut supervisor), ["second", "first"]);
    let mut reopened = call(&mut supervisor, "goals.get", json!({"id":"second"}))["goal"].clone();
    reopened["status"] = json!("blocked");
    call(&mut supervisor, "goals.upsert", json!({"goal":reopened}));
    assert_eq!(order(&mut supervisor), ["first"]);
}

fn git(repository: &Path, arguments: &[&str]) -> String {
    let output = Command::new("git")
        .arg("-C")
        .arg(repository)
        .args([
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "-c",
            "commit.gpgsign=false",
        ])
        .args(arguments)
        .output()
        .unwrap();
    assert!(output.status.success(), "{arguments:?}: {output:?}");
    String::from_utf8(output.stdout).unwrap().trim().into()
}

/// A clone of a bare remote, with the author's worktree on a branch of its own.
struct Checkout(PathBuf);

impl Checkout {
    fn new(name: &str) -> Self {
        let root = std::env::temp_dir().join(format!("t3-merge-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        git(&root, &["init", "-q", "--bare", "-b", "main", "remote.git"]);
        git(&root, &["clone", "-q", "remote.git", "project"]);
        let project = root.join("project");
        git(&project, &["config", "user.name", "Test"]);
        git(&project, &["config", "user.email", "test@example.invalid"]);
        fs::write(project.join("a.txt"), "a\n").unwrap();
        git(&project, &["add", "-A"]);
        git(&project, &["commit", "-q", "-m", "base"]);
        git(&project, &["push", "-q", "origin", "main"]);
        // The person's own checkout moves to another branch, so main is checked out nowhere.
        git(&project, &["switch", "-q", "-c", "person"]);
        git(
            &project,
            &["worktree", "add", "-q", "-b", "author", "../author", "main"],
        );
        Self(root)
    }
    fn project(&self) -> PathBuf {
        self.0.join("project")
    }
    fn commit(&self, folder: &str, file: &str, body: &str) -> String {
        let folder = self.0.join(folder);
        fs::write(folder.join(file), body).unwrap();
        git(&folder, &["add", "-A"]);
        git(&folder, &["commit", "-q", "-m", "change"]);
        git(&folder, &["rev-parse", "HEAD"])
    }
}

impl Drop for Checkout {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn local(supervisor: &mut Supervisor, checkout: &Checkout, head: &str) -> Value {
    call(
        supervisor,
        "merges.local",
        json!({"merge":{"head":head,"target":"main","repository":checkout.project().to_str().unwrap()},"message":"Merge feature"}),
    )
}

#[test]
fn with_no_host_the_reviewed_commit_lands_on_its_branch_by_refs_alone() {
    let checkout = Checkout::new("fast-forward");
    let mut supervisor = ready();
    let head = checkout.commit("author", "b.txt", "b\n");
    // Asked only whether it landed, nothing moves.
    let detect = json!({"merge":{"head":head,"target":"main","repository":checkout.project().to_str().unwrap()},"detect":true});
    assert_eq!(
        call(&mut supervisor, "merges.local", detect.clone()),
        json!({"merged":false})
    );
    assert_ne!(git(&checkout.project(), &["rev-parse", "main"]), head);
    let merged = local(&mut supervisor, &checkout, &head);
    assert_eq!(merged, json!({"merged":true,"commit":head}));
    assert_eq!(
        call(&mut supervisor, "merges.local", detect)["merged"],
        true
    );
    assert_eq!(git(&checkout.project(), &["rev-parse", "main"]), head);
    // Merged is read from the repository: asking again finds it there and changes nothing.
    assert_eq!(local(&mut supervisor, &checkout, &head), merged);
    // The person's own checkout was not touched.
    assert_eq!(
        git(&checkout.project(), &["rev-parse", "--abbrev-ref", "HEAD"]),
        "person"
    );
    assert!(!checkout.project().join("b.txt").exists());
}

#[test]
fn with_no_host_a_moved_branch_gets_a_merge_and_a_conflict_waits() {
    let checkout = Checkout::new("diverged");
    let mut supervisor = ready();
    let head = checkout.commit("author", "b.txt", "b\n");
    git(
        &checkout.project(),
        &["worktree", "add", "-q", "../other", "main"],
    );
    let moved = checkout.commit("other", "c.txt", "c\n");
    let checked_out = local(&mut supervisor, &checkout, &head);
    assert_eq!(checked_out["merged"], false);
    assert!(
        checked_out["waiting"]
            .as_str()
            .unwrap()
            .contains("checked out")
    );
    git(
        &checkout.project(),
        &["worktree", "remove", "--force", "../other"],
    );
    let merged = local(&mut supervisor, &checkout, &head);
    assert_eq!(merged["merged"], true);
    let commit = merged["commit"].as_str().unwrap();
    assert_eq!(
        git(&checkout.project(), &["rev-parse", &format!("{commit}^1")]),
        moved
    );
    assert_eq!(
        git(&checkout.project(), &["rev-parse", &format!("{commit}^2")]),
        head
    );
    let conflicting = checkout.commit("author", "c.txt", "not c\n");
    let waiting = local(&mut supervisor, &checkout, &conflicting);
    assert_eq!(waiting["merged"], false);
    assert!(waiting["waiting"].as_str().unwrap().contains("conflicts"));
    assert_eq!(git(&checkout.project(), &["rev-parse", "main"]), commit);
}

#[test]
fn reverting_a_goal_takes_back_what_was_built_on_it_newest_first() {
    let mut supervisor = ready();
    let merge = |supervisor: &mut Supervisor, goal: &str| {
        call(
            supervisor,
            "goals.merged",
            json!({"id":goal,"head":HEAD,"hostVerified":true}),
        );
    };
    let base = reviewed(&mut supervisor, "base");
    call(&mut supervisor, "goals.resolve", base);
    merge(&mut supervisor, "base");
    let other = reviewed(&mut supervisor, "other");
    call(&mut supervisor, "goals.resolve", other);
    merge(&mut supervisor, "other");
    // Built on base through a goal that changed nothing, so never merged.
    let between = reviewed(&mut supervisor, "between");
    let mut nothing = between.clone();
    nothing["merge"] = Value::Null;
    let mut definition =
        call(&mut supervisor, "goals.get", json!({"id":"between"}))["goal"].clone();
    definition["dependencies"] = json!(["base"]);
    call(&mut supervisor, "goals.upsert", json!({"goal":definition}));
    nothing["expectedGoalRevision"] =
        call(&mut supervisor, "goals.get", json!({"id":"between"}))["goal"]["revision"].clone();
    call(&mut supervisor, "goals.resolve", nothing);
    call(
        &mut supervisor,
        "goals.upsert",
        json!({"goal":{"id":"built","purpose":"Deliver built","acceptanceCriteria":["It works"],"dependencies":["between"],"authorizedScope":["project"]}}),
    );
    finished(&mut supervisor, "built-author", "built", None);
    finished(
        &mut supervisor,
        "built-review",
        "built",
        Some("review-model"),
    );
    let mut built = reviewed_resolution(&mut supervisor, "built");
    built["merge"] = json!({"head":HEAD,"target":"main","repository":"/repo"});
    call(&mut supervisor, "goals.resolve", built);
    merge(&mut supervisor, "built");
    let reverts = |supervisor: &mut Supervisor| -> Vec<String> {
        call(
            supervisor,
            "merges.reverts",
            json!({"id":"base","actor":"user"}),
        )["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["goalId"].as_str().unwrap().to_owned())
            .collect()
    };
    assert!(
        supervisor
            .call_at("merges.reverts", json!({"id":"base"}), NOW)
            .is_err()
    );
    assert_eq!(reverts(&mut supervisor), ["built", "base"]);
    assert!(
        supervisor
            .call_at("merges.reverted", json!({"id":"built"}), NOW)
            .is_err()
    );
    call(
        &mut supervisor,
        "merges.reverted",
        json!({"id":"built","hostVerified":true}),
    );
    assert_eq!(reverts(&mut supervisor), ["base"]);
    assert!(
        supervisor
            .call_at(
                "merges.reverted",
                json!({"id":"built","hostVerified":true}),
                NOW
            )
            .is_err()
    );
}

#[test]
fn with_its_switch_off_a_projects_reviewed_change_waits_for_the_owner() {
    let mut supervisor = ready();
    let mut resolution = reviewed(&mut supervisor, "manual");
    resolution["merge"]["projectId"] = json!("project");
    call(&mut supervisor, "goals.resolve", resolution);
    let waiting = |supervisor: &mut Supervisor| {
        call(supervisor, "snapshot", json!({}))["ownerMerges"].clone()
    };
    assert_eq!(waiting(&mut supervisor), json!([]));
    assert!(
        supervisor
            .call_at("configure", json!({"manualMergeProjects":["project"]}), NOW)
            .is_err()
    );
    call(
        &mut supervisor,
        "configure",
        json!({"actor":"user","manualMergeProjects":["project"]}),
    );
    assert_eq!(waiting(&mut supervisor)[0]["goalId"], "manual");
    call(
        &mut supervisor,
        "goals.merged",
        json!({"id":"manual","head":HEAD,"hostVerified":true}),
    );
    assert_eq!(waiting(&mut supervisor), json!([]));
}

#[test]
fn work_cancelled_replaced_or_left_by_a_cancelled_goal_settles_at_once() {
    let mut supervisor = ready();
    call(
        &mut supervisor,
        "goals.upsert",
        json!({"goal":{"id":"g","purpose":"Deliver g","acceptanceCriteria":["It works"],"authorizedScope":["project"]}}),
    );
    let settles = |supervisor: &mut Supervisor| -> Vec<String> {
        pending(supervisor, "thread.settle")
            .iter()
            .map(|action| action["id"].as_str().unwrap().to_owned())
            .collect()
    };
    ended(&mut supervisor, "stopped", "g", None, "cancelled");
    assert_eq!(settles(&mut supervisor), ["settle:cancelled:stopped"]);
    ended(&mut supervisor, "broken", "g", None, "failed");
    // A failure alone may still be repaired; replaced by later work, it is done.
    assert_eq!(settles(&mut supervisor).len(), 1);
    let mut repair = json!({"id":"repair","idempotencyKey":"request:repair","cardId":"parent","goalId":"g","route":{"provider":"replay","model":"model","effort":"high","destination":"local"},"instructionRevision":1,"pauseRevision":0,"grantRevision":0,"reservation":{"id":"reservation:repair","owner":"t3:local","expiresAt":NOW+60_000,"policyRevision":"policy-v1","sharedCapacity":true},"brief":"Repair the bounded result and preserve user scope.","returnRoute":"coordinator:coordinator","supersedes":["broken"]});
    let snapshot = call(&mut supervisor, "snapshot", json!({}));
    repair["pauseRevision"] = snapshot["pause"]["revision"].clone();
    repair["grantRevision"] = snapshot["policyRevision"].clone();
    call(
        &mut supervisor,
        "cards.sync",
        json!({"cards":[card("thread:repair")]}),
    );
    let prepared = call(
        &mut supervisor,
        "assignments.prepare",
        json!({"assignment":repair}),
    );
    assert!(settles(&mut supervisor).contains(&"settle:replaced:broken".to_owned()));
    call(
        &mut supervisor,
        "actions.claim",
        json!({"id":prepared["action"]["id"]}),
    );
    call(
        &mut supervisor,
        "actions.ack",
        json!({"id":prepared["action"]["id"],"status":"completed","result":{"status":"running","receipt":{"threadId":"thread:repair","runId":"run:repair","latestRunId":"run:repair"},"executionId":"thread:repair","cardId":"thread:repair"}}),
    );
    call(
        &mut supervisor,
        "assignments.update",
        json!({"id":"repair","status":"completed"}),
    );
    let mut goal = call(&mut supervisor, "goals.get", json!({"id":"g"}))["goal"].clone();
    goal["status"] = json!("cancelled");
    call(&mut supervisor, "goals.upsert", json!({"goal":goal}));
    assert!(settles(&mut supervisor).contains(&"settle:abandoned:repair".to_owned()));
    let claimed = call(
        &mut supervisor,
        "actions.claim",
        json!({"id":"settle:cancelled:stopped"}),
    );
    assert_eq!(claimed["claimed"], true);
    call(
        &mut supervisor,
        "actions.ack",
        json!({"id":"settle:cancelled:stopped","status":"completed","result":{"settled":true,"cardId":"thread:stopped"}}),
    );
    assert_eq!(
        call(&mut supervisor, "cards.get", json!({"id":"thread:stopped"}))["card"]["settled"],
        true
    );
}

#[test]
fn the_coordinator_hears_when_a_merge_waits_lands_or_is_reverted() {
    let mut supervisor = ready();
    let resolution = reviewed(&mut supervisor, "told");
    call(&mut supervisor, "goals.resolve", resolution);
    let merges = |supervisor: &mut Supervisor| -> Vec<String> {
        call(supervisor, "events.read", json!({"limit":100}))["events"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|event| event["kind"] == "merge")
            .map(|event| event["status"].as_str().unwrap().to_owned())
            .collect()
    };
    merges(&mut supervisor);
    for _ in 0..2 {
        call(
            &mut supervisor,
            "merges.wait",
            json!({"id":"told","reason":"The checks are pending."}),
        );
    }
    call(
        &mut supervisor,
        "merges.wait",
        json!({"id":"told","reason":"Automatic merge is off here.","owner":true}),
    );
    assert_eq!(
        call(&mut supervisor, "merges.list", json!({}))["items"][0]["waiting"]["owner"],
        true
    );
    // The owner's board shows the merging goal and what its merge waits for.
    let view = call(&mut supervisor, "board.view", json!({}));
    assert_eq!(
        view["merges"],
        json!([{"goalId":"told","reason":"Automatic merge is off here.","owner":1}])
    );
    assert!(
        view["goals"]
            .as_array()
            .unwrap()
            .iter()
            .any(|goal| goal["id"] == "told")
    );
    call(
        &mut supervisor,
        "goals.merged",
        json!({"id":"told","head":HEAD,"hostVerified":true}),
    );
    // Merged, it waits for nothing and is what the owner may revert.
    let view = call(&mut supervisor, "board.view", json!({}));
    assert_eq!(view["merges"], json!([]));
    assert_eq!(view["merged"][0]["goalId"], "told");
    // The host records the revert on the goal's outcome, then reports it done.
    call(
        &mut supervisor,
        "outcomes.record",
        json!({"round":{"assignmentId":"revert:told","goalId":"told","instance":"replay","model":"model","effort":"high",
               "rank":"B","usedMicros":50,"startedAt":0,"endedAt":10_000,"finish":"reverted"}}),
    );
    call(
        &mut supervisor,
        "merges.reverted",
        json!({"id":"told","hostVerified":true}),
    );
    // Done, the reverted goal and its doubled cost stay on the owner's board.
    let view = call(&mut supervisor, "board.view", json!({}));
    assert_eq!(view["reverted"][0]["goalId"], "told");
    let cost = view["costs"]
        .as_array()
        .unwrap()
        .iter()
        .find(|cost| cost["goalId"] == "told")
        .unwrap()
        .clone();
    assert_eq!(
        (cost["reverts"].clone(), cost["useMicros"].clone()),
        (json!(1), json!(100.0))
    );
    assert_eq!(
        merges(&mut supervisor),
        ["waiting", "owner", "merged", "reverted"]
    );
}

#[test]
fn a_settlement_outlives_an_unrelated_change_to_its_card() {
    let mut supervisor = ready();
    let resolution = reviewed(&mut supervisor, "kept");
    call(&mut supervisor, "goals.resolve", resolution);
    call(
        &mut supervisor,
        "goals.merged",
        json!({"id":"kept","head":HEAD,"hostVerified":true}),
    );
    let action = pending(&mut supervisor, "thread.settle")[0].clone();
    let card = action["payload"]["cardId"].as_str().unwrap().to_owned();
    // The thread stops after the merge, so its card's status changes before the drain.
    call(
        &mut supervisor,
        "cards.sync",
        json!({"projection":true,"cards":[{"id":card,"status":"idle"}]}),
    );
    assert_eq!(
        call(&mut supervisor, "actions.claim", json!({"id":action["id"]}))["claimed"],
        true
    );
    call(
        &mut supervisor,
        "actions.ack",
        json!({"id":action["id"],"status":"completed","result":{"settled":true,"cardId":card}}),
    );
    assert_eq!(
        call(&mut supervisor, "cards.get", json!({"id":card}))["card"]["settled"],
        true
    );
}

#[test]
fn a_head_moved_past_the_review_goes_back_to_review_and_merges_after_it() {
    let mut supervisor = ready();
    let resolution = reviewed(&mut supervisor, "moved");
    call(&mut supervisor, "goals.resolve", resolution);
    assert!(
        supervisor
            .call_at(
                "merges.rereview",
                json!({"id":"moved","latestRunId":"run:fixed"}),
                NOW
            )
            .is_err()
    );
    let back = call(
        &mut supervisor,
        "merges.rereview",
        json!({"id":"moved","latestRunId":"run:fixed","hostVerified":true}),
    );
    assert_eq!(back["goal"]["status"], "active");
    let author = call(
        &mut supervisor,
        "assignments.get",
        json!({"id":"moved-author"}),
    )["assignment"]
        .clone();
    assert_eq!(author["status"], "completed");
    assert_eq!(author["receipt"]["latestRunId"], "run:fixed");
    assert!(
        call(&mut supervisor, "merges.list", json!({}))["items"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    // The Coordinator hears that the author's work finished, and has it reviewed again.
    assert!(
        call(&mut supervisor, "events.read", json!({"limit":100}))["events"]
            .as_array()
            .unwrap()
            .iter()
            .any(|event| event["subject"] == "moved-author" && event["status"] == "completed")
    );
    let mut second = json!({"id":"moved-review-2","idempotencyKey":"request:moved-review-2","cardId":"parent","goalId":"moved","role":"reviewer","route":{"provider":"replay","model":"review-model","effort":"high","destination":"local"},"instructionRevision":1,"pauseRevision":0,"grantRevision":0,"reservation":{"id":"reservation:moved-review-2","owner":"t3:local","expiresAt":NOW+60_000,"policyRevision":"policy-v1","sharedCapacity":true},"brief":"Review the bounded result against the goal's criteria.","returnRoute":"coordinator:coordinator","reviewGoalDigest":"a".repeat(64),"reviewSubjects":[{"assignmentId":"moved-author","executionId":"run:fixed","digest":"c".repeat(64)}]});
    call(
        &mut supervisor,
        "cards.sync",
        json!({"cards":[card("thread:moved-review-2")]}),
    );
    let snapshot = call(&mut supervisor, "snapshot", json!({}));
    second["pauseRevision"] = snapshot["pause"]["revision"].clone();
    second["grantRevision"] = snapshot["policyRevision"].clone();
    let prepared = call(
        &mut supervisor,
        "assignments.prepare",
        json!({"assignment":second}),
    );
    call(
        &mut supervisor,
        "actions.claim",
        json!({"id":prepared["action"]["id"]}),
    );
    call(
        &mut supervisor,
        "actions.ack",
        json!({"id":prepared["action"]["id"],"status":"completed","result":{"status":"running","receipt":{"threadId":"thread:moved-review-2","runId":"run:moved-review-2","latestRunId":"run:moved-review-2"},"executionId":"thread:moved-review-2","cardId":"thread:moved-review-2"}}),
    );
    call(
        &mut supervisor,
        "assignments.update",
        json!({"id":"moved-review-2","status":"completed"}),
    );
    let revision =
        call(&mut supervisor, "goals.get", json!({"id":"moved"}))["goal"]["revision"].clone();
    let fixed = "fedcba9876543210fedcba9876543210fedcba98";
    let again = call(
        &mut supervisor,
        "goals.resolve",
        json!({"id":"moved","expectedGoalRevision":revision,"hostVerified":true,"reviewerAssignmentId":"moved-review-2",
            "reviewerReceipt":{"assignmentId":"moved-review-2","executionId":"run:moved-review-2","digest":"e".repeat(64)},
            "subjects":[{"assignmentId":"moved-author","executionId":"run:fixed","digest":"c".repeat(64)}],
            "integrationOwner":"moved-author",
            "evidence":[format!("review:moved-review-2:run:moved-review-2:{}", "e".repeat(64))],
            "merge":{"head":fixed,"target":"main","repository":"/repo"}}),
    );
    assert_eq!(again["goal"]["status"], "merging");
    assert_eq!(
        call(
            &mut supervisor,
            "goals.merged",
            json!({"id":"moved","head":fixed,"hostVerified":true})
        )["goal"]["status"],
        "completed"
    );
}

#[test]
fn every_merge_held_for_the_owner_is_theirs_to_see_with_what_it_needs() {
    let mut supervisor = ready();
    let resolution = reviewed(&mut supervisor, "held");
    call(&mut supervisor, "goals.resolve", resolution);
    let shown = |supervisor: &mut Supervisor| {
        call(supervisor, "snapshot", json!({}))["ownerMerges"].clone()
    };
    call(
        &mut supervisor,
        "merges.wait",
        json!({"id":"held","reason":"The checks are pending."}),
    );
    assert_eq!(shown(&mut supervisor), json!([]));
    // Automatic merge is on here; the host still cannot merge it, so the owner must.
    call(
        &mut supervisor,
        "merges.wait",
        json!({"id":"held","reason":"The host cannot merge exactly the reviewed commit.","owner":true}),
    );
    let item = shown(&mut supervisor)[0].clone();
    assert_eq!(
        item["reason"],
        "The host cannot merge exactly the reviewed commit."
    );
    assert_eq!(item["action"], Value::Null);
    call(
        &mut supervisor,
        "merges.wait",
        json!({"id":"held","reason":"A thread it did not start.","owner":true,"action":"merge"}),
    );
    assert_eq!(shown(&mut supervisor)[0]["action"], "merge");
}

#[test]
fn only_the_hosts_own_settlements_wait_to_be_finished_until_it_says_so() {
    let mut supervisor = ready();
    let resolution = reviewed(&mut supervisor, "steps");
    call(&mut supervisor, "goals.resolve", resolution);
    call(
        &mut supervisor,
        "goals.merged",
        json!({"id":"steps","head":HEAD,"hostVerified":true}),
    );
    let unfinished = |supervisor: &mut Supervisor| {
        call(supervisor, "settlements.unfinished", json!({}))["items"]
            .as_array()
            .unwrap()
            .len()
    };
    // Queued but not yet taken is not a settlement made.
    assert_eq!(unfinished(&mut supervisor), 0);
    let action = pending(&mut supervisor, "thread.settle")[0].clone();
    let card = action["payload"]["cardId"].clone();
    call(&mut supervisor, "actions.claim", json!({"id":action["id"]}));
    call(
        &mut supervisor,
        "actions.ack",
        json!({"id":action["id"],"status":"completed","result":{"settled":true,"cardId":card}}),
    );
    assert_eq!(unfinished(&mut supervisor), 1);
    call(
        &mut supervisor,
        "settlements.finished",
        json!({"id":action["id"]}),
    );
    assert_eq!(unfinished(&mut supervisor), 0);
}

#[test]
fn a_hand_merge_at_another_head_completes_the_goal_and_says_no_review_saw_it() {
    let mut supervisor = ready();
    let resolution = reviewed(&mut supervisor, "byhand");
    call(&mut supervisor, "goals.resolve", resolution);
    let other = "1111111111111111111111111111111111111111";
    // Only as a hand merge: the host never verifies a head the review did not pass.
    assert!(
        supervisor
            .call_at(
                "goals.merged",
                json!({"id":"byhand","head":other,"hostVerified":true}),
                NOW
            )
            .is_err()
    );
    let done = call(
        &mut supervisor,
        "goals.merged",
        json!({"id":"byhand","head":other,"byHand":true}),
    );
    assert_eq!(done["goal"]["status"], "completed");
    assert_eq!(pending(&mut supervisor, "outcome.accepted").len(), 1);
    let reverts = call(
        &mut supervisor,
        "merges.reverts",
        json!({"id":"byhand","actor":"user"}),
    )["items"][0]["merged"]
        .clone();
    assert_eq!(reverts["head"], other);
    assert_eq!(reverts["unreviewed"], true);
    // The owner's view shows it merged by hand, unreviewed, at the head that landed.
    let view = call(&mut supervisor, "board.view", json!({}));
    let shown = &view["merged"][0];
    assert_eq!(
        (
            shown["goalId"].clone(),
            shown["head"].clone(),
            shown["unreviewed"].clone()
        ),
        (json!("byhand"), json!(other), json!(1))
    );
    let snapshot = call(&mut supervisor, "snapshot", json!({}));
    assert!(
        snapshot["decisions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|decision| decision["id"] == "merged-unreviewed:byhand")
    );
}

#[test]
fn a_cloud_authors_rereview_is_of_the_head_its_run_pushed() {
    let mut supervisor = ready();
    let resolution = reviewed(&mut supervisor, "pushed");
    call(&mut supervisor, "goals.resolve", resolution);
    let pushed = "2222222222222222222222222222222222222222";
    assert!(
        supervisor
            .call_at(
                "merges.rereview",
                json!({"id":"pushed","latestRunId":"task","head":"short","hostVerified":true}),
                NOW
            )
            .is_err()
    );
    call(
        &mut supervisor,
        "merges.rereview",
        json!({"id":"pushed","latestRunId":"task","head":pushed,"hostVerified":true}),
    );
    // The next review, and the merge it leads to, are of that head.
    assert_eq!(
        call(
            &mut supervisor,
            "assignments.get",
            json!({"id":"pushed-author"})
        )["assignment"]["receipt"]["head"],
        pushed
    );
}

#[test]
fn a_commit_is_held_only_by_a_tip_it_is_in() {
    let checkout = Checkout::new("contains");
    let mut supervisor = ready();
    let head = checkout.commit("author", "b.txt", "b\n");
    let later = checkout.commit("author", "c.txt", "c\n");
    let repository = checkout.project().to_str().unwrap().to_owned();
    let contains = |supervisor: &mut Supervisor, head: &str, tips: Value| {
        call(
            supervisor,
            "merges.contains",
            json!({"repository":repository,"head":head,"tips":tips}),
        )["contains"]
            .clone()
    };
    assert_eq!(contains(&mut supervisor, &head, json!([later])), true);
    assert_eq!(
        contains(&mut supervisor, &head, json!(["refs/heads/main"])),
        false
    );
    // A commit this checkout lacks holds nothing.
    assert_eq!(
        contains(
            &mut supervisor,
            &head,
            json!(["f".repeat(40), "refs/heads/missing"])
        ),
        false
    );
    assert!(
        supervisor
            .call_at(
                "merges.contains",
                json!({"repository":repository,"head":head,"tips":["--output=/tmp/x"]}),
                NOW
            )
            .is_err()
    );
}
