use serde_json::{Value, json};
use std::{
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};
use t3_coordinator::{Error, Supervisor};

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
    ready_at(Path::new(":memory:"))
}

#[test]
fn stop_requests_cancellation_separately_from_group_pause_and_never_resumes_cancelled_work() {
    let mut supervisor = ready();
    let work = running(&mut supervisor, "cancel-me");
    let paused = call(&mut supervisor, "pause", json!({"actor":"user"}));
    assert_eq!(paused["pause"]["active"], true);
    assert!(pending(&mut supervisor, "cancel").is_empty());
    call(&mut supervisor, "stop", json!({"actor":"user"}));
    let cancellations = pending(&mut supervisor, "cancel");
    assert_eq!(cancellations.len(), 1);
    call(
        &mut supervisor,
        "actions.claim",
        json!({"id":cancellations[0]["id"]}),
    );
    call(
        &mut supervisor,
        "actions.ack",
        json!({"id":cancellations[0]["id"],"status":"completed","result":{"status":"cancelled","receipt":{"id":"cancel-confirmed"}}}),
    );
    call(&mut supervisor, "resume", json!({"actor":"user"}));
    assert_eq!(
        call(
            &mut supervisor,
            "assignments.get",
            json!({"id":work["assignment"]["id"]})
        )["assignment"]["status"],
        "cancelled"
    );
    assert!(pending(&mut supervisor, "resume").is_empty());
}

#[test]
fn saved_permission_presets_are_inert_until_explicit_scoped_apply_and_preview_never_mutates() {
    let mut supervisor = ready();
    let before = call(&mut supervisor, "snapshot", json!({}));
    call(
        &mut supervisor,
        "permissions.preset.save",
        json!({"actor":"user","preset":{"id":"reviewer","name":"Review only","rules":[{"category":"file-change","effect":"deny"}],"delegateApproval":true,"maxAccess":1}}),
    );
    let saved = call(&mut supervisor, "snapshot", json!({}));
    assert_eq!(saved["policyRevision"], before["policyRevision"]);
    assert_eq!(saved["permissions"], before["permissions"]);
    assert_eq!(saved["permissionPresets"][0]["name"], "Review only");
    assert!(supervisor.call_at("permissions.preset.apply",json!({"actor":"coordinator","presetId":"reviewer","scope":{"kind":"thread","id":"parent"}}),NOW).is_err());
    call(
        &mut supervisor,
        "permissions.preset.apply",
        json!({"actor":"user","presetId":"reviewer","scope":{"kind":"thread","id":"parent"}}),
    );
    let before_preview = call(&mut supervisor, "snapshot", json!({}));
    let preview = call(
        &mut supervisor,
        "permissions.preview",
        json!({"scope":{"kind":"thread","id":"parent"},"category":"file-change","currentAccess":1,"requestedAccess":1}),
    );
    assert_eq!(preview["effect"], "deny");
    assert_eq!(preview["hypothetical"], true);
    assert_eq!(
        call(&mut supervisor, "snapshot", json!({}))["revision"],
        before_preview["revision"]
    );
    call(
        &mut supervisor,
        "permissions.preset.delete",
        json!({"actor":"user","presetId":"reviewer"}),
    );
    let after = call(&mut supervisor, "snapshot", json!({}));
    assert_eq!(after["permissions"], before_preview["permissions"]);
    assert_eq!(after["policyRevision"], before_preview["policyRevision"]);
    call(
        &mut supervisor,
        "permissions.set",
        json!({"actor":"user","policy":{"id":"routine","mode":"approve","scope":{"kind":"global","id":null},"maxAccess":2}}),
    );
    assert_eq!(
        call(
            &mut supervisor,
            "permissions.preview",
            json!({"scope":{"kind":"global","id":null},"category":"command","currentAccess":1})
        )["effect"],
        "ask"
    );
    assert_eq!(
        call(
            &mut supervisor,
            "permissions.preview",
            json!({"scope":{"kind":"global","id":null},"category":"command","currentAccess":1,"requestedAccess":1})
        )["effect"],
        "allow"
    );
    assert_eq!(
        call(
            &mut supervisor,
            "permissions.preview",
            json!({"scope":{"kind":"global","id":null},"category":"command","currentAccess":1,"requestedAccess":2})
        )["effect"],
        "ask"
    );
}

#[test]
fn discovery_user_policy_and_manual_quarantine_survive_catalog_refresh_without_inventing_qualification()
 {
    let mut supervisor = ready();
    call(
        &mut supervisor,
        "catalog.source.set",
        json!({"actor":"user","sourceId":"provider","automaticDiscovery":false,"automaticEligibility":false}),
    );
    call(
        &mut supervisor,
        "catalog.model.set",
        json!({"actor":"user","modelId":"catalog:local:model","quarantined":true}),
    );
    call(
        &mut supervisor,
        "catalog.sync",
        json!({"sourceId":"provider","automaticDiscovery":true,"automaticEligibility":true,"models":[model("model","local")]}),
    );
    let snapshot = call(&mut supervisor, "snapshot", json!({}));
    assert_eq!(snapshot["catalogSources"][0]["automaticDiscovery"], false);
    assert_eq!(snapshot["catalogSources"][0]["automaticEligibility"], false);
    assert_eq!(snapshot["catalog"][0]["manuallyQuarantined"], true);
    assert_eq!(snapshot["catalog"][0]["state"], "quarantined");
    assert_eq!(
        call(
            &mut supervisor,
            "catalog.refresh",
            json!({"sourceId":"provider","automatic":true})
        )["deferred"],
        true
    );
    call(
        &mut supervisor,
        "catalog.model.set",
        json!({"actor":"user","modelId":"catalog:local:model","quarantined":false}),
    );
    assert_eq!(
        call(&mut supervisor, "snapshot", json!({}))["catalog"][0]["state"],
        "validating"
    );
    let mut unknown = model("new-unqualified", "local");
    unknown["qualificationVerified"] = json!(false);
    call(
        &mut supervisor,
        "catalog.sync",
        json!({"sourceId":"provider","complete":false,"models":[unknown]}),
    );
    call(
        &mut supervisor,
        "catalog.source.set",
        json!({"actor":"user","sourceId":"provider","automaticEligibility":true}),
    );
    let models = call(&mut supervisor, "catalog.list", json!({}));
    assert!(
        models["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|model| model["model"] == "new-unqualified" && model["state"] == "validating")
    );
    assert!(
        supervisor
            .call_at(
                "catalog.model.set",
                json!({"actor":"coordinator","modelId":"catalog:local:model","quarantined":false}),
                NOW
            )
            .is_err()
    );
}

#[test]
fn a_stored_automatic_eligibility_stands_only_when_the_owner_set_it() {
    let state = |supervisor: &mut Supervisor, source: &str, eligibility: Option<bool>| {
        let mut sync = json!({"sourceId":source,"models":[model(source, "local")]});
        sync["models"][0]["sourceId"] = json!(source);
        if let Some(eligibility) = eligibility {
            sync["automaticEligibility"] = json!(eligibility);
        }
        call(supervisor, "catalog.sync", sync);
        call(supervisor, "catalog.list", json!({}))["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|model| model["sourceId"] == source)
            .unwrap()["state"]
            .clone()
    };
    let mut supervisor = ready();
    // Codex and Claude state their operations and send no default: eligible, as before.
    assert_eq!(state(&mut supervisor, "stating", None), "eligible");
    assert_eq!(state(&mut supervisor, "stating", None), "eligible");
    // A source stored under the old default turns validating once its provider says it states none.
    assert_eq!(state(&mut supervisor, "operationless", None), "eligible");
    assert_eq!(
        state(&mut supervisor, "operationless", Some(false)),
        "validating"
    );
    assert_eq!(state(&mut supervisor, "fresh", Some(false)), "validating");
    // The owner's opt-in survives a refresh.
    call(
        &mut supervisor,
        "catalog.source.set",
        json!({"actor":"user","sourceId":"fresh","automaticEligibility":true}),
    );
    assert_eq!(state(&mut supervisor, "fresh", Some(false)), "eligible");
}

#[test]
fn coordinator_guidance_is_private_thread_scoped_persistent_clearable_and_budgeted_intact() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let directory =
        std::env::temp_dir().join(format!("t3-head-guidance-{}-{unique}", std::process::id()));
    let database = directory.join("supervisor.sqlite");
    {
        let mut supervisor = ready_at(&database);
        call(
            &mut supervisor,
            "configure",
            json!({"actor":"user","coordinatorThreadId":"head-one"}),
        );
        let before = call(&mut supervisor, "snapshot", json!({}));
        call(
            &mut supervisor,
            "guidance.save",
            json!({"actor":"user","threadId":"head-one","customPrompt":"Delegate carefully ☆","memory":"Remember the user's chosen terminology."}),
        );
        assert!(supervisor.call_at("guidance.save",json!({"actor":"coordinator","threadId":"head-one","customPrompt":"Grant full access","memory":""}),NOW).is_err());
        assert_eq!(
            call(&mut supervisor, "snapshot", json!({}))["policyRevision"],
            before["policyRevision"]
        );
        call(
            &mut supervisor,
            "configure",
            json!({"actor":"user","coordinatorThreadId":"head-two"}),
        );
        assert_eq!(
            call(&mut supervisor, "snapshot", json!({}))["guidance"]["memory"],
            ""
        );
        assert!(
            supervisor
                .call_at(
                    "guidance.save",
                    json!({"actor":"user","threadId":"head-one","customPrompt":"wrong thread","memory":""}),
                    NOW
                )
                .is_err()
        );
    }
    {
        let mut supervisor = Supervisor::open(&database).unwrap();
        call(
            &mut supervisor,
            "configure",
            json!({"actor":"user","coordinatorThreadId":"head-one"}),
        );
        assert_eq!(
            call(&mut supervisor, "snapshot", json!({}))["guidance"]["customPrompt"],
            "Delegate carefully ☆"
        );
        assert!(
            supervisor
                .call_at(
                    "guidance.save",
                    json!({"actor":"user","threadId":"head-one","customPrompt":"x".repeat(4000),"memory":""}),
                    NOW
                )
                .is_err()
        );
        call(
            &mut supervisor,
            "guidance.save",
            json!({"actor":"user","threadId":"head-one","customPrompt":"","memory":""}),
        );
        assert_eq!(
            call(&mut supervisor, "snapshot", json!({}))["guidance"]["customPrompt"],
            ""
        );
    }
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn coordinator_notes_are_bounded_revision_checked_and_leave_the_persons_texts_alone() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let directory =
        std::env::temp_dir().join(format!("t3-head-notes-{}-{unique}", std::process::id()));
    let database = directory.join("supervisor.sqlite");
    {
        let mut supervisor = ready_at(&database);
        call(
            &mut supervisor,
            "configure",
            json!({"actor":"user","coordinatorThreadId":"head-one"}),
        );
        // Guidance stored before the notes existed.
        let connection = rusqlite::Connection::open(&database).unwrap();
        connection
            .execute(
                "INSERT INTO documents(kind,id,body,revision) VALUES ('guidance','head-one',?1,1)",
                [json!({"threadId":"head-one","customPrompt":"Delegate carefully","memory":"Prefers short replies.","revision":1}).to_string()],
            )
            .unwrap();
    }
    let mut supervisor = Supervisor::open(&database).unwrap();
    let old = call(&mut supervisor, "snapshot", json!({}))["guidance"].clone();
    assert_eq!(old["coordinatorNotes"], "");
    assert_eq!(old["memory"], "Prefers short replies.");
    let save = |notes: String, revision: &Value| json!({"threadId":"head-one","coordinatorNotes":notes,"expectedGuidanceRevision":revision});
    assert!(
        supervisor
            .call_at(
                "guidance.notes.save",
                save("x".repeat(2001), &old["revision"]),
                NOW
            )
            .is_err()
    );
    let saved = call(
        &mut supervisor,
        "guidance.notes.save",
        save("☆".repeat(2000), &old["revision"]),
    )["guidance"]
        .clone();
    assert_eq!(saved["customPrompt"], "Delegate carefully");
    assert_eq!(saved["memory"], "Prefers short replies.");
    // A save based on the notes before this one is stale.
    assert!(
        supervisor
            .call_at(
                "guidance.notes.save",
                save("Uses pnpm.".into(), &old["revision"]),
                NOW
            )
            .is_err()
    );
    // The person's save without notes keeps them; with notes, it edits or clears them.
    call(
        &mut supervisor,
        "guidance.save",
        json!({"actor":"user","threadId":"head-one","customPrompt":"","memory":""}),
    );
    assert_eq!(
        call(&mut supervisor, "snapshot", json!({}))["guidance"]["coordinatorNotes"],
        "☆".repeat(2000)
    );
    assert!(
        supervisor
            .call_at(
                "guidance.save",
                json!({"actor":"user","threadId":"head-one","customPrompt":"","memory":"","coordinatorNotes":"x".repeat(2001)}),
                NOW
            )
            .is_err()
    );
    call(
        &mut supervisor,
        "guidance.save",
        json!({"actor":"user","threadId":"head-one","customPrompt":"","memory":"","coordinatorNotes":""}),
    );
    let cleared = call(&mut supervisor, "snapshot", json!({}))["guidance"].clone();
    assert_eq!(cleared["coordinatorNotes"], "");
    call(
        &mut supervisor,
        "guidance.notes.save",
        save("Uses pnpm.".into(), &cleared["revision"]),
    );
    drop(supervisor);
    let mut supervisor = Supervisor::open(&database).unwrap();
    assert_eq!(
        call(&mut supervisor, "snapshot", json!({}))["guidance"]["coordinatorNotes"],
        "Uses pnpm."
    );
    // The host records each notes change under one id, which replaces the row before it.
    for summary in ["first", "second"] {
        call(
            &mut supervisor,
            "decisions.record",
            json!({"decision":{"id":"notes:head-one","summary":summary,"provenance":"coordinator-notes","cardIds":[],"goalIds":[],"expiresAt":NOW}}),
        );
    }
    let decisions = call(&mut supervisor, "decisions.list", json!({}))["items"].clone();
    assert_eq!(decisions.as_array().unwrap().len(), 1);
    assert_eq!(decisions[0]["summary"], "second");
    drop(supervisor);
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn coordinator_notes_for_a_thread_no_longer_configured_are_refused_and_write_nothing() {
    let mut supervisor = ready();
    let configure = |supervisor: &mut Supervisor, thread: &str| {
        call(
            supervisor,
            "configure",
            json!({"actor":"user","coordinatorThreadId":thread}),
        );
        call(supervisor, "snapshot", json!({}))["guidance"].clone()
    };
    // Both threads hold unsaved default guidance at the same revision.
    let planned = configure(&mut supervisor, "head-one");
    let switched = configure(&mut supervisor, "head-two");
    assert_eq!(planned["revision"], switched["revision"]);
    assert!(
        supervisor
            .call_at(
                "guidance.notes.save",
                json!({"threadId":"head-one","coordinatorNotes":"Uses pnpm.","expectedGuidanceRevision":planned["revision"]}),
                NOW
            )
            .is_err()
    );
    assert_eq!(
        configure(&mut supervisor, "head-two")["coordinatorNotes"],
        ""
    );
    assert_eq!(
        configure(&mut supervisor, "head-one")["coordinatorNotes"],
        ""
    );
}

fn rejected_goal(supervisor: &mut Supervisor) {
    call(
        supervisor,
        "goals.upsert",
        json!({"goal":{"id":"repair-budget","purpose":"Deliver a verified result","acceptanceCriteria":["Result correct"],"authorizedScope":["project"]}}),
    );
    let mut author = assignment("source");
    author["goalId"] = json!("repair-budget");
    completed_goal_thread(supervisor, author);
    let subjects =
        json!([{"assignmentId":"source","executionId":"run:source","digest":"a".repeat(64)}]);
    let mut reviewer = assignment("rejecting-reviewer");
    reviewer["goalId"] = json!("repair-budget");
    reviewer["role"] = json!("reviewer");
    reviewer["route"]["model"] = json!("review-model");
    reviewer["reviewGoalDigest"] = json!("a".repeat(64));
    reviewer["reviewSubjects"] = subjects.clone();
    completed_goal_thread(supervisor, reviewer);
    let goal = call(supervisor, "goals.list", json!({}))["items"][0].clone();
    call(
        supervisor,
        "goals.block",
        json!({"id":"repair-budget","expectedGoalRevision":goal["revision"],"hostVerifiedRejection":true,"reviewerAssignmentId":"rejecting-reviewer","repairSources":subjects}),
    );
}

fn repair_assignment(id: &str) -> Value {
    let mut work = assignment(id);
    work["goalId"] = json!("repair-budget");
    work["supersedes"] = json!(["source"]);
    work
}

#[test]
fn failed_dispatch_ack_requires_explicit_non_submission_proof_to_release_a_repair_slot() {
    for status in ["failed", "unsupported"] {
        for proven_not_dispatched in [false, true] {
            let mut supervisor = ready();
            rejected_goal(&mut supervisor);
            let mut goal = call(&mut supervisor, "goals.list", json!({}))["items"][0].clone();
            goal["maxAttempts"] = json!(1);
            call(&mut supervisor, "goals.upsert", json!({"goal":goal}));
            let prepared = call(
                &mut supervisor,
                "assignments.prepare",
                json!({"assignment":repair_assignment("launch-attempt")}),
            );
            call(
                &mut supervisor,
                "actions.claim",
                json!({"id":prepared["action"]["id"]}),
            );
            let result = if proven_not_dispatched {
                json!({"status":"not-dispatched"})
            } else {
                json!({"reason":"Destination failed without a conclusive launch receipt"})
            };
            call(
                &mut supervisor,
                "actions.ack",
                json!({"id":prepared["action"]["id"],"status":status,"result":result}),
            );
            let next = call(
                &mut supervisor,
                "assignments.prepare",
                json!({"assignment":repair_assignment("another-id")}),
            );
            assert_eq!(
                next["blocked"] == true,
                !proven_not_dispatched,
                "{status}, explicit non-submission: {proven_not_dispatched}"
            );
            if proven_not_dispatched {
                assert!(!next["action"].is_null());
            }
        }
    }
}

#[test]
fn terminal_author_failures_require_lineage_and_proven_unlaunched_repairs_release_slots() {
    let mut supervisor = ready();
    call(
        &mut supervisor,
        "goals.upsert",
        json!({"goal":{"id":"repair-budget","purpose":"Implement result","maxAttempts":1,"authorizedScope":["project"]}}),
    );
    let mut initial = assignment("source");
    initial["goalId"] = json!("repair-budget");
    terminal_goal_thread(&mut supervisor, initial, "failed");
    let mut omitted = repair_assignment("unlinked");
    omitted["supersedes"] = json!([]);
    assert_eq!(
        call(
            &mut supervisor,
            "assignments.prepare",
            json!({"assignment":omitted})
        )["blocked"],
        true
    );
    let first = call(
        &mut supervisor,
        "assignments.prepare",
        json!({"assignment":repair_assignment("unlaunched")}),
    );
    assert!(!first["action"].is_null());
    call(
        &mut supervisor,
        "assignments.cancel",
        json!({"actor":"user","id":"unlaunched"}),
    );
    let replacement = call(
        &mut supervisor,
        "assignments.prepare",
        json!({"assignment":repair_assignment("actual-repair")}),
    );
    assert!(!replacement["action"].is_null());
    terminal_goal_thread(
        &mut supervisor,
        repair_assignment("actual-repair"),
        "failed",
    );
    assert!(
        call(&mut supervisor, "snapshot", json!({}))["decisions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|d| d["provenance"] == "coordinator-repair-limit")
    );
    // A capacity queue claim has no execution and therefore must not consume another attempt.
    let queued = json!({"id":"held-route","goalId":"repair-budget","cardId":"parent","instructionRevision":1,"intent":{"kind":"delegate","goalId":"repair-budget","parentThreadId":"parent","task":"Repair the failed result","supersedes":["source"]}});
    call(&mut supervisor, "routing.enqueue", queued);
    assert_eq!(
        call(&mut supervisor, "routing.claim", json!({"id":"held-route"}))["claimed"],
        false
    );
    assert_eq!(
        call(&mut supervisor, "routing.ready", json!({}))["items"],
        json!([])
    );
    let before = call(&mut supervisor, "snapshot", json!({}))["revision"].clone();
    call(&mut supervisor, "routing.ready", json!({}));
    assert_eq!(
        call(&mut supervisor, "snapshot", json!({}))["revision"],
        before
    );
    let mut goal = call(&mut supervisor, "goals.list", json!({}))["items"][0].clone();
    goal["maxAttempts"] = json!(4);
    call(&mut supervisor, "goals.upsert", json!({"goal":goal}));
    assert_eq!(
        call(&mut supervisor, "routing.claim", json!({"id":"held-route"}))["claimed"],
        true
    );
}

#[test]
fn three_goalwide_repairs_then_user_extension_preserves_sources_and_review_access() {
    let mut supervisor = ready();
    rejected_goal(&mut supervisor);
    for id in ["repair-one", "repair-two", "repair-three"] {
        completed_goal_thread(&mut supervisor, repair_assignment(id));
    }
    let fourth = call(
        &mut supervisor,
        "assignments.prepare",
        json!({"assignment":repair_assignment("repair-four")}),
    );
    assert_eq!(fourth["blocked"], true);
    let snapshot = call(&mut supervisor, "snapshot", json!({}));
    assert_eq!(snapshot["goals"][0]["status"], "blocked");
    assert!(
        snapshot["decisions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|d| d["provenance"] == "coordinator-repair-limit")
    );
    let mut ordinary_save = snapshot["goals"][0].clone();
    ordinary_save["assignmentIds"] = json!([]);
    ordinary_save["maxAttempts"] = Value::Null;
    call(
        &mut supervisor,
        "goals.upsert",
        json!({"goal":ordinary_save}),
    );
    assert_eq!(
        call(
            &mut supervisor,
            "assignments.prepare",
            json!({"assignment":repair_assignment("repair-four")})
        )["blocked"],
        true
    );
    let mut reviewer = assignment("third-repair-review");
    reviewer["goalId"] = json!("repair-budget");
    reviewer["role"] = json!("reviewer");
    reviewer["route"]["model"] = json!("review-model");
    reviewer["reviewGoalDigest"] = json!("a".repeat(64));
    reviewer["reviewSubjects"] = json!([{"assignmentId":"repair-three","executionId":"run:repair-three","digest":"b".repeat(64)}]);
    completed_goal_thread(&mut supervisor, reviewer);
    let mut goal = call(&mut supervisor, "goals.list", json!({}))["items"][0].clone();
    let stale = goal.clone();
    goal["maxAttempts"] = json!(6);
    goal["status"] = json!("active");
    goal["assignmentIds"] = json!([]);
    call(&mut supervisor, "goals.upsert", json!({"goal":goal}));
    assert!(
        supervisor
            .call_at("goals.upsert", json!({"goal":stale}), NOW)
            .is_err()
    );
    let fourth = call(
        &mut supervisor,
        "assignments.prepare",
        json!({"assignment":repair_assignment("repair-four")}),
    );
    assert!(!fourth["action"].is_null());
    let mut omitted = repair_assignment("new-id-no-lineage");
    omitted["supersedes"] = json!([]);
    assert_eq!(
        call(
            &mut supervisor,
            "assignments.prepare",
            json!({"assignment":omitted})
        )["blocked"],
        true
    );
}

#[test]
fn repair_reservations_survive_restart_uncertain_launch_and_do_not_count_capacity_retries() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let directory =
        std::env::temp_dir().join(format!("t3-repair-budget-{}-{unique}", std::process::id()));
    let database = directory.join("supervisor.sqlite");
    {
        let mut supervisor = ready_at(&database);
        rejected_goal(&mut supervisor);
        let mut goal = call(&mut supervisor, "goals.list", json!({}))["items"][0].clone();
        goal["maxAttempts"] = json!(1);
        call(&mut supervisor, "goals.upsert", json!({"goal":goal}));
        let prepared = call(
            &mut supervisor,
            "assignments.prepare",
            json!({"assignment":repair_assignment("reserved-repair")}),
        );
        let duplicate = call(
            &mut supervisor,
            "assignments.prepare",
            json!({"assignment":repair_assignment("reserved-repair")}),
        );
        assert_eq!(duplicate["deduplicated"], true);
        assert_eq!(
            call(
                &mut supervisor,
                "assignments.prepare",
                json!({"assignment":repair_assignment("parallel-repair")})
            )["blocked"],
            true
        );
        call(
            &mut supervisor,
            "actions.claim",
            json!({"id":prepared["action"]["id"]}),
        );
        call(
            &mut supervisor,
            "actions.ack",
            json!({"id":prepared["action"]["id"],"status":"uncertain"}),
        );
    }
    {
        let mut supervisor = Supervisor::open(&database).unwrap();
        assert_eq!(
            call(
                &mut supervisor,
                "assignments.prepare",
                json!({"assignment":repair_assignment("after-restart")})
            )["blocked"],
            true
        );
    }
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn initial_work_successful_first_integration_and_nonexecuting_blocks_are_not_repairs() {
    let mut supervisor = ready();
    call(
        &mut supervisor,
        "goals.upsert",
        json!({"goal":{"id":"repair-budget","purpose":"Research then integrate","authorizedScope":["project"],"maxAttempts":1}}),
    );
    let mut initial = assignment("source");
    initial["goalId"] = json!("repair-budget");
    completed_goal_thread(&mut supervisor, initial);
    let goal = call(&mut supervisor, "goals.list", json!({}))["items"][0].clone();
    call(
        &mut supervisor,
        "goals.block",
        json!({"id":"repair-budget","expectedGoalRevision":goal["revision"]}),
    );
    // A successful cloud draft's first integration uses this same terminal lineage shape; neither
    // supersession alone nor missing canonical evidence is a negative implementation verdict.
    completed_goal_thread(&mut supervisor, repair_assignment("first-integration"));
    completed_goal_thread(&mut supervisor, repair_assignment("ordinary-build"));
    let result = supervisor.call_at(
        "goals.upsert",
        json!({"goal":{"id":"spend","purpose":"A goal with a cap","budgetMicros":1}}),
        NOW,
    );
    assert!(result.unwrap_err().message.contains("Only the owner sets"));
}

fn board_goal(supervisor: &mut Supervisor, id: &str, touches: &[&str], extra: Value) {
    let mut goal = json!({"id":id,"purpose":format!("Deliver {id}"),"authorizedScope":["project"],"projectId":"project","touches":touches});
    goal.as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    call(supervisor, "goals.upsert", json!({"goal":goal}));
}

fn goal_work(id: &str, goal: &str) -> Value {
    let mut work = assignment(id);
    work["goalId"] = json!(goal);
    work
}

fn goal_ids(items: &Value) -> Vec<&str> {
    items
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["goalId"].as_str().unwrap())
        .collect()
}

#[test]
fn the_board_holds_back_a_goal_whose_touches_overlap_running_work() {
    let mut supervisor = ready();
    board_goal(&mut supervisor, "busy", &["src/pkg/"], json!({}));
    terminal_goal_thread(&mut supervisor, goal_work("busy-work", "busy"), "running");
    board_goal(&mut supervisor, "r1", &["src/pkg/mod.rs"], json!({}));
    board_goal(&mut supervisor, "r2", &["docs/a.md"], json!({}));
    board_goal(&mut supervisor, "r3", &["docs/a.md", "x.rs"], json!({}));
    board_goal(&mut supervisor, "r4", &["other.rs"], json!({}));
    board_goal(
        &mut supervisor,
        "r5",
        &["src/pkg/"],
        json!({"projectId":"elsewhere"}),
    );
    board_goal(
        &mut supervisor,
        "after",
        &["z.rs"],
        json!({"dependencies":["r4"]}),
    );
    let board = call(&mut supervisor, "board.next", json!({}));
    // r4 frees the goal that waits on it, so it starts first.
    assert_eq!(goal_ids(&board["next"]), ["r4", "r2", "r5"]);
    assert_eq!(
        board["waiting"],
        json!([{"goalId":"r1","reason":"touches overlap goal busy"},{"goalId":"r3","reason":"touches overlap goal r2"}])
    );
    assert_eq!(board["capacity"]["inFlight"], 1);
    // Ending the running assignment runs the board in the same transaction; finished work awaits review.
    let ended = call(
        &mut supervisor,
        "assignments.update",
        json!({"id":"busy-work","status":"completed"}),
    );
    assert_eq!(goal_ids(&ended["board"]["next"]), ["r4", "r1", "r2", "r5"]);
    limit(&mut supervisor, json!({"inFlight":2}));
    let limited = call(&mut supervisor, "board.next", json!({}));
    assert_eq!(goal_ids(&limited["next"]), ["r4", "r1"]);
    call(&mut supervisor, "pause", json!({"actor":"user"}));
    let paused = call(&mut supervisor, "board.next", json!({}));
    assert!(paused["next"].as_array().unwrap().is_empty());
    assert_eq!(paused["waiting"][0]["reason"], "paused");
}

#[test]
fn a_dispatch_carries_its_goals_touches_for_the_result_check() {
    let mut supervisor = ready();
    board_goal(&mut supervisor, "g", &["src/pkg/"], json!({}));
    let prepared = call(
        &mut supervisor,
        "assignments.prepare",
        json!({"assignment":goal_work("g-work","g")}),
    );
    assert_eq!(
        prepared["action"]["payload"]["touches"],
        json!(["src/pkg/"])
    );
}

#[test]
fn an_assignment_ends_even_when_the_board_cannot_be_computed() {
    let mut supervisor = ready();
    board_goal(&mut supervisor, "g", &["g.rs"], json!({}));
    terminal_goal_thread(&mut supervisor, goal_work("g-work", "g"), "running");
    let ended = call(
        &mut supervisor,
        "assignments.update",
        json!({"id":"g-work","status":"completed","scores":"not a list"}),
    );
    assert!(ended["board"]["error"]["message"].is_string());
    assert_eq!(
        call(&mut supervisor, "assignments.get", json!({"id":"g-work"}))["assignment"]["status"],
        "completed"
    );
}

#[test]
fn an_edit_to_a_waiting_goal_keeps_its_place_in_the_queue() {
    let mut supervisor = ready();
    board_goal(&mut supervisor, "b", &["b.rs"], json!({}));
    call(&mut supervisor, "board.next", json!({}));
    board_goal(&mut supervisor, "a", &["a.rs"], json!({}));
    supervisor
        .call_at("board.next", json!({}), NOW + 60_000)
        .unwrap();
    board_goal(
        &mut supervisor,
        "b",
        &["b.rs"],
        json!({"purpose":"Deliver b, edited"}),
    );
    let board = supervisor
        .call_at("board.next", json!({}), NOW + 120_000)
        .unwrap();
    assert_eq!(goal_ids(&board["next"]), ["b", "a"]);
    assert_eq!(board["next"][0]["queuedAt"], NOW);
}

fn budget(supervisor: &mut Supervisor, target: Value, cap: Value) {
    let mut parameters = json!({"actor":"user","cap":cap});
    parameters
        .as_object_mut()
        .unwrap()
        .extend(target.as_object().unwrap().clone());
    call(supervisor, "board.budget", parameters);
}

fn budget_decisions(supervisor: &mut Supervisor) -> Vec<String> {
    call(supervisor, "decisions.list", json!({}))["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|decision| decision["provenance"] == "coordinator-budget")
        .map(|decision| decision["id"].as_str().unwrap().to_owned())
        .collect()
}

#[test]
fn a_cap_on_either_dimension_stops_dispatch_and_is_reported_to_the_owner_once() {
    let mut supervisor = ready();
    for target in [json!({"projectId":"project"}), json!({"goalId":"spender"})] {
        let mut parameters = json!({"actor":"coordinator","cap":{"micros":100}});
        parameters
            .as_object_mut()
            .unwrap()
            .extend(target.as_object().unwrap().clone());
        assert!(supervisor.call_at("board.budget", parameters, NOW).is_err());
    }
    budget(
        &mut supervisor,
        json!({"projectId":"project"}),
        json!({"micros":100}),
    );
    for id in ["spender", "slow", "thrifty", "later"] {
        board_goal(&mut supervisor, id, &[&format!("{id}.rs")], json!({}));
    }
    budget(
        &mut supervisor,
        json!({"goalId":"slow"}),
        json!({"seconds":60}),
    );
    budget(
        &mut supervisor,
        json!({"goalId":"thrifty"}),
        json!({"micros":10}),
    );
    for id in ["spender", "slow", "thrifty"] {
        terminal_goal_thread(
            &mut supervisor,
            goal_work(&format!("{id}-work"), id),
            "running",
        );
    }
    call(
        &mut supervisor,
        "assignments.update",
        json!({"id":"slow-work","status":"failed","spend":{"micros":0,"seconds":60}}),
    );
    call(
        &mut supervisor,
        "assignments.update",
        json!({"id":"thrifty-work","status":"failed","spend":{"micros":10}}),
    );
    let ended = call(
        &mut supervisor,
        "assignments.update",
        json!({"id":"spender-work","status":"completed","spend":{"micros":150,"seconds":30}}),
    );
    assert!(ended["board"]["next"].as_array().unwrap().is_empty());
    assert_eq!(
        ended["board"]["waiting"],
        json!([
            {"goalId":"later","reason":"Project project reached its daily cap: 160 of 100 micros used"},
            {"goalId":"slow","reason":"Goal slow reached its cap: 60 of 60 seconds worked"},
            {"goalId":"thrifty","reason":"Goal thrifty reached its cap: 10 of 10 micros used"}
        ])
    );
    let blocked = call(
        &mut supervisor,
        "assignments.prepare",
        json!({"assignment":goal_work("later-work","later")}),
    );
    assert_eq!(blocked["blocked"], true);
    // A review lets work already paid for land, so no cap holds it back.
    let mut review = goal_work("spender-review", "spender");
    review["role"] = json!("reviewer");
    let reviewed = call(
        &mut supervisor,
        "assignments.prepare",
        json!({"assignment":review}),
    );
    assert_eq!(reviewed["assignment"]["status"], "queued");
    // The next day the project may spend again; the goals' own caps still hold.
    let tomorrow = supervisor
        .call_at("board.next", json!({}), NOW + 86_400_000)
        .unwrap();
    assert_eq!(goal_ids(&tomorrow["next"]), ["later"]);
    assert_eq!(goal_ids(&tomorrow["waiting"]), ["slow", "thrifty"]);
    // Needs you shows each cap reached, the project's only on the day it was reached.
    let reached = |supervisor: &mut Supervisor, at: u64| {
        supervisor.call_at("snapshot", json!({}), at).unwrap()["budgetsReached"].clone()
    };
    let goals = [
        json!({"goalId":"slow","cap":{"micros":null,"seconds":60},"micros":0,"seconds":60}),
        json!({"goalId":"thrifty","cap":{"micros":10,"seconds":null},"micros":10,"seconds":0}),
    ];
    assert_eq!(
        reached(&mut supervisor, NOW),
        json!([
            {"projectId":"project","cap":{"micros":100,"seconds":null},"micros":160,"seconds":90},
            goals[0],
            goals[1]
        ])
    );
    assert_eq!(reached(&mut supervisor, NOW + 86_400_000), json!(goals));
    assert_eq!(
        budget_decisions(&mut supervisor),
        ["budget:project:0", "budget:slow", "budget:thrifty"]
    );
    // The owner's view shows each cap beside what was spent against it, and no limit unset.
    let view = call(&mut supervisor, "board.view", json!({}));
    assert_eq!(
        view["budgets"],
        json!([{"projectId":"project","micros":100,"seconds":null}])
    );
    assert_eq!(
        view["today"],
        json!([{"projectId":"project","micros":160,"seconds":90}])
    );
    assert_eq!(view["weights"], json!({"use":1.0,"time":1.0}));
    assert_eq!(
        view["limits"],
        json!({"inFlight":null,"perLogin":null,"localSlots":null})
    );
    assert!(view["spend"].as_array().unwrap().contains(
        &json!({"assignmentId":"spender-work","goalId":"spender","micros":150,"seconds":30})
    ));
    assert_eq!(view["settled"], 0);
    assert_eq!(view["now"], NOW);
    // Whole lists, not a page: every open goal and unsettled card, and only live work.
    assert_eq!(view["goals"].as_array().unwrap().len(), 4);
    assert!(
        view["assignments"]
            .as_array()
            .unwrap()
            .iter()
            .all(|a| !["completed", "failed"].contains(&a["status"].as_str().unwrap()))
    );
}

#[test]
fn the_owners_board_lists_every_open_goal_where_the_snapshot_stops_at_its_page() {
    let mut supervisor = ready();
    for index in 0..101 {
        board_goal(&mut supervisor, &format!("g{index:03}"), &[], json!({}));
    }
    // The server asks for pages of 100.
    let snapshot = call(&mut supervisor, "snapshot", json!({"limit":100}));
    let view = call(&mut supervisor, "board.view", json!({}));
    assert_eq!(snapshot["goals"].as_array().unwrap().len(), 100);
    assert_eq!(view["goals"].as_array().unwrap().len(), 101);
}

#[test]
fn the_owners_board_counts_a_goals_time_as_routing_does() {
    let mut supervisor = ready();
    board_goal(&mut supervisor, "timed", &[], json!({}));
    let round = |id: &str, model: &str, started: u64, ended: u64, blocked: u64, finish: Value| {
        json!({"assignmentId":id,"goalId":"timed","instance":"replay","model":model,"effort":"high",
               "rank":"B","usedMicros":null,"startedAt":started,"endedAt":ended,"blockedSeconds":blocked,"finish":finish})
    };
    // 1,000 s, 400 of them waiting on the owner, then reverted: routing counts 600 s twice,
    // and its 300 micros twice.
    let mut first = round("first", "model", 0, 1_000_000, 400, json!("reverted"));
    first["usedMicros"] = json!(300);
    call(
        &mut supervisor,
        "outcomes.record",
        json!({ "round": first }),
    );
    // A round still running on another route adds its time so far, less its own wait.
    let view = call(
        &mut supervisor,
        "board.view",
        json!({"running":[round("second", "other", 2_000_000, 2_300_000, 100, Value::Null)]}),
    );
    let cost = view["costs"]
        .as_array()
        .unwrap()
        .iter()
        .find(|cost| cost["goalId"] == "timed")
        .unwrap()
        .clone();
    assert_eq!(cost["seconds"], 600.0 * 2.0 + 200.0);
    assert_eq!(cost["reverts"], 1);
    // The running round reported no use yet, so it is priced as routing prices it: its route's
    // estimate with the review its change will need (the default 1,000,000 and 40%).
    assert_eq!(cost["useMicros"], 600.0 + 1_400_000.0);
    // Without the running round, only the recorded time.
    let none = call(&mut supervisor, "board.view", json!({}))["costs"]
        .as_array()
        .unwrap()
        .iter()
        .find(|cost| cost["goalId"] == "timed")
        .unwrap()
        .clone();
    assert_eq!(none["seconds"], 1200.0);
}

#[test]
fn every_request_waiting_for_the_owner_is_in_the_snapshot_beyond_its_page() {
    let mut supervisor = ready();
    call(
        &mut supervisor,
        "cards.sync",
        json!({"cards":[card("delegated")]}),
    );
    for index in 0..101 {
        call(
            &mut supervisor,
            "permissions.request",
            json!({"request":{"id":format!("r{index:03}"),"cardId":"delegated","category":"filesystem.write","resource":"workspace/file","accessIncreaseUnknown":false,"requestedAccess":2,"currentAccess":1,"destinationMaxAccess":2,"supported":true}}),
        );
    }
    let snapshot = call(&mut supervisor, "snapshot", json!({"limit":100}));
    assert_eq!(
        snapshot["permissionRequests"].as_array().unwrap().len(),
        101
    );
    assert_eq!(snapshot["goals"].as_array().unwrap().len(), 0);
}

#[test]
fn the_owners_board_lists_kept_worktrees_until_their_note_expires() {
    let mut supervisor = ready();
    let keep = |supervisor: &mut Supervisor, expires: Value| {
        call(
            supervisor,
            "decisions.record",
            json!({"decision":{"id":"worktree-kept:coordinator:t","summary":"Kept /w after settling: it holds a.txt","provenance":"coordinator-merge","cardIds":["parent"],"goalIds":[],"expiresAt":expires}}),
        );
    };
    keep(&mut supervisor, Value::Null);
    assert_eq!(
        call(&mut supervisor, "board.view", json!({}))["kept"],
        json!([{"threadId":"coordinator:t","summary":"Kept /w after settling: it holds a.txt"}])
    );
    keep(&mut supervisor, json!(NOW));
    assert_eq!(
        call(&mut supervisor, "board.view", json!({}))["kept"],
        json!([])
    );
}

#[test]
fn rework_after_a_failed_round_adds_its_time_as_well_as_its_use() {
    let mut supervisor = ready();
    board_goal(&mut supervisor, "reworked", &[], json!({}));
    let round = |id: &str, started: u64, ended: u64, finish: Value| {
        json!({"round":{"assignmentId":id,"goalId":"reworked","instance":"replay","model":"model","effort":"high",
               "rank":"B","usedMicros":100,"startedAt":started,"endedAt":ended,"finish":finish}})
    };
    call(
        &mut supervisor,
        "outcomes.record",
        round("author", 0, 100_000, Value::Null),
    );
    call(
        &mut supervisor,
        "outcomes.record",
        round("rejected", 100_000, 100_000, json!("failed")),
    );
    call(
        &mut supervisor,
        "outcomes.record",
        round("repair", 200_000, 500_000, json!("merged")),
    );
    let cost = call(&mut supervisor, "board.view", json!({}))["costs"]
        .as_array()
        .unwrap()
        .iter()
        .find(|cost| cost["goalId"] == "reworked")
        .unwrap()
        .clone();
    // From the author's start to the repair's merge, and every round's use.
    assert_eq!(cost["seconds"], 500.0);
    assert_eq!(cost["useMicros"], 300.0);
}

#[test]
fn spend_counts_on_the_day_it_is_reported_and_stays_bounded() {
    let mut supervisor = ready();
    budget(
        &mut supervisor,
        json!({"projectId":"project"}),
        json!({"seconds":60}),
    );
    board_goal(&mut supervisor, "long", &["long.rs"], json!({}));
    board_goal(&mut supervisor, "other", &["other.rs"], json!({}));
    terminal_goal_thread(&mut supervisor, goal_work("long-work", "long"), "running");
    for spend in [
        json!({"micros":u64::MAX}),
        json!({"seconds":6_000_000_000_000_000_000u64}),
    ] {
        let refused = supervisor
            .call_at(
                "assignments.update",
                json!({"id":"long-work","status":"completed","spend":spend}),
                NOW,
            )
            .unwrap_err();
        assert!(refused.message.contains("at most"));
    }
    call(
        &mut supervisor,
        "assignments.update",
        json!({"id":"long-work","spend":null}),
    );
    call(
        &mut supervisor,
        "assignments.update",
        json!({"id":"long-work","spend":{"seconds":100,"micros":1_000_000_000_000_000u64}}),
    );
    assert_eq!(
        call(&mut supervisor, "board.next", json!({}))["waiting"],
        json!([{"goalId":"other","reason":"Project project reached its daily cap: 100 of 60 seconds worked"}])
    );
    // A running total of 130 the next day adds 30 to that day, not 130.
    let ended = supervisor
        .call_at(
            "assignments.update",
            json!({"id":"long-work","status":"completed","spend":{"seconds":130,"micros":1_000_000_000_000_000u64}}),
            NOW + 86_400_000,
        )
        .unwrap();
    assert_eq!(goal_ids(&ended["board"]["next"]), ["other"]);
}

#[test]
fn the_board_and_prepare_read_a_cap_from_the_goals_project() {
    let mut supervisor = ready();
    // The goal's work runs in a thread of "project"; the goal belongs to "elsewhere".
    board_goal(
        &mut supervisor,
        "away",
        &["a.rs"],
        json!({"projectId":"elsewhere"}),
    );
    budget(
        &mut supervisor,
        json!({"projectId":"elsewhere"}),
        json!({"micros":0}),
    );
    budget(
        &mut supervisor,
        json!({"projectId":"project"}),
        json!({"micros":1}),
    );
    let board = call(&mut supervisor, "board.next", json!({}));
    assert_eq!(goal_ids(&board["waiting"]), ["away"]);
    let blocked = call(
        &mut supervisor,
        "assignments.prepare",
        json!({"assignment":goal_work("away-work","away")}),
    );
    assert_eq!(blocked["blocked"], true);
    budget(&mut supervisor, json!({"projectId":"elsewhere"}), json!({}));
    budget(
        &mut supervisor,
        json!({"projectId":"project"}),
        json!({"micros":0}),
    );
    let board = call(&mut supervisor, "board.next", json!({}));
    assert_eq!(goal_ids(&board["next"]), ["away"]);
    let prepared = call(
        &mut supervisor,
        "assignments.prepare",
        json!({"assignment":goal_work("away-work","away")}),
    );
    assert_eq!(prepared["assignment"]["status"], "queued");
}

#[test]
fn prepare_holds_authors_only_to_limits_the_owner_set() {
    let mut supervisor = ready();
    // No limit is set: as much work starts as is asked for.
    for id in ["l1", "l2", "l3", "l4", "l5"] {
        prepare(&mut supervisor, id);
    }
    let refuse = |supervisor: &mut Supervisor, work: Value| {
        supervisor
            .call_at("assignments.prepare", json!({"assignment":work}), NOW)
            .unwrap_err()
            .message
    };
    // Only the owner sets limits; a limits field on prepare is not read.
    assert!(
        supervisor
            .call_at(
                "board.limits",
                json!({"actor":"coordinator","limits":{"perLogin":1}}),
                NOW
            )
            .is_err()
    );
    prepare(&mut supervisor, "l6");
    limit(&mut supervisor, json!({"perLogin":6}));
    assert_eq!(
        refuse(&mut supervisor, assignment("l7")),
        "Capacity: login at the limit you set"
    );
    limit(&mut supervisor, json!({"localSlots":6}));
    assert_eq!(
        refuse(&mut supervisor, assignment("l7")),
        "Capacity: at the local limit you set"
    );
    limit(&mut supervisor, json!({"inFlight":6}));
    assert_eq!(
        refuse(&mut supervisor, assignment("l7")),
        "Capacity: at the in-flight limit you set"
    );
    // A review is never held by a limit set for authors.
    let mut review = assignment("r1");
    review["role"] = json!("reviewer");
    call(
        &mut supervisor,
        "assignments.prepare",
        json!({"assignment":review}),
    );
}

#[test]
fn a_finished_assignment_of_another_role_leaves_its_goal_on_the_board() {
    let mut supervisor = ready();
    board_goal(&mut supervisor, "planned", &["p.rs"], json!({}));
    let mut plan = goal_work("plan-work", "planned");
    plan["role"] = json!("questwright");
    terminal_goal_thread(&mut supervisor, plan, "completed");
    let board = call(&mut supervisor, "board.next", json!({}));
    assert_eq!(goal_ids(&board["next"]), ["planned"]);
    // An author's finished change waits for its review instead.
    terminal_goal_thread(
        &mut supervisor,
        goal_work("author-work", "planned"),
        "completed",
    );
    let board = call(&mut supervisor, "board.next", json!({}));
    assert!(board["next"].as_array().unwrap().is_empty());
    assert!(board["waiting"].as_array().unwrap().is_empty());
}

#[test]
fn a_rejected_review_is_feedback_not_a_failure_of_skill() {
    let mut supervisor = ready();
    rejected_goal(&mut supervisor);
    let mut goal =
        call(&mut supervisor, "goals.get", json!({"id":"repair-budget"}))["goal"].clone();
    goal["status"] = json!("active");
    call(&mut supervisor, "goals.upsert", json!({"goal":goal}));
    let board = call(&mut supervisor, "board.next", json!({}));
    assert_eq!(goal_ids(&board["next"]), ["repair-budget"]);
    assert_eq!(board["next"][0]["ladder"]["exclude"], json!([]));
}

#[test]
fn the_board_routes_around_a_failed_attempt_but_not_a_failed_launch() {
    let mut supervisor = ready();
    board_goal(&mut supervisor, "retry", &["src/"], json!({}));
    let launch = call(
        &mut supervisor,
        "assignments.prepare",
        json!({"assignment":goal_work("launch","retry")}),
    );
    call(
        &mut supervisor,
        "actions.claim",
        json!({"id":launch["action"]["id"]}),
    );
    call(
        &mut supervisor,
        "actions.ack",
        json!({"id":launch["action"]["id"],"status":"failed","result":{"status":"not-dispatched"}}),
    );
    let board = call(&mut supervisor, "board.next", json!({}));
    assert_eq!(board["next"][0]["ladder"]["exclude"], json!([]));
    terminal_goal_thread(&mut supervisor, goal_work("attempt", "retry"), "running");
    let ended = call(
        &mut supervisor,
        "assignments.update",
        json!({"id":"attempt","status":"failed","scores":[{"provider":"replay","model":"model","effort":"high","score":48}]}),
    );
    assert_eq!(
        ended["board"]["next"][0]["ladder"],
        json!({"exclude":[{"provider":"replay","model":"model","effort":null}],"excludeProfiles":[],"minScore":43.0,"minTier":null})
    );
}

fn ready_at(path: &Path) -> Supervisor {
    let mut supervisor = Supervisor::open(path).unwrap();
    call(
        &mut supervisor,
        "configure",
        json!({"actor":"user","enabled":true,"coordinatorProvider":"replay","coordinatorModel":"replay"}),
    );
    call(
        &mut supervisor,
        "cards.sync",
        json!({"cards":[card("parent")]}),
    );
    call(
        &mut supervisor,
        "catalog.sync",
        json!({"sourceId":"provider","models":[model("model","local"),model("review-model","local")]}),
    );
    supervisor
}

fn model(id: &str, destination: &str) -> Value {
    json!({"id":format!("catalog:{destination}:{id}"),"sourceId":"provider","provider":"replay","model":id,"destination":destination,"account":null,"efforts":["low","high"],"compatible":true,"accessible":true,"policyAllowed":true,"qualificationVerified":true,"identityVerified":true,"evidence":["qualification:exact-model-and-options"]})
}

fn assignment(id: &str) -> Value {
    json!({"id":id,"idempotencyKey":format!("request:{id}"),"cardId":"parent","goalId":null,"route":{"provider":"replay","model":"model","effort":"high","destination":"local"},"instructionRevision":1,"pauseRevision":0,"grantRevision":0,"reservation":{"id":format!("reservation:{id}"),"owner":"t3:local","expiresAt":NOW+60_000,"policyRevision":"policy-v1","sharedCapacity":true},"brief":"Build the bounded result, verify acceptance, and preserve user scope.","returnRoute":"coordinator:coordinator"})
}

fn prepare(supervisor: &mut Supervisor, id: &str) -> Value {
    call(
        supervisor,
        "assignments.prepare",
        json!({"assignment":assignment(id)}),
    )
}

fn running(supervisor: &mut Supervisor, id: &str) -> Value {
    let prepared = prepare(supervisor, id);
    call(
        supervisor,
        "actions.claim",
        json!({"id":prepared["action"]["id"]}),
    );
    call(
        supervisor,
        "actions.ack",
        json!({"id":prepared["action"]["id"],"status":"completed","result":{"status":"running","receipt":{"id":format!("receipt:{id}")},"executionId":format!("turn:{id}")}}),
    );
    prepared
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
fn a_source_user_override_is_applied_once_and_later_direct_pins_win() {
    let mut supervisor = ready();
    call(
        &mut supervisor,
        "overrides.set",
        json!({"actor":"user","override":{"id":"original-choices","scope":{"kind":"thread","id":"parent"},"selection":{"provider":"replay","effort":"high","account":"same-account","destination":"local"}}}),
    );
    let goal = call(&mut supervisor,"goals.upsert",json!({"goal":{"id":"model-request","purpose":"use model model for parent","authorizedScope":["project"]}}))["goal"].clone();
    let request = json!({"actor":"user","sourceGoalId":"model-request","sourceGoalRevision":goal["revision"],"sourceGoalPurpose":goal["purpose"],"override":{"id":"source-pin","scope":{"kind":"thread","id":"parent"},"selection":{"model":"model"}}});
    call(&mut supervisor, "overrides.set", request);
    let effective = call(
        &mut supervisor,
        "overrides.resolve",
        json!({"threadId":"parent","projectId":"project","environmentId":"env"}),
    );
    assert_eq!(effective["selection"]["effort"], "high");
    assert_eq!(effective["selection"]["account"], "same-account");
    call(
        &mut supervisor,
        "overrides.set",
        json!({"actor":"user","override":{"id":"later-direct","scope":{"kind":"thread","id":"parent"},"selection":{"model":"user-later-model"}}}),
    );
    let renewed = call(&mut supervisor,"goals.upsert",json!({"goal":{"id":"model-request","purpose":"use model model for parent","authorizedScope":["project"]}}))["goal"].clone();
    let duplicate = call(
        &mut supervisor,
        "overrides.set",
        json!({"actor":"user","sourceGoalId":"model-request","sourceGoalRevision":renewed["revision"],"sourceGoalPurpose":renewed["purpose"],"override":{"id":"replayed-source","scope":{"kind":"thread","id":"parent"},"selection":{"model":"model"}}}),
    );
    assert_eq!(duplicate["deduplicated"], true);
    assert_eq!(
        call(
            &mut supervisor,
            "overrides.resolve",
            json!({"threadId":"parent","projectId":"project","environmentId":"env"})
        )["selection"]["model"],
        "user-later-model"
    );
}

#[test]
fn provider_selected_cloud_requires_explicit_opt_in_and_does_not_become_qualified() {
    let mut supervisor = ready();
    let mut cloud_model = model("provider-selected", "cloud:codex");
    cloud_model["qualificationVerified"] = json!(false);
    cloud_model["identityVerified"] = json!(false);
    cloud_model["efforts"] = json!([]);
    call(
        &mut supervisor,
        "catalog.sync",
        json!({"sourceId":"provider","models":[cloud_model]}),
    );
    let mut cloud = assignment("cloud-one");
    cloud["route"]["model"] = json!("provider-selected");
    cloud["route"]["effort"] = Value::Null;
    cloud["route"]["destination"] = json!("cloud:codex");
    assert!(
        supervisor
            .call_at("assignments.prepare", json!({"assignment":cloud}), NOW)
            .is_err()
    );
    call(
        &mut supervisor,
        "configure",
        json!({"actor":"user","allowUnverifiedCloudModels":true}),
    );
    call(
        &mut supervisor,
        "assignments.prepare",
        json!({"assignment":cloud}),
    );
    let snapshot = call(&mut supervisor, "snapshot", json!({}));
    assert_eq!(snapshot["catalog"][0]["qualificationVerified"], false);
    assert_eq!(snapshot["assignments"][0]["identityVerified"], false);
}

#[test]
fn display_names_do_not_rename_pause_control() {
    let mut supervisor = Supervisor::open(Path::new(":memory:")).unwrap();
    let snapshot = call(&mut supervisor, "snapshot", json!({}));
    assert_eq!(snapshot["configuration"]["enabled"], false);
    assert_eq!(snapshot["configuration"]["permissionMode"], "ask");
    assert_eq!(
        snapshot["configuration"]["labels"]["coordinatorSingular"],
        "Conductor"
    );
    assert_eq!(snapshot["pause"]["label"], "Pause all");
    // Stored labels without a name kind read as a role; a given name is kept, nothing else is.
    assert!(
        snapshot["configuration"]["labels"]
            .get("coordinatorNameKind")
            .is_none()
    );
    let snapshot = call(
        &mut supervisor,
        "configure",
        json!({"actor":"user","labels":{"coordinatorSingular":"Claudia","coordinatorNameKind":"given"}}),
    );
    assert_eq!(
        snapshot["configuration"]["labels"]["coordinatorNameKind"],
        "given"
    );
    assert!(
        supervisor
            .call_at(
                "configure",
                json!({"actor":"user","labels":{"coordinatorNameKind":"nickname"}}),
                NOW
            )
            .is_err()
    );
    assert_eq!(
        snapshot["configuration"]["managedCeiling"],
        "auto-accept-edits"
    );
    assert!(
        supervisor
            .call_at(
                "configure",
                json!({"actor":"user","managedCeiling":"full-access"}),
                NOW
            )
            .is_err()
    );
    let snapshot = call(
        &mut supervisor,
        "configure",
        json!({"actor":"user","managedCeiling":"approval-required"}),
    );
    assert_eq!(
        snapshot["configuration"]["managedCeiling"],
        "approval-required"
    );
    assert_eq!(snapshot["configuration"]["manageOtherThreads"], false);
    let snapshot = call(
        &mut supervisor,
        "configure",
        json!({"actor":"user","manageOtherThreads":true}),
    );
    assert_eq!(snapshot["configuration"]["manageOtherThreads"], true);
    assert!(snapshot["configuration"]["checkInMinutes"].is_null());
    let snapshot = call(
        &mut supervisor,
        "configure",
        json!({"actor":"user","checkInMinutes":30}),
    );
    assert_eq!(snapshot["configuration"]["checkInMinutes"], 30);
    assert!(
        supervisor
            .call_at("configure", json!({"actor":"user","checkInMinutes":0}), NOW)
            .is_err()
    );
    let snapshot = call(
        &mut supervisor,
        "configure",
        json!({"actor":"user","labels":{"coordinatorSingular":"Director","threadSingular":"Workshop"}}),
    );
    assert_eq!(
        snapshot["configuration"]["labels"]["coordinatorSingular"],
        "Director"
    );
    assert_eq!(snapshot["pause"]["label"], "Pause all");
    assert!(
        supervisor
            .call_at(
                "configure",
                json!({"actor":"user","labels":{"profileSingular":"bad\nlabel"}}),
                NOW
            )
            .is_err()
    );
    assert!(
        supervisor
            .call_at("pause", json!({"actor":"coordinator"}), NOW)
            .is_err()
    );
    assert_eq!(
        call(&mut supervisor, "pause", json!({"actor":"user",}))["pause"]["label"],
        "Resume all"
    );
    assert!(
        supervisor
            .call_at("resume", json!({"actor":"coordinator"}), NOW)
            .is_err()
    );
}

#[test]
fn idempotency_binds_intent_and_claim_prevents_duplicate_execution() {
    let mut supervisor = ready();
    let prepared = prepare(&mut supervisor, "one");
    assert_eq!(prepare(&mut supervisor, "one")["deduplicated"], true);
    let mut different = assignment("one");
    different["route"]["model"] = json!("other-model");
    assert!(
        supervisor
            .call_at("assignments.prepare", json!({"assignment":different}), NOW)
            .is_err()
    );
    call(
        &mut supervisor,
        "actions.claim",
        json!({"id":prepared["action"]["id"]}),
    );
    assert!(
        supervisor
            .call_at("actions.claim", json!({"id":prepared["action"]["id"]}), NOW)
            .is_err()
    );
    assert!(
        supervisor
            .call_at(
                "actions.ack",
                json!({"id":prepared["action"]["id"],"status":"completed","result":{}}),
                NOW
            )
            .is_err()
    );
    call(
        &mut supervisor,
        "actions.ack",
        json!({"id":prepared["action"]["id"],"status":"uncertain"}),
    );
    let snapshot = call(&mut supervisor, "snapshot", json!({}));
    assert_eq!(snapshot["assignments"][0]["status"], "uncertain");
    assert!(
        supervisor
            .call_at("actions.claim", json!({"id":prepared["action"]["id"]}), NOW)
            .is_err()
    );
}

#[test]
fn dispatch_pause_race_closes_gate_and_queued_work_requires_fresh_reservation() {
    let mut supervisor = ready();
    let prepared = prepare(&mut supervisor, "one");
    call(&mut supervisor, "pause", json!({"actor":"user",}));
    assert!(
        supervisor
            .call_at("actions.claim", json!({"id":prepared["action"]["id"]}), NOW)
            .is_err()
    );
    assert!(pending(&mut supervisor, "pause").is_empty());
    call(&mut supervisor, "resume", json!({"actor":"user",}));
    assert!(
        supervisor
            .call_at("actions.claim", json!({"id":prepared["action"]["id"]}), NOW)
            .is_err()
    );
    call(
        &mut supervisor,
        "assignments.revalidate",
        json!({"id":"one","instructionRevision":1,"reservation":{"id":"new-reservation","owner":"t3:local","expiresAt":NOW+60_000,"policyRevision":"policy-v2","sharedCapacity":true}}),
    );
    assert_eq!(
        call(
            &mut supervisor,
            "actions.claim",
            json!({"id":prepared["action"]["id"]})
        )["claimed"],
        true
    );
}

#[test]
fn in_flight_dispatch_pause_targets_real_child_after_receipt_not_parent() {
    let mut supervisor = ready();
    let prepared = prepare(&mut supervisor, "one");
    call(
        &mut supervisor,
        "actions.claim",
        json!({"id":prepared["action"]["id"]}),
    );
    call(&mut supervisor, "pause", json!({"actor":"user",}));
    assert!(pending(&mut supervisor, "pause").is_empty());
    call(
        &mut supervisor,
        "cards.sync",
        json!({"cards":[card("child")]}),
    );
    call(
        &mut supervisor,
        "actions.ack",
        json!({"id":prepared["action"]["id"],"status":"completed","result":{"cardId":"child","status":"running","receipt":{"id":"receipt"},"executionId":"turn"}}),
    );
    let actions = pending(&mut supervisor, "pause");
    assert_eq!(actions.len(), 1);
    assert_eq!(actions[0]["threadId"], "child");
    call(
        &mut supervisor,
        "actions.claim",
        json!({"id":actions[0]["id"]}),
    );
    call(
        &mut supervisor,
        "actions.ack",
        json!({"id":actions[0]["id"],"status":"unsupported"}),
    );
    assert_eq!(
        call(&mut supervisor, "snapshot", json!({}))["assignments"][0]["pauseStatus"],
        "pause unsupported"
    );
    // The next observed spend report keeps it, and requests no second pause.
    call(
        &mut supervisor,
        "assignments.update",
        json!({"id":"one","spend":{"micros":0,"seconds":5}}),
    );
    assert_eq!(
        call(&mut supervisor, "snapshot", json!({}))["assignments"][0]["pauseStatus"],
        "pause unsupported"
    );
    assert!(pending(&mut supervisor, "pause").is_empty());
    call(&mut supervisor, "resume", json!({"actor":"user",}));
    assert!(pending(&mut supervisor, "resume").is_empty());
}

#[test]
fn resume_all_preserves_independent_pauses_and_only_resumes_confirmed_group_pauses() {
    let mut supervisor = ready();
    running(&mut supervisor, "one");
    running(&mut supervisor, "two");
    call(
        &mut supervisor,
        "assignments.update",
        json!({"id":"two","status":"paused","independentlyPaused":true}),
    );
    call(&mut supervisor, "pause", json!({"actor":"user",}));
    let actions = pending(&mut supervisor, "pause");
    assert_eq!(actions.len(), 1);
    call(
        &mut supervisor,
        "actions.claim",
        json!({"id":actions[0]["id"]}),
    );
    call(
        &mut supervisor,
        "actions.ack",
        json!({"id":actions[0]["id"],"status":"completed","result":{"resumeSupported":true}}),
    );
    call(&mut supervisor, "resume", json!({"actor":"user",}));
    let actions = pending(&mut supervisor, "resume");
    assert_eq!(actions.len(), 1);
    assert_eq!(actions[0]["assignmentId"], "one");
    assert_eq!(
        call(&mut supervisor, "assignments.list", json!({}))["items"][1]["independentlyPaused"],
        true
    );
}

#[test]
fn direct_instruction_and_settlement_invalidate_stale_dispatch() {
    let mut supervisor = ready();
    let prepared = prepare(&mut supervisor, "one");
    call(&mut supervisor, "cards.settle", json!({"id":"parent"}));
    assert!(
        supervisor
            .call_at("actions.claim", json!({"id":prepared["action"]["id"]}), NOW)
            .is_err()
    );
    assert!(
        call(&mut supervisor, "snapshot", json!({}))["cards"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        call(&mut supervisor, "cards.list", json!({"history":true}))["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    call(&mut supervisor, "cards.reopen", json!({"id":"parent"}));
    assert_eq!(
        call(&mut supervisor, "snapshot", json!({}))["cards"][0]["stale"],
        true
    );
    let mut changed = card("parent");
    changed["instructionRevision"] = json!(2);
    call(&mut supervisor, "cards.sync", json!({"cards":[changed]}));
    assert!(
        supervisor
            .call_at("actions.claim", json!({"id":prepared["action"]["id"]}), NOW)
            .is_err()
    );
}

fn full_policy(supervisor: &mut Supervisor) -> u64 {
    call(
        supervisor,
        "permissions.set",
        json!({"actor":"user","policy":{"id":"global","mode":"full","scope":{"kind":"global","id":null}}}),
    )["policyRevision"]
        .as_u64()
        .unwrap()
}

/// The host answers only for delegated work inside a grant.
fn delegated(supervisor: &mut Supervisor) {
    let mut card = card("delegated");
    card["assignmentId"] = json!("work");
    call(supervisor, "cards.sync", json!({"cards":[card]}));
    call(
        supervisor,
        "grants.set",
        json!({"actor":"user","grant":{"id":"delegated","scope":{"kind":"assignment","id":"work"},"maxAccess":2}}),
    );
}

fn permission_request(supervisor: &mut Supervisor, id: &str) {
    call(
        supervisor,
        "permissions.request",
        json!({"request":{"id":id,"cardId":"delegated","category":"filesystem.write","resource":"workspace/file","accessIncreaseUnknown":false,"requestedAccess":2,"currentAccess":1,"destinationMaxAccess":2,"supported":true}}),
    );
}

#[test]
fn permission_revocation_invalidates_queued_decisions_and_direct_user_response_wins() {
    let mut supervisor = ready();
    delegated(&mut supervisor);
    let grant = full_policy(&mut supervisor);
    assert_eq!(
        call(&mut supervisor, "snapshot", json!({}))["configuration"]["permissionMode"],
        "full"
    );
    permission_request(&mut supervisor, "request-one");
    call(
        &mut supervisor,
        "permissions.decide",
        json!({"requestId":"request-one","decision":"approve","actor":"coordinator","grantRevision":grant}),
    );
    let old_action = pending(&mut supervisor, "permission.respond")[0].clone();
    call(
        &mut supervisor,
        "permissions.set",
        json!({"actor":"user","policy":{"id":"global","mode":"ask","scope":{"kind":"global","id":null}}}),
    );
    assert!(
        supervisor
            .call_at("actions.claim", json!({"id":old_action["id"]}), NOW)
            .is_err()
    );
    assert_eq!(
        call(&mut supervisor, "snapshot", json!({}))["permissionRequests"][0]["status"],
        "pending"
    );
    let grant = full_policy(&mut supervisor);
    call(
        &mut supervisor,
        "permissions.decide",
        json!({"requestId":"request-one","decision":"approve","actor":"coordinator","grantRevision":grant}),
    );
    let action = pending(&mut supervisor, "permission.respond")[0].clone();
    call(
        &mut supervisor,
        "permissions.decide",
        json!({"requestId":"request-one","decision":"deny","actor":"user","alreadyAnswered":true}),
    );
    assert!(
        supervisor
            .call_at("actions.claim", json!({"id":action["id"]}), NOW)
            .is_err()
    );
}

#[test]
fn custom_policy_combines_project_environment_restrictions_and_explicit_thread_override() {
    let mut supervisor = ready();
    full_policy(&mut supervisor);
    call(
        &mut supervisor,
        "permissions.set",
        json!({"actor":"user","policy":{"id":"project","mode":"custom","scope":{"kind":"project","id":"project"},"delegateApproval":true,"maxAccess":2,"allowAccessIncrease":true,"rules":[{"category":"network","effect":"deny"}]}}),
    );
    call(
        &mut supervisor,
        "permissions.set",
        json!({"actor":"user","policy":{"id":"environment","mode":"full","scope":{"kind":"environment","id":"env"}}}),
    );
    let request = json!({"threadId":"parent","projectId":"project","environmentId":"env","category":"network","requestedAccess":1,"currentAccess":1,"destinationMaxAccess":2,"supported":true});
    assert_eq!(
        call(&mut supervisor, "permissions.effective", request.clone())["effect"],
        "deny"
    );
    call(
        &mut supervisor,
        "permissions.set",
        json!({"actor":"user","policy":{"id":"thread","mode":"full","scope":{"kind":"thread","id":"parent"}}}),
    );
    assert_eq!(
        call(&mut supervisor, "permissions.effective", request)["effect"],
        "allow"
    );
}

#[test]
fn exact_override_precedence_and_missing_effort_never_substitute() {
    let mut supervisor = ready();
    call(
        &mut supervisor,
        "overrides.set",
        json!({"actor":"user","override":{"id":"global","scope":{"kind":"global","id":null},"selection":{"model":"other"}}}),
    );
    call(
        &mut supervisor,
        "overrides.set",
        json!({"actor":"user","override":{"id":"thread","scope":{"kind":"thread","id":"parent"},"selection":{"model":"model","effort":"ultra"}}}),
    );
    let selection = call(
        &mut supervisor,
        "overrides.resolve",
        json!({"threadId":"parent"}),
    );
    assert_eq!(selection["selection"]["model"], "model");
    assert_eq!(selection["selection"]["effort"], "ultra");
    assert!(
        supervisor
            .call_at(
                "assignments.prepare",
                json!({"assignment":assignment("one")}),
                NOW
            )
            .is_err()
    );
    let mut pinned = assignment("one");
    pinned["route"]["effort"] = json!("ultra");
    assert!(
        supervisor
            .call_at("assignments.prepare", json!({"assignment":pinned}), NOW)
            .is_err()
    );
    call(
        &mut supervisor,
        "overrides.set",
        json!({"actor":"user","scope":{"kind":"thread","id":"parent"},"clear":true}),
    );
    assert_eq!(
        call(
            &mut supervisor,
            "overrides.resolve",
            json!({"threadId":"parent"})
        )["selection"]["model"],
        "other"
    );
}

#[test]
fn catalog_failures_do_not_retire_and_two_complete_omissions_preserve_manual_pin() {
    let mut supervisor = ready();
    call(
        &mut supervisor,
        "overrides.set",
        json!({"actor":"user","override":{"id":"pin","scope":{"kind":"global","id":null},"selection":{"model":"model"}}}),
    );
    call(
        &mut supervisor,
        "catalog.sync",
        json!({"sourceId":"provider","success":false}),
    );
    assert_eq!(
        call(&mut supervisor, "catalog.list", json!({}))["items"][0]["state"],
        "eligible"
    );
    call(
        &mut supervisor,
        "catalog.sync",
        json!({"sourceId":"provider","models":[]}),
    );
    assert_ne!(
        call(&mut supervisor, "catalog.list", json!({}))["items"][0]["state"],
        "retired"
    );
    call(
        &mut supervisor,
        "catalog.sync",
        json!({"sourceId":"provider","models":[]}),
    );
    assert_eq!(
        call(&mut supervisor, "catalog.list", json!({}))["items"][0]["state"],
        "retired"
    );
    assert_eq!(
        call(&mut supervisor, "overrides.resolve", json!({}))["selection"]["model"],
        "model"
    );
    call(
        &mut supervisor,
        "catalog.sync",
        json!({"sourceId":"provider","models":[model("model","local")]}),
    );
    assert_eq!(
        call(&mut supervisor, "catalog.list", json!({}))["items"][0]["state"],
        "eligible"
    );
}

#[test]
fn unsupported_catalog_and_unshared_capacity_are_ineligible() {
    let mut supervisor = ready();
    let mut unqualified = model("new-model", "local");
    unqualified["qualificationVerified"] = json!(false);
    unqualified["identityVerified"] = json!(false);
    unqualified["priceMicros"] = Value::Null;
    call(
        &mut supervisor,
        "catalog.sync",
        json!({"sourceId":"provider","complete":false,"models":[unqualified]}),
    );
    let mut requested = assignment("one");
    requested["route"]["model"] = json!("new-model");
    assert!(
        supervisor
            .call_at(
                "assignments.prepare",
                json!({"assignment":requested.clone()}),
                NOW
            )
            .is_err()
    );
    call(
        &mut supervisor,
        "overrides.set",
        json!({"actor":"user","override":{"id":"explicit","scope":{"kind":"global","id":null},"selection":{"model":"new-model"}}}),
    );
    requested["reservation"]["sharedCapacity"] = json!(false);
    assert!(
        supervisor
            .call_at("assignments.prepare", json!({"assignment":requested}), NOW)
            .is_err()
    );
}

#[test]
fn progress_checkins_are_event_driven_coalesced_and_escalate_after_two_unusable_responses() {
    let mut supervisor = ready();
    running(&mut supervisor, "one");
    assert!(
        call(&mut supervisor, "tick", json!({}))["due"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let later = NOW + 16 * 60 * 1000;
    supervisor.call_at("tick", json!({}), later).unwrap();
    supervisor.call_at("tick", json!({}), later).unwrap();
    let actions = pending(&mut supervisor, "inspect");
    assert_eq!(actions.len(), 1);
    supervisor
        .call_at("actions.claim", json!({"id":actions[0]["id"]}), later)
        .unwrap();
    supervisor
        .call_at(
            "actions.ack",
            json!({"id":actions[0]["id"],"status":"unreachable"}),
            later,
        )
        .unwrap();
    assert_eq!(
        call(&mut supervisor, "assignments.list", json!({}))["items"][0]["status"],
        "running"
    );
    let later = later + 16 * 60 * 1000;
    supervisor.call_at("tick", json!({}), later).unwrap();
    let actions = pending(&mut supervisor, "inspect");
    supervisor
        .call_at("actions.claim", json!({"id":actions[0]["id"]}), later)
        .unwrap();
    supervisor.call_at("actions.ack",json!({"id":actions[0]["id"],"status":"completed","result":{"meaningfulProgress":false}}),later).unwrap();
    assert_eq!(
        call(&mut supervisor, "assignments.list", json!({}))["items"][0]["status"],
        "blocked"
    );
}

#[test]
fn restart_preserves_pause_uncertain_receipts_and_claim_ownership() -> Result<(), Error> {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let directory =
        std::env::temp_dir().join(format!("t3-coordinator-{}-{unique}", std::process::id()));
    let path = directory.join("supervisor.sqlite");
    {
        let mut supervisor = Supervisor::open(&path)?;
        call(
            &mut supervisor,
            "configure",
            json!({"actor":"user","enabled":true}),
        );
        call(
            &mut supervisor,
            "cards.sync",
            json!({"cards":[card("parent")]}),
        );
        call(
            &mut supervisor,
            "catalog.sync",
            json!({"sourceId":"provider","models":[model("model","local")]}),
        );
        let prepared = prepare(&mut supervisor, "one");
        call(
            &mut supervisor,
            "actions.claim",
            json!({"id":prepared["action"]["id"]}),
        );
        call(&mut supervisor, "pause", json!({"actor":"user",}));
    }
    {
        let mut supervisor = Supervisor::open(&path)?;
        let snapshot = call(&mut supervisor, "snapshot", json!({}));
        assert_eq!(snapshot["pause"]["active"], true);
        assert_eq!(snapshot["pendingActions"][0]["status"], "claimed");
        assert!(
            supervisor
                .call_at(
                    "actions.claim",
                    json!({"id":snapshot["pendingActions"][0]["id"]}),
                    NOW
                )
                .is_err()
        );
    }
    std::fs::remove_dir_all(directory).map_err(Error::internal)?;
    Ok(())
}

#[test]
fn independent_review_closes_a_goal_only_with_host_bound_canonical_evidence() {
    let mut supervisor = ready();
    call(
        &mut supervisor,
        "goals.upsert",
        json!({"goal":{"id":"outcome","purpose":"Deliver the report","acceptanceCriteria":["Report meets requirements"],"authorizedScope":["project"]}}),
    );
    call(
        &mut supervisor,
        "cards.sync",
        json!({"cards":[card("source-card"),card("review-card")]}),
    );
    let mut failed = assignment("failed-attempt");
    failed["goalId"] = json!("outcome");
    let failed_preparation = call(
        &mut supervisor,
        "assignments.prepare",
        json!({"assignment":failed}),
    );
    call(
        &mut supervisor,
        "actions.claim",
        json!({"id":failed_preparation["action"]["id"]}),
    );
    call(
        &mut supervisor,
        "actions.ack",
        json!({"id":failed_preparation["action"]["id"],"status":"failed","result":{"reason":"Launch failed before execution"}}),
    );
    let failed = call(
        &mut supervisor,
        "assignments.get",
        json!({"id":"failed-attempt"}),
    )["assignment"]
        .clone();
    let supersessions = json!([{"assignmentId":"failed-attempt","replacementAssignmentId":"source","digest":"c".repeat(64),"sourceRevision":failed["revision"]}]);
    let mut source = assignment("source");
    source["goalId"] = json!("outcome");
    source["rank"] = json!("A");
    source["skills"] = json!(["analysis"]);
    source["supersedes"] = json!(["failed-attempt"]);
    let prepared = call(
        &mut supervisor,
        "assignments.prepare",
        json!({"assignment":source}),
    );
    call(
        &mut supervisor,
        "actions.claim",
        json!({"id":prepared["action"]["id"]}),
    );
    call(
        &mut supervisor,
        "actions.ack",
        json!({"id":prepared["action"]["id"],"status":"completed","result":{"status":"running","receipt":{"id":"source-receipt"},"executionId":"source-run","cardId":"source-card"}}),
    );
    call(
        &mut supervisor,
        "assignments.update",
        json!({"id":"source","status":"completed"}),
    );
    let subjects =
        json!([{"assignmentId":"source","executionId":"source-run","digest":"a".repeat(64)}]);
    let mut reviewer = assignment("review");
    reviewer["goalId"] = json!("outcome");
    reviewer["role"] = json!("reviewer");
    reviewer["route"]["model"] = json!("review-model");
    reviewer["rank"] = json!("A");
    reviewer["reviewSubjects"] = subjects.clone();
    reviewer["reviewGoalDigest"] = json!("b".repeat(64));
    reviewer["reviewSupersessions"] = supersessions.clone();
    let prepared = call(
        &mut supervisor,
        "assignments.prepare",
        json!({"assignment":reviewer}),
    );
    assert_eq!(prepared["assignment"]["role"], "reviewer");
    assert_eq!(prepared["assignment"]["rank"], "A");
    call(
        &mut supervisor,
        "actions.claim",
        json!({"id":prepared["action"]["id"]}),
    );
    call(
        &mut supervisor,
        "actions.ack",
        json!({"id":prepared["action"]["id"],"status":"completed","result":{"status":"running","receipt":{"id":"review-receipt"},"executionId":"review-run","cardId":"review-card"}}),
    );
    call(
        &mut supervisor,
        "assignments.update",
        json!({"id":"review","status":"completed"}),
    );
    let goal = call(&mut supervisor, "goals.list", json!({}))["items"][0].clone();
    let mut resolution = json!({"id":"outcome","expectedGoalRevision":goal["revision"],"reviewerAssignmentId":"review","reviewerReceipt":{"assignmentId":"review","executionId":"review-run","digest":"d".repeat(64)},"subjects":subjects,"supersessions":supersessions,"integrationOwner":"source","evidence":[format!("review:review:review-run:{}", "d".repeat(64))]});
    assert!(
        supervisor
            .call_at("goals.resolve", resolution.clone(), NOW)
            .is_err()
    );
    assert_eq!(
        call(&mut supervisor, "assignments.get", json!({"id":"source"}))["assignment"]["status"],
        "completed"
    );
    resolution["hostVerified"] = json!(true);
    let mut changed = resolution.clone();
    changed["supersessions"][0]["sourceRevision"] = json!(0);
    assert!(supervisor.call_at("goals.resolve", changed, NOW).is_err());
    let mut wrong_reviewer = resolution.clone();
    wrong_reviewer["reviewerReceipt"]["executionId"] = json!("unrelated-run");
    assert!(
        supervisor
            .call_at("goals.resolve", wrong_reviewer, NOW)
            .is_err()
    );
    assert!(pending(&mut supervisor, "outcome.accepted").is_empty());
    assert_eq!(
        call(&mut supervisor, "goals.resolve", resolution)["goal"]["status"],
        "completed"
    );
    let feedback = pending(&mut supervisor, "outcome.accepted");
    assert_eq!(feedback.len(), 1);
    let feedback = &feedback[0];
    assert_eq!(
        feedback["payload"]["event"]["subjects"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        feedback["payload"]["event"]["subjects"][0]["assignmentId"],
        "source"
    );
    assert_eq!(
        feedback["payload"]["event"]["reviewer"]["executionId"],
        "review-run"
    );
    assert_eq!(feedback["payload"]["event"]["goalDigest"], "b".repeat(64));
    call(&mut supervisor, "pause", json!({"actor":"user",}));
    call(
        &mut supervisor,
        "actions.claim",
        json!({"id":feedback["id"]}),
    );
    call(
        &mut supervisor,
        "actions.ack",
        json!({"id":feedback["id"],"status":"uncertain","result":{"reason":"lost destination reply"}}),
    );
    let replay = call(
        &mut supervisor,
        "actions.claim",
        json!({"id":feedback["id"]}),
    );
    assert_eq!(
        replay["action"]["payload"]["event"],
        feedback["payload"]["event"]
    );
    assert!(supervisor.call_at("actions.ack", json!({"id":feedback["id"],"status":"completed","result":{"eventId":"another-event","digest":"e".repeat(64)}}), NOW).is_err());
    call(
        &mut supervisor,
        "actions.ack",
        json!({"id":feedback["id"],"status":"completed","result":{"eventId":feedback["id"],"digest":"e".repeat(64)}}),
    );
    assert!(pending(&mut supervisor, "outcome.accepted").is_empty());
    let preserved = call(
        &mut supervisor,
        "assignments.get",
        json!({"id":"failed-attempt"}),
    )["assignment"]
        .clone();
    assert_eq!(preserved, failed);
    assert_eq!(
        call(&mut supervisor, "assignments.get", json!({"id":"source"}))["assignment"]["status"],
        "verified"
    );
}

#[test]
fn durable_history_is_project_scoped_and_pages_settled_cloud_cards() {
    let mut supervisor = ready();
    let mut cloud = card("cloud:codex:task");
    cloud["threadId"] = json!("task");
    cloud["environmentId"] = json!("cloud:codex");
    cloud["settled"] = json!(true);
    let mut other = card("another");
    other["projectId"] = json!("other-project");
    call(
        &mut supervisor,
        "cards.sync",
        json!({"cards":[cloud,other]}),
    );
    let page = call(
        &mut supervisor,
        "cards.list",
        json!({"projectId":"project","history":true,"settled":true,"limit":1}),
    );
    assert_eq!(page["items"].as_array().unwrap().len(), 1);
    assert_eq!(page["items"][0]["threadId"], "task");
    assert_eq!(
        call(&mut supervisor, "cards.find", json!({"threadId":"task"}))["card"]["settled"],
        true
    );
    assert!(
        call(
            &mut supervisor,
            "cards.list",
            json!({"projectId":"other-project' OR 1=1 --","history":true})
        )["items"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn partial_projection_sync_preserves_supervisor_metadata_and_ignores_unchanged_cards() {
    let mut supervisor = ready();
    let mut accepted = card("accepted");
    accepted["assignmentId"] = json!("assignment");
    accepted["profileId"] = json!("profile");
    accepted["verified"] = json!(true);
    accepted["evidence"] = json!(["canonical-review"]);
    accepted["acceptanceCriteria"] = json!(["Result accepted"]);
    call(&mut supervisor, "cards.sync", json!({"cards":[accepted]}));
    let before = call(&mut supervisor, "cards.get", json!({"id":"accepted"}))["card"].clone();
    let result = call(
        &mut supervisor,
        "cards.sync",
        json!({"projection":true,"cards":[card("accepted")]}),
    );
    assert!(result["changed"].as_array().unwrap().is_empty());
    assert_eq!(
        call(&mut supervisor, "cards.get", json!({"id":"accepted"}))["card"],
        before
    );
    call(
        &mut supervisor,
        "cards.sync",
        json!({"cards":[{"id":"accepted","status":"completed"}]}),
    );
    let after = call(&mut supervisor, "cards.get", json!({"id":"accepted"}))["card"].clone();
    assert_eq!(after["assignmentId"], "assignment");
    assert_eq!(after["verified"], true);
    assert_eq!(after["evidence"], json!(["canonical-review"]));
    call(
        &mut supervisor,
        "cards.sync",
        json!({"projection":true,"cards":[{"id":"accepted","instructionRevision":2}]}),
    );
    assert_eq!(
        call(&mut supervisor, "cards.get", json!({"id":"accepted"}))["card"]["verified"],
        false
    );
}

#[test]
fn unknown_provider_access_expansion_requires_full_or_explicit_broader_scope() {
    let mut supervisor = ready();
    call(
        &mut supervisor,
        "permissions.set",
        json!({"actor":"user","policy":{"id":"limited","mode":"approve","scope":{"kind":"global","id":null}}}),
    );
    for category in [
        "permission",
        "file-read",
        "file-change",
        "command",
        "mcp-elicitation",
    ] {
        // A legacy normalized request has no native access bounds, including when current access
        // already equals the supported maximum. It must never masquerade as a known no-increase.
        let request = json!({"threadId":"parent","category":category,"requestedAccess":2,"currentAccess":2,"destinationMaxAccess":2,"supported":true});
        let effective = call(&mut supervisor, "permissions.effective", request.clone());
        assert_eq!(effective["effect"], "ask");
        assert_eq!(effective["accessIncreaseUnknown"], true);
        let mut known = request;
        known["accessIncreaseUnknown"] = json!(false);
        assert_eq!(
            call(&mut supervisor, "permissions.effective", known)["effect"],
            "allow"
        );
    }
    full_policy(&mut supervisor);
    let mut unknown = json!({"threadId":"parent","category":"permission","requestedAccess":1,"currentAccess":1,"destinationMaxAccess":2,"supported":true,"accessIncreaseUnknown":true});
    let effective = call(&mut supervisor, "permissions.effective", unknown.clone());
    assert_eq!(effective["effect"], "allow");
    assert_eq!(effective["requestedAccess"], 2);
    unknown["supported"] = json!(false);
    assert_eq!(
        call(&mut supervisor, "permissions.effective", unknown.clone())["effect"],
        "ask"
    );
    unknown["supported"] = json!(true);
    call(
        &mut supervisor,
        "permissions.set",
        json!({"actor":"user","policy":{"id":"bounded-custom","mode":"custom","scope":{"kind":"global","id":null},"delegateApproval":true,"allowAccessIncrease":true,"maxAccess":1,"rules":[{"category":"permission","effect":"allow"}]}}),
    );
    assert_eq!(
        call(&mut supervisor, "permissions.effective", unknown)["effect"],
        "ask"
    );
}

#[test]
fn conservative_access_refinement_invalidates_only_unclaimed_delegated_responses() {
    let mut supervisor = ready();
    delegated(&mut supervisor);
    let revision = call(
        &mut supervisor,
        "permissions.set",
        json!({"actor":"user","policy":{"id":"limited","mode":"approve","scope":{"kind":"global","id":null}}}),
    )["policyRevision"]
        .clone();
    let request = json!({"id":"refine","cardId":"delegated","category":"command","resource":"src","requestedAccess":1,"currentAccess":1,"destinationMaxAccess":2,"supported":true,"accessIncreaseUnknown":false});
    call(
        &mut supervisor,
        "permissions.request",
        json!({"request":request}),
    );
    call(
        &mut supervisor,
        "permissions.decide",
        json!({"requestId":"refine","decision":"approve","actor":"coordinator","grantRevision":revision}),
    );
    let queued = pending(&mut supervisor, "permission.respond")[0].clone();
    let refined = call(
        &mut supervisor,
        "permissions.request",
        json!({"request":{"id":"refine","cardId":"delegated","category":"command","resource":"src","requestedAccess":2,"currentAccess":1,"destinationMaxAccess":2,"supported":true,"accessIncreaseUnknown":true}}),
    );
    assert_eq!(refined["status"], "pending");
    assert_eq!(refined["requestedAccess"], 2);
    assert_eq!(refined["accessIncreaseUnknown"], true);
    assert!(pending(&mut supervisor, "permission.respond").is_empty());
    assert!(
        supervisor
            .call_at("actions.claim", json!({"id":queued["id"]}), NOW)
            .is_err()
    );
    assert_eq!(
        call(&mut supervisor, "permissions.effective", refined)["effect"],
        "ask"
    );
    let direct = json!({"id":"direct-user","cardId":"parent","category":"permission","requestedAccess":1,"currentAccess":1,"destinationMaxAccess":2,"supported":true,"accessIncreaseUnknown":false});
    call(
        &mut supervisor,
        "permissions.request",
        json!({"request":direct}),
    );
    call(
        &mut supervisor,
        "permissions.decide",
        json!({"requestId":"direct-user","decision":"approve","actor":"user"}),
    );
    let preserved = call(
        &mut supervisor,
        "permissions.request",
        json!({"request":{"id":"direct-user","cardId":"parent","category":"permission","requestedAccess":2,"currentAccess":1,"destinationMaxAccess":2,"supported":true,"accessIncreaseUnknown":true}}),
    );
    assert_eq!(preserved["actor"], "user");
    assert_eq!(preserved["decision"], "approve");
    assert_eq!(preserved["status"], "answering");
    assert_eq!(pending(&mut supervisor, "permission.respond").len(), 1);
}

fn routing_goal(supervisor: &mut Supervisor) {
    call(
        supervisor,
        "goals.upsert",
        json!({"goal":{"id":"routing-goal","purpose":"Finish the original scoped work","authorizedScope":["project"]}}),
    );
}
fn enqueue_routing(supervisor: &mut Supervisor, id: &str, task: &str) -> Value {
    call(supervisor,"routing.enqueue",json!({"id":id,"goalId":"routing-goal","cardId":"parent","instructionRevision":1,"intent":{"kind":"delegate","goalId":"routing-goal","parentThreadId":"parent","task":task,"title":"Work","target":{}}}))["routingIntent"].clone()
}
#[test]
fn capacity_wait_retries_keep_one_thread_identity_and_never_reroute_uncertain_dispatch() {
    let mut supervisor = ready();
    routing_goal(&mut supervisor);
    let entry = enqueue_routing(&mut supervisor, "queued-thread", "Do the scoped task");
    assert_eq!(
        enqueue_routing(&mut supervisor, "duplicate", "Do the scoped task")["id"],
        entry["id"]
    );
    let first = call(
        &mut supervisor,
        "routing.claim",
        json!({"id":"queued-thread"}),
    )["routingIntent"]
        .clone();
    assert_eq!(first["generation"], 1);
    assert_eq!(
        call(
            &mut supervisor,
            "routing.claim",
            json!({"id":"queued-thread"})
        )["claimed"],
        false
    );
    let next = supervisor
        .call_at("routing.claim", json!({"id":"queued-thread"}), NOW + 60001)
        .unwrap()["routingIntent"]
        .clone();
    assert_eq!(next["id"], first["id"]);
    assert_ne!(next["reservationKey"], first["reservationKey"]);
    let mut work = assignment("queued-thread");
    // The generic helper uses request:<id>; production routing intentionally keeps the
    // thread idempotency key equal to its durable routing intent across capacity attempts.
    work["idempotencyKey"] = json!("queued-thread");
    work["goalId"] = json!("routing-goal");
    work["reservation"]["expiresAt"] = json!(NOW + 180000);
    assert!(supervisor.call_at("assignments.prepare",json!({"routingIntentId":"queued-thread","routingGeneration":first["generation"],"assignment":work}),NOW+60001).is_err());
    assert!(
        supervisor
            .call_at(
                "assignments.get",
                json!({"id":"queued-thread"}),
                NOW + 60001
            )
            .is_err()
    );
    let prepared=supervisor.call_at("assignments.prepare",json!({"routingIntentId":"queued-thread","routingGeneration":next["generation"],"assignment":work}),NOW+60001).unwrap();
    assert_eq!(prepared["assignment"]["idempotencyKey"], "queued-thread");
    assert_eq!(pending(&mut supervisor, "dispatch").len(), 1);
    supervisor
        .call_at(
            "actions.claim",
            json!({"id":prepared["action"]["id"]}),
            NOW + 60002,
        )
        .unwrap();
    supervisor
        .call_at(
            "actions.ack",
            json!({"id":prepared["action"]["id"],"status":"uncertain"}),
            NOW + 60002,
        )
        .unwrap();
    let claimed = supervisor
        .call_at("routing.claim", json!({"id":"queued-thread"}), NOW + 180000)
        .unwrap();
    assert_eq!(claimed["claimed"], false);
    assert_eq!(claimed["routingIntent"]["status"], "prepared");
    assert!(
        supervisor
            .call_at("routing.ready", json!({"limit":5}), NOW + 180000)
            .unwrap()["items"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        call(
            &mut supervisor,
            "assignments.get",
            json!({"id":"queued-thread"})
        )["assignment"]["status"],
        "uncertain"
    );
}
#[test]
fn routing_wait_pause_resume_revalidates_current_grants_and_source_edits_cancel() {
    let mut supervisor = ready();
    routing_goal(&mut supervisor);
    enqueue_routing(&mut supervisor, "waiting", "Do the scoped task");
    call(&mut supervisor, "pause", json!({"actor":"user",}));
    assert_eq!(
        call(&mut supervisor, "routing.claim", json!({"id":"waiting"}))["claimed"],
        false
    );
    assert!(
        call(&mut supervisor, "routing.ready", json!({"limit":5}))["items"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let grant = full_policy(&mut supervisor);
    call(&mut supervisor, "resume", json!({"actor":"user",}));
    let claimed = call(&mut supervisor, "routing.claim", json!({"id":"waiting"}));
    assert_eq!(claimed["claimed"], true);
    assert_eq!(claimed["routingIntent"]["grantRevision"], grant);
    assert_eq!(
        claimed["routingIntent"]["pauseRevision"],
        call(&mut supervisor, "snapshot", json!({}))["pause"]["revision"]
    );
    let mut changed = card("parent");
    changed["instructionRevision"] = json!(2);
    call(&mut supervisor, "cards.sync", json!({"cards":[changed]}));
    let claimed = supervisor
        .call_at("routing.claim", json!({"id":"waiting"}), NOW + 60001)
        .unwrap();
    assert_eq!(claimed["claimed"], false);
    assert_eq!(claimed["routingIntent"]["status"], "cancelled");
    assert!(pending(&mut supervisor, "dispatch").is_empty());
}
#[test]
fn restart_before_prepare_retries_only_capacity_without_creating_an_execution() -> Result<(), Error>
{
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let directory =
        std::env::temp_dir().join(format!("t3-head-routing-{}-{unique}", std::process::id()));
    let path = directory.join("supervisor.sqlite");
    let previous;
    {
        let mut supervisor = Supervisor::open(&path)?;
        call(
            &mut supervisor,
            "configure",
            json!({"actor":"user","enabled":true}),
        );
        call(
            &mut supervisor,
            "cards.sync",
            json!({"cards":[card("parent")]}),
        );
        routing_goal(&mut supervisor);
        enqueue_routing(&mut supervisor, "restart-thread", "Do the scoped task");
        previous = call(
            &mut supervisor,
            "routing.claim",
            json!({"id":"restart-thread"}),
        )["routingIntent"]
            .clone();
        assert!(pending(&mut supervisor, "dispatch").is_empty());
    }
    {
        let mut supervisor = Supervisor::open(&path)?;
        let due = supervisor.call_at("routing.ready", json!({"limit":5}), NOW + 60001)?;
        assert_eq!(due["items"][0]["id"], "restart-thread");
        let retry =
            supervisor.call_at("routing.claim", json!({"id":"restart-thread"}), NOW + 60001)?;
        assert_eq!(retry["routingIntent"]["id"], previous["id"]);
        assert_ne!(
            retry["routingIntent"]["reservationKey"],
            previous["reservationKey"]
        );
        assert!(
            supervisor
                .call_at(
                    "assignments.get",
                    json!({"id":"restart-thread"}),
                    NOW + 60001
                )
                .is_err()
        );
        assert!(pending(&mut supervisor, "dispatch").is_empty());
    }
    std::fs::remove_dir_all(directory).map_err(Error::internal)?;
    Ok(())
}
#[test]
fn routing_due_batch_is_bounded_and_oldest_wait_is_not_starved() {
    let mut supervisor = ready();
    routing_goal(&mut supervisor);
    for i in 0..6 {
        enqueue_routing(
            &mut supervisor,
            &format!("queued-{i}"),
            &format!("Task {i}"),
        );
    }
    let due = call(&mut supervisor, "routing.ready", json!({"limit":100}));
    assert_eq!(due["items"].as_array().unwrap().len(), 5);
    for entry in due["items"].as_array().unwrap() {
        call(&mut supervisor, "routing.claim", json!({"id":entry["id"]}));
    }
    let next = supervisor
        .call_at("routing.ready", json!({"limit":5}), NOW + 60000)
        .unwrap();
    assert_eq!(next["items"][0]["id"], "queued-5");
}

#[test]
fn changed_user_goal_invalidates_the_retained_routing_intent() {
    let mut supervisor = ready();
    routing_goal(&mut supervisor);
    enqueue_routing(&mut supervisor, "old-purpose", "Do the original task");
    call(
        &mut supervisor,
        "goals.upsert",
        json!({"goal":{"id":"routing-goal","purpose":"A different user request","authorizedScope":["project"]}}),
    );
    assert!(
        call(&mut supervisor, "routing.ready", json!({"limit":5}))["items"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        call(
            &mut supervisor,
            "routing.claim",
            json!({"id":"old-purpose"})
        )["routingIntent"]["status"],
        "cancelled"
    );
    assert!(pending(&mut supervisor, "dispatch").is_empty());
}

fn completed_goal_thread(supervisor: &mut Supervisor, work: Value) -> Value {
    terminal_goal_thread(supervisor, work, "completed")
}

fn terminal_goal_thread(supervisor: &mut Supervisor, mut work: Value, status: &str) -> Value {
    let id = work["id"].as_str().unwrap().to_owned();
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
    )["assignment"]
        .clone()
}
#[test]
fn negative_review_repair_re_review_completes_and_settles_only_current_proven_work() {
    let mut supervisor = ready();
    call(
        &mut supervisor,
        "goals.upsert",
        json!({"goal":{"id":"repair-goal","purpose":"Deliver the complete requested result","acceptanceCriteria":["Original purpose and integration verified"],"authorizedScope":["project"]}}),
    );
    let mut original = assignment("original");
    original["goalId"] = json!("repair-goal");
    let original = completed_goal_thread(&mut supervisor, original);
    let mut rejected = assignment("negative-review");
    rejected["goalId"] = json!("repair-goal");
    rejected["role"] = json!("reviewer");
    rejected["route"]["model"] = json!("review-model");
    rejected["reviewGoalDigest"] = json!("a".repeat(64));
    rejected["reviewSubjects"] =
        json!([{"assignmentId":"original","executionId":"run:original","digest":"a".repeat(64)}]);
    let rejected = completed_goal_thread(&mut supervisor, rejected);
    let goal = call(&mut supervisor, "goals.list", json!({}))["items"][0].clone();
    call(
        &mut supervisor,
        "goals.block",
        json!({"id":"repair-goal","expectedGoalRevision":goal["revision"]}),
    );
    let mut repaired = assignment("repair");
    repaired["goalId"] = json!("repair-goal");
    repaired["supersedes"] = json!(["original"]);
    call(&mut supervisor, "pause", json!({"actor":"user",}));
    assert!(
        supervisor
            .call_at("assignments.prepare", json!({"assignment":repaired}), NOW)
            .is_err()
    );
    call(&mut supervisor, "resume", json!({"actor":"user",}));
    completed_goal_thread(&mut supervisor, repaired);
    let subjects =
        json!([{"assignmentId":"repair","executionId":"run:repair","digest":"b".repeat(64)}]);
    let supersessions = json!([{"assignmentId":"original","replacementAssignmentId":"repair","digest":"c".repeat(64),"sourceRevision":original["revision"]},{"assignmentId":"negative-review","replacementAssignmentId":"final-review","digest":"d".repeat(64),"sourceRevision":rejected["revision"]}]);
    let mut final_review = assignment("final-review");
    final_review["goalId"] = json!("repair-goal");
    final_review["role"] = json!("reviewer");
    final_review["route"]["model"] = json!("review-model");
    final_review["reviewGoalDigest"] = json!("a".repeat(64));
    final_review["reviewSubjects"] = subjects.clone();
    final_review["reviewSupersessions"] = supersessions.clone();
    final_review["supersedes"] = json!(["negative-review"]);
    completed_goal_thread(&mut supervisor, final_review);
    let goal = call(&mut supervisor, "goals.list", json!({}))["items"][0].clone();
    assert_eq!(goal["status"], "blocked");
    let result = call(
        &mut supervisor,
        "goals.resolve",
        json!({"id":"repair-goal","expectedGoalRevision":goal["revision"],"hostVerified":true,"reviewerAssignmentId":"final-review","reviewerReceipt":{"assignmentId":"final-review","executionId":"run:final-review","digest":"e".repeat(64)},"subjects":subjects,"supersessions":supersessions,"integrationOwner":"repair","evidence":[format!("review:final-review:run:final-review:{}", "e".repeat(64))]}),
    );
    assert_eq!(result["goal"]["status"], "completed");
    assert_eq!(
        call(&mut supervisor, "assignments.get", json!({"id":"original"}))["assignment"],
        original
    );
    assert_eq!(
        call(
            &mut supervisor,
            "assignments.get",
            json!({"id":"negative-review"})
        )["assignment"],
        rejected
    );
    assert_eq!(
        call(&mut supervisor, "assignments.get", json!({"id":"repair"}))["assignment"]["status"],
        "verified"
    );
    let snapshot = call(&mut supervisor, "snapshot", json!({}));
    assert!(snapshot["goals"].as_array().unwrap().is_empty());
    assert!(
        snapshot["decisions"][0]["id"]
            .as_str()
            .unwrap()
            .starts_with("goal-resolution:")
    );
    let actions = pending(&mut supervisor, "thread.settle");
    assert_eq!(actions.len(), 4);
    let first = &actions[0];
    let first_card = first["payload"]["cardId"].as_str().unwrap();
    assert_eq!(
        call(&mut supervisor, "cards.get", json!({"id":first_card}))["card"]["settled"],
        false
    );
    call(&mut supervisor, "actions.claim", json!({"id":first["id"]}));
    call(
        &mut supervisor,
        "cards.sync",
        json!({"projection":true,"cards":[{"id":first_card,"settled":false}]}),
    );
    call(
        &mut supervisor,
        "actions.ack",
        json!({"id":first["id"],"status":"completed","result":{"settled":true,"cardId":first_card}}),
    );
    assert_eq!(
        call(&mut supervisor, "cards.get", json!({"id":first_card}))["card"]["settled"],
        true
    );
    let reopened = &actions[1];
    call(
        &mut supervisor,
        "cards.reopen",
        json!({"id":reopened["payload"]["cardId"]}),
    );
    let refused = call(
        &mut supervisor,
        "actions.claim",
        json!({"id":reopened["id"]}),
    );
    assert_eq!(refused["claimed"], false);
    assert_eq!(refused["action"]["status"], "invalidated");
    let changed = &actions[2];
    call(
        &mut supervisor,
        "cards.sync",
        json!({"projection":true,"cards":[{"id":changed["payload"]["cardId"],"instructionRevision":2}]}),
    );
    assert_eq!(
        call(
            &mut supervisor,
            "actions.claim",
            json!({"id":changed["id"]})
        )["claimed"],
        false
    );
    let recoverable = &actions[3];
    call(
        &mut supervisor,
        "actions.claim",
        json!({"id":recoverable["id"]}),
    );
    assert_eq!(
        call(
            &mut supervisor,
            "actions.claim",
            json!({"id":recoverable["id"]})
        )["claimed"],
        true
    );
    call(
        &mut supervisor,
        "actions.ack",
        json!({"id":recoverable["id"],"status":"completed","result":{"settled":true,"cardId":recoverable["payload"]["cardId"]}}),
    );
    assert_eq!(
        call(
            &mut supervisor,
            "cards.get",
            json!({"id":recoverable["payload"]["cardId"]})
        )["card"]["settled"],
        true
    );
    let mut forbidden = assignment("completed-goal-delegate");
    forbidden["goalId"] = json!("repair-goal");
    forbidden["pauseRevision"] = snapshot["pause"]["revision"].clone();
    assert!(
        supervisor
            .call_at("assignments.prepare", json!({"assignment":forbidden}), NOW)
            .is_err()
    );
}
#[test]
fn configure_permission_presets_use_real_policy_and_revoke_queued_full_approvals() {
    let mut supervisor = ready();
    delegated(&mut supervisor);
    let full = call(
        &mut supervisor,
        "configure",
        json!({"actor":"user","permissionMode":"full"}),
    );
    assert_eq!(full["configuration"]["permissionMode"], "full");
    assert_eq!(full["permissions"][0]["allowAccessIncrease"], true);
    permission_request(&mut supervisor, "preset-request");
    call(
        &mut supervisor,
        "permissions.decide",
        json!({"requestId":"preset-request","decision":"approve","actor":"coordinator","grantRevision":full["policyRevision"]}),
    );
    let action = pending(&mut supervisor, "permission.respond")[0].clone();
    let ask = call(
        &mut supervisor,
        "configure",
        json!({"actor":"user","permissionMode":"ask"}),
    );
    assert_eq!(ask["configuration"]["permissionMode"], "ask");
    assert_eq!(ask["permissions"][0]["delegateApproval"], false);
    assert!(pending(&mut supervisor, "permission.respond").is_empty());
    assert!(
        supervisor
            .call_at("actions.claim", json!({"id":action["id"]}), NOW)
            .is_err()
    );
    let approve = call(
        &mut supervisor,
        "configure",
        json!({"actor":"user","permissionMode":"approve"}),
    );
    assert_eq!(approve["permissions"][0]["delegateApproval"], true);
    assert_eq!(approve["permissions"][0]["allowAccessIncrease"], false);
    call(
        &mut supervisor,
        "permissions.set",
        json!({"actor":"user","policy":{"id":"my-custom","mode":"custom","scope":{"kind":"global","id":null},"delegateApproval":true,"allowAccessIncrease":false,"maxAccess":1,"rules":[{"category":"command","effect":"deny"}]}}),
    );
    let before = call(&mut supervisor, "snapshot", json!({}))["permissions"].clone();
    let after = call(
        &mut supervisor,
        "configure",
        json!({"actor":"user","permissionMode":"custom","labels":{"coordinatorSingular":"Coordinator"}}),
    );
    assert_eq!(after["permissions"], before);
    assert_eq!(after["configuration"]["permissionMode"], "custom");
}
#[test]
fn recent_decisions_keep_new_completion_visible_without_changing_id_cursor_history() {
    let mut supervisor = ready();
    for index in 0..105 {
        call(
            &mut supervisor,
            "decisions.record",
            json!({"decision":{"id":format!("a-{index:03}"),"summary":"Older cycle","provenance":"test","cardIds":["parent"]}}),
        );
    }
    call(
        &mut supervisor,
        "decisions.record",
        json!({"decision":{"id":"goal-resolution:latest","summary":"Verified completion","provenance":"canonical-independent-review","cardIds":["parent"],"goalIds":["finished"]}}),
    );
    assert_eq!(
        call(&mut supervisor, "snapshot", json!({"limit":100}))["decisions"][0]["id"],
        "goal-resolution:latest"
    );
    assert_eq!(
        call(&mut supervisor, "decisions.list", json!({"limit":1}))["items"][0]["id"],
        "a-000"
    );
}
#[test]
fn late_pause_ack_after_resume_enqueues_only_a_fenced_supported_resume() {
    let mut supervisor = ready();
    running(&mut supervisor, "late-pause");
    call(&mut supervisor, "pause", json!({"actor":"user",}));
    let pause = pending(&mut supervisor, "pause")[0].clone();
    call(&mut supervisor, "actions.claim", json!({"id":pause["id"]}));
    call(&mut supervisor, "resume", json!({"actor":"user",}));
    assert!(pending(&mut supervisor, "resume").is_empty());
    call(
        &mut supervisor,
        "actions.ack",
        json!({"id":pause["id"],"status":"completed","result":{"resumeSupported":true}}),
    );
    let resume = pending(&mut supervisor, "resume");
    assert_eq!(resume.len(), 1);
    assert_eq!(
        call(
            &mut supervisor,
            "actions.claim",
            json!({"id":resume[0]["id"]})
        )["claimed"],
        true
    );
    call(&mut supervisor, "pause", json!({"actor":"user",}));
    assert_eq!(
        call(&mut supervisor, "snapshot", json!({}))["pause"]["active"],
        true
    );
}

#[test]
fn open_assignments_page_past_the_snapshot_limit_without_finished_work() {
    let mut supervisor = ready();
    roomy(&mut supervisor);
    for value in 0..=100 {
        prepare(&mut supervisor, &format!("a{value:03}"));
    }
    call(
        &mut supervisor,
        "assignments.cancel",
        json!({"id":"a000","actor":"user"}),
    );
    let status =
        call(&mut supervisor, "assignments.get", json!({"id":"a000"}))["assignment"]["status"]
            .clone();
    let snapshot = call(&mut supervisor, "snapshot", json!({"limit":100}));
    let mut open = Vec::new();
    let mut cursor = Value::Null;
    loop {
        let page = call(
            &mut supervisor,
            "assignments.list",
            json!({"open":true,"limit":100,"cursor":cursor}),
        );
        open.extend(
            page["items"]
                .as_array()
                .unwrap()
                .iter()
                .map(|item| item["id"].clone()),
        );
        cursor = page["nextCursor"].clone();
        if cursor.is_null() {
            break;
        }
    }
    assert_eq!(status, "cancelled");
    assert_eq!(snapshot["assignments"].as_array().unwrap().len(), 100);
    assert_eq!(open.len(), 100);
    assert_eq!(open.first(), Some(&json!("a001")));
    assert_eq!(open.last(), Some(&json!("a100")));
}

#[test]
fn a_goal_past_the_snapshot_limit_is_read_directly() {
    let mut supervisor = ready();
    for value in 0..=100 {
        call(
            &mut supervisor,
            "goals.upsert",
            json!({"goal":{"id":format!("g{value:03}"),"purpose":"Deliver a verified result","authorizedScope":["project"]}}),
        );
    }
    let snapshot = call(&mut supervisor, "snapshot", json!({"limit":100}));
    assert_eq!(snapshot["goals"].as_array().unwrap().len(), 100);
    assert_eq!(snapshot["goals"][99]["id"], "g099");
    let goal = call(&mut supervisor, "goals.get", json!({"id":"g100"}))["goal"].clone();
    assert_eq!(goal["id"], "g100");
    assert_eq!(goal["authorizedScope"], json!(["project"]));
    assert!(
        supervisor
            .call_at("goals.get", json!({"id":"missing"}), NOW)
            .is_err()
    );
}

#[test]
fn a_user_approval_carries_the_operation_its_request_showed() {
    let mut supervisor = ready();
    call(
        &mut supervisor,
        "permissions.request",
        json!({"request":{"id":"shown","cardId":"parent","category":"command","requestedAccess":2,"currentAccess":0,"destinationMaxAccess":2,"supported":true,"operation":"vp test"}}),
    );
    call(
        &mut supervisor,
        "permissions.decide",
        json!({"requestId":"shown","decision":"approve","actor":"user"}),
    );
    assert_eq!(
        pending(&mut supervisor, "permission.respond")[0]["payload"]["operation"],
        "vp test"
    );
}

fn limit(supervisor: &mut Supervisor, limits: Value) {
    call(
        supervisor,
        "board.limits",
        json!({"actor":"user","limits":limits}),
    );
}

// Paging needs more open work than the default limits allow at once.
fn roomy(supervisor: &mut Supervisor) {
    limit(
        supervisor,
        json!({"inFlight":200,"perLogin":200,"localSlots":200}),
    );
}

#[test]
fn a_reviewer_on_the_model_of_the_work_it_reviews_is_refused() {
    let mut supervisor = ready();
    call(
        &mut supervisor,
        "goals.upsert",
        json!({"goal":{"id":"goal","purpose":"Ship it","acceptanceCriteria":["Works"],"authorizedScope":["project"]}}),
    );
    let mut author = assignment("author");
    author["goalId"] = json!("goal");
    completed_goal_thread(&mut supervisor, author);
    let mut reviewer = assignment("review");
    reviewer["goalId"] = json!("goal");
    reviewer["role"] = json!("reviewer");
    reviewer["reviewGoalDigest"] = json!("a".repeat(64));
    reviewer["reviewSubjects"] =
        json!([{"assignmentId":"author","executionId":"run:author","digest":"a".repeat(64)}]);
    let refused = supervisor
        .call_at("assignments.prepare", json!({"assignment":reviewer}), NOW)
        .unwrap_err();
    assert_eq!(refused.code, -32003);
    reviewer["route"]["model"] = json!("review-model");
    let prepared = call(
        &mut supervisor,
        "assignments.prepare",
        json!({"assignment":reviewer}),
    );
    assert_eq!(prepared["assignment"]["route"]["model"], "review-model");
}

#[test]
fn a_routed_delegation_at_a_cap_keeps_waiting_and_is_reported_once() {
    let mut supervisor = ready();
    routing_goal(&mut supervisor);
    budget(
        &mut supervisor,
        json!({"goalId":"routing-goal"}),
        json!({"seconds":0}),
    );
    enqueue_routing(&mut supervisor, "capped", "Do the scoped task");
    let claimed =
        call(&mut supervisor, "routing.claim", json!({"id":"capped"}))["routingIntent"].clone();
    let mut work = assignment("capped");
    work["idempotencyKey"] = json!("capped");
    work["goalId"] = json!("routing-goal");
    let blocked = call(
        &mut supervisor,
        "assignments.prepare",
        json!({"routingIntentId":"capped","routingGeneration":claimed["generation"],"assignment":work}),
    );
    assert_eq!(blocked["capped"], true);
    assert_eq!(budget_decisions(&mut supervisor), ["budget:routing-goal"]);
    let entry = call(
        &mut supervisor,
        "routing.defer",
        json!({"id":"capped","reason":"Waiting: cap"}),
    )["routingIntent"]
        .clone();
    assert_eq!(entry["status"], "waiting");
    assert_eq!(entry["reason"], "Waiting: cap");
}

#[test]
fn held_work_is_due_the_moment_an_assignment_ends() {
    let mut supervisor = ready();
    routing_goal(&mut supervisor);
    terminal_goal_thread(&mut supervisor, assignment("ending"), "running");
    enqueue_routing(&mut supervisor, "held", "Do the scoped task");
    call(&mut supervisor, "routing.claim", json!({"id":"held"}));
    call(
        &mut supervisor,
        "routing.defer",
        json!({"id":"held","reason":"Waiting: touches overlap"}),
    );
    let ready = |supervisor: &mut Supervisor| {
        call(supervisor, "routing.ready", json!({"limit":5}))["items"]
            .as_array()
            .unwrap()
            .len()
    };
    assert_eq!(ready(&mut supervisor), 0);
    call(
        &mut supervisor,
        "assignments.update",
        json!({"id":"ending","status":"completed"}),
    );
    assert_eq!(ready(&mut supervisor), 1);
}

#[test]
fn work_waiting_on_the_owner_past_the_park_time_frees_its_slot_and_login() {
    let mut supervisor = ready();
    let work = terminal_goal_thread(&mut supervisor, assignment("waiting"), "running");
    let mut receipt = work["receipt"].clone();
    receipt["blockedSince"] = json!(NOW);
    call(
        &mut supervisor,
        "assignments.update",
        json!({"id":"waiting","status":"blocked","receipt":receipt}),
    );
    let local = json!({"profileId":"p","instance":"replay","provider":"replay","model":"model","family":"f","effort":"high","destination":"local"});
    let counted = |supervisor: &mut Supervisor, minutes: u64| {
        let at = NOW + minutes * 60_000;
        let board = supervisor.call_at("board.next", json!({}), at).unwrap();
        let score = supervisor
            .call_at(
                "router.score",
                json!({"request":{"rank":"B","candidates":[local],"localSlots":1}}),
                at,
            )
            .unwrap();
        (
            board["capacity"]["inFlight"].clone(),
            score["pick"].is_null(),
        )
    };
    assert_eq!(counted(&mut supervisor, 29), (json!(1), true));
    assert_eq!(counted(&mut supervisor, 30), (json!(0), false));
    // Blocked for another reason (no owner wait recorded): it keeps its slot however long.
    call(
        &mut supervisor,
        "assignments.update",
        json!({"id":"waiting","status":"blocked","receipt":work["receipt"]}),
    );
    assert_eq!(counted(&mut supervisor, 31), (json!(1), true));
    call(
        &mut supervisor,
        "assignments.update",
        json!({"id":"waiting","status":"blocked","receipt":receipt}),
    );
    call(
        &mut supervisor,
        "configure",
        json!({"actor":"user","parkMinutes":60}),
    );
    assert_eq!(counted(&mut supervisor, 30), (json!(1), true));
    // Parked is not answered: it is still blocked, waiting for the owner.
    assert_eq!(
        call(&mut supervisor, "assignments.get", json!({"id":"waiting"}))["assignment"]["status"],
        "blocked"
    );
}

#[test]
fn the_owners_answer_resumes_parked_work_once_it_has_room_and_only_once() {
    let mut supervisor = ready();
    limit(
        &mut supervisor,
        json!({"inFlight":1,"perLogin":1,"localSlots":1}),
    );
    let work = terminal_goal_thread(&mut supervisor, assignment("parked"), "running");
    let mut receipt = work["receipt"].clone();
    receipt["blockedSince"] = json!(NOW);
    call(
        &mut supervisor,
        "assignments.update",
        json!({"id":"parked","status":"blocked","receipt":receipt}),
    );
    let mut child = card("thread:parked");
    child["assignmentId"] = json!("parked");
    call(&mut supervisor, "cards.sync", json!({"cards":[child]}));
    // Past the park time it holds no slot, and other work takes it.
    let later = NOW + 31 * 60_000;
    let at = |supervisor: &mut Supervisor, method: &str, params: Value| {
        supervisor
            .call_at(method, params, later)
            .unwrap_or_else(|error| panic!("{method}: {error}"))
    };
    let mut other = assignment("other");
    other["reservation"]["expiresAt"] = json!(later + 60_000);
    let prepared = at(
        &mut supervisor,
        "assignments.prepare",
        json!({"assignment":other}),
    );
    at(
        &mut supervisor,
        "actions.claim",
        json!({"id":prepared["action"]["id"]}),
    );
    at(
        &mut supervisor,
        "actions.ack",
        json!({"id":prepared["action"]["id"],"status":"completed","result":{"status":"running","receipt":{"id":"receipt:other"},"executionId":"turn:other"}}),
    );
    at(
        &mut supervisor,
        "permissions.request",
        json!({"request":{"id":"answer","cardId":"thread:parked","category":"filesystem.write","resource":"workspace/file","accessIncreaseUnknown":false,"requestedAccess":2,"currentAccess":1,"destinationMaxAccess":2,"supported":true}}),
    );
    at(
        &mut supervisor,
        "permissions.decide",
        json!({"requestId":"answer","decision":"approve","actor":"user"}),
    );
    let answer = pending(&mut supervisor, "permission.respond")[0]["id"].clone();
    let in_flight = |supervisor: &mut Supervisor| {
        supervisor.call_at("board.next", json!({}), later).unwrap()["capacity"]["inFlight"].clone()
    };
    // No room: the answer waits, undelivered, and the limit holds.
    let claim = |supervisor: &mut Supervisor| {
        supervisor
            .call_at("actions.claim", json!({"id":answer}), later)
            .map(|claimed| claimed["claimed"].clone())
    };
    assert_eq!(claim(&mut supervisor).unwrap(), false);
    assert_eq!(in_flight(&mut supervisor), json!(1));
    at(
        &mut supervisor,
        "assignments.update",
        json!({"id":"other","status":"completed"}),
    );
    assert_eq!(claim(&mut supervisor).unwrap(), true);
    // Resumed, it holds its slot again at once, and is delivered once.
    assert_eq!(in_flight(&mut supervisor), json!(1));
    assert!(claim(&mut supervisor).is_err());
    let resumed = at(&mut supervisor, "assignments.get", json!({"id":"parked"}));
    assert_eq!(resumed["assignment"]["receipt"]["blockedSeconds"], 31 * 60);
}

#[test]
fn running_work_of_unreported_use_spends_its_bench_estimate_and_trips_a_use_cap() {
    let mut supervisor = ready();
    call(
        &mut supervisor,
        "bench.set",
        json!({"actor":"user","bench":[{"model":"model","effort":"high","score":50,"costMicros":700}]}),
    );
    board_goal(&mut supervisor, "cloudy", &["cloudy.rs"], json!({}));
    budget(
        &mut supervisor,
        json!({"goalId":"cloudy"}),
        json!({"micros":500}),
    );
    terminal_goal_thread(
        &mut supervisor,
        goal_work("cloudy-work", "cloudy"),
        "running",
    );
    // Still running: the report carries no use, so the route's estimate counts.
    call(
        &mut supervisor,
        "assignments.update",
        json!({"id":"cloudy-work","spend":{"micros":null,"seconds":5}}),
    );
    let next = call(
        &mut supervisor,
        "assignments.prepare",
        json!({"assignment":goal_work("cloudy-next", "cloudy")}),
    );
    assert_eq!(next["capped"], true);
    assert_eq!(budget_decisions(&mut supervisor), ["budget:cloudy"]);
}

#[test]
fn the_coordinator_thread_proves_its_tools_once_per_instance_and_model() {
    let mut supervisor = Supervisor::open(Path::new(":memory:")).unwrap();
    let configuration = |supervisor: &mut Supervisor| {
        call(supervisor, "snapshot", json!({}))["configuration"].clone()
    };
    call(
        &mut supervisor,
        "configure",
        json!({"actor":"user","coordinatorProvider":"codex","coordinatorModel":"gpt"}),
    );
    let proof = |proved: bool| json!({"provider":"codex","model":"gpt","proved":proved,"reason":"No T3 tools"});
    // A proof names the instance and model the store holds.
    assert!(
        supervisor
            .call_at(
                "proof.record",
                json!({"provider":"claude","model":"gpt","proved":true}),
                NOW
            )
            .is_err()
    );
    call(&mut supervisor, "proof.record", proof(false));
    assert_eq!(
        configuration(&mut supervisor)["threadProof"]["reason"],
        "No T3 tools"
    );
    // A later turn shows nothing new until the tools are proved.
    call(
        &mut supervisor,
        "proof.record",
        json!({"provider":"codex","model":"gpt","proved":false,"reason":"Later"}),
    );
    assert_eq!(
        configuration(&mut supervisor)["threadProof"]["reason"],
        "No T3 tools"
    );
    call(&mut supervisor, "proof.record", proof(true));
    call(&mut supervisor, "proof.record", proof(false));
    assert_eq!(
        configuration(&mut supervisor)["threadProof"]["proved"],
        true
    );
    // Another model has to prove itself again.
    call(
        &mut supervisor,
        "configure",
        json!({"actor":"user","coordinatorModel":"other"}),
    );
    assert!(configuration(&mut supervisor)["threadProof"].is_null());
}

fn inbox(supervisor: &mut Supervisor, cursor: u64) -> Value {
    call(
        supervisor,
        "events.read",
        json!({"cursor":cursor,"limit":100}),
    )
}

#[test]
fn an_ended_assignment_is_an_event_and_the_coordinators_own_events_wake_nothing() {
    let mut supervisor = ready();
    running(&mut supervisor, "work");
    assert_eq!(
        call(&mut supervisor, "events.pending", json!({}))["kinds"],
        json!({})
    );
    call(
        &mut supervisor,
        "assignments.update",
        json!({"id":"work","status":"failed"}),
    );
    call(
        &mut supervisor,
        "events.append",
        json!({"actor":"coordinator","event":{"kind":"assignment","summary":"Its own"}}),
    );
    let pending = call(&mut supervisor, "events.pending", json!({}));
    assert_eq!(pending["kinds"], json!({"assignment":1}));
    // A wake's turn completed; nothing new is pending until another event comes.
    call(
        &mut supervisor,
        "events.woken",
        json!({"through":pending["through"]}),
    );
    let told = call(&mut supervisor, "events.pending", json!({}));
    assert_eq!(told["kinds"], json!({}));
    // Told is not read: it stays unread until coordinator_inbox reads it.
    assert_eq!(told["unread"], json!({"assignment":1}));
    let read = inbox(&mut supervisor, 0);
    assert_eq!(read["events"][0]["status"], "failed");
    assert_eq!(read["events"][0]["threadId"], "parent");
    assert_eq!(read["events"][1]["actor"], "coordinator");
}

#[test]
fn an_assignment_keeps_the_title_its_delegation_gave_for_its_thread() {
    let mut supervisor = ready();
    let mut titled = assignment("titled");
    titled["title"] = json!("multiply");
    let prepared = call(
        &mut supervisor,
        "assignments.prepare",
        json!({"assignment":titled}),
    );
    assert_eq!(
        prepared["action"]["payload"]["assignment"]["title"],
        "multiply"
    );
    // One stored before titles were kept has none, and reads as before.
    let plain = prepare(&mut supervisor, "plain");
    assert!(
        plain["action"]["payload"]["assignment"]
            .get("title")
            .is_none()
    );
}

#[test]
fn a_blocked_assignments_event_says_what_it_waits_for() {
    let mut supervisor = ready();
    running(&mut supervisor, "work");
    call(
        &mut supervisor,
        "assignments.update",
        json!({"id":"work","status":"blocked","reason":"An approval (command) waits in its thread."}),
    );
    let read = inbox(&mut supervisor, 0);
    assert_eq!(read["events"][0]["status"], "blocked");
    assert_eq!(
        read["events"][0]["reason"],
        "An approval (command) waits in its thread."
    );
}

#[test]
fn an_event_keeps_a_providers_long_request_id_as_its_subject() {
    let mut supervisor = ready();
    // A Claude runtime request id is some 340 characters: over an identifier, kept as data.
    let subject = "r".repeat(400);
    call(
        &mut supervisor,
        "events.append",
        json!({"eventId":"request:thread:sha256:0","actor":"host",
            "event":{"kind":"approval","threadId":"thread","subject":subject}}),
    );
    assert_eq!(inbox(&mut supervisor, 0)["events"][0]["subject"], subject);
}

#[test]
fn three_hundred_scripted_events_are_read_once_each_in_order_and_cut_after() {
    let mut supervisor = ready();
    for index in 0..300 {
        call(
            &mut supervisor,
            "events.append",
            json!({"actor":"host","event":{"kind":"request","threadId":format!("thread-{index}"),"summary":"Asks"}}),
        );
        // A read between appends must not lose what lands after it.
        if index % 37 == 0 {
            call(&mut supervisor, "events.pending", json!({}));
        }
    }
    let (mut cursor, mut seen) = (0, Vec::new());
    loop {
        let page = inbox(&mut supervisor, cursor);
        for event in page["events"].as_array().unwrap() {
            seen.push(event["threadId"].as_str().unwrap().to_owned());
        }
        cursor = page["nextCursor"].as_u64().unwrap();
        if page["more"] != true {
            break;
        }
    }
    assert_eq!(
        seen,
        (0..300).map(|i| format!("thread-{i}")).collect::<Vec<_>>()
    );
    assert_eq!(
        call(&mut supervisor, "events.pending", json!({}))["kinds"],
        json!({})
    );
    assert_eq!(inbox(&mut supervisor, cursor)["events"], json!([]));
    // Without a cursor, as after a compaction, the read goes on from what was read last.
    let resumed = call(&mut supervisor, "events.read", json!({"limit":100}));
    assert_eq!(resumed["events"], json!([]));
    assert_eq!(resumed["nextCursor"], cursor);
    // A cursor past what was handed out skips and cuts nothing.
    call(
        &mut supervisor,
        "events.append",
        json!({"actor":"host","event":{"kind":"request","threadId":"parent","summary":"Asks"}}),
    );
    assert_eq!(
        inbox(&mut supervisor, 1_000_000)["events"][0]["threadId"],
        "parent"
    );
    // What was read stays until its thread settles, then the next read cuts it.
    call(&mut supervisor, "cards.settle", json!({"id":"parent"}));
    inbox(&mut supervisor, 0);
    let left = inbox(&mut supervisor, 0);
    assert_eq!(left["events"].as_array().unwrap().len(), 100);
    assert_eq!(left["events"][0]["threadId"], "thread-0");
}

#[test]
fn with_the_coordinator_off_nothing_is_recorded() {
    let mut supervisor = ready();
    running(&mut supervisor, "work");
    call(
        &mut supervisor,
        "configure",
        json!({"actor":"user","enabled":false}),
    );
    call(
        &mut supervisor,
        "assignments.update",
        json!({"id":"work","status":"failed"}),
    );
    let appended = call(
        &mut supervisor,
        "events.append",
        json!({"actor":"host","event":{"kind":"request","summary":"Asks"}}),
    );
    assert!(appended["seq"].is_null());
    assert_eq!(inbox(&mut supervisor, 0)["events"], json!([]));
}

#[test]
fn what_a_turn_read_counts_only_once_it_completed() {
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let database =
        std::env::temp_dir().join(format!("t3-inbox-turns-{}-{unique}", std::process::id()));
    let mut supervisor = ready_at(&database);
    let append = |supervisor: &mut Supervisor, thread: &str| {
        call(
            supervisor,
            "events.append",
            json!({"actor":"host","event":{"kind":"question","threadId":thread}}),
        );
    };
    let read = |supervisor: &mut Supervisor, run: &str| {
        call(supervisor, "events.read", json!({"runId":run,"limit":100}))["events"]
            .as_array()
            .unwrap()
            .iter()
            .map(|event| event["threadId"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>()
    };
    append(&mut supervisor, "a");
    // Two reads in one turn hand nothing out twice.
    assert_eq!(read(&mut supervisor, "run-1"), ["a"]);
    assert!(read(&mut supervisor, "run-1").is_empty());
    // A turn stopped before it completed read nothing: the next turn gets it again.
    assert_eq!(read(&mut supervisor, "run-2"), ["a"]);
    // A turn that completed read it for good.
    call(&mut supervisor, "events.confirm", json!({"runId":"run-2"}));
    append(&mut supervisor, "b");
    assert_eq!(read(&mut supervisor, "run-3"), ["b"]);
    // A completed wake's turn confirms through events.woken; another turn's confirm changes nothing.
    call(&mut supervisor, "events.confirm", json!({"runId":"run-2"}));
    let pending = call(&mut supervisor, "events.pending", json!({}));
    call(
        &mut supervisor,
        "events.woken",
        json!({"through":pending["through"],"runId":"run-3"}),
    );
    append(&mut supervisor, "c");
    assert_eq!(read(&mut supervisor, "run-4"), ["c"]);
    // A restart in the middle of a turn: that turn never completes, so what it read comes back.
    drop(supervisor);
    let mut supervisor = Supervisor::open(&database).unwrap();
    assert_eq!(read(&mut supervisor, "run-5"), ["c"]);
    let _ = std::fs::remove_file(&database);
}
