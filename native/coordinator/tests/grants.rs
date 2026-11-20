use serde_json::{Value, json};
use std::path::Path;
use t3_coordinator::Supervisor;

const NOW: u64 = 1_000_000;

fn call(supervisor: &mut Supervisor, method: &str, params: Value) -> Value {
    supervisor
        .call_at(method, params, NOW)
        .unwrap_or_else(|error| panic!("{method}: {error}"))
}

fn refused(supervisor: &mut Supervisor, method: &str, params: Value) -> String {
    supervisor
        .call_at(method, params, NOW)
        .expect_err(method)
        .message
}

fn ready() -> Supervisor {
    let mut supervisor = Supervisor::open(Path::new(":memory:")).unwrap();
    call(
        &mut supervisor,
        "configure",
        json!({"actor":"user","enabled":true,"coordinatorProvider":"replay","coordinatorModel":"replay","coordinatorThreadId":"coordinator"}),
    );
    call(
        &mut supervisor,
        "cards.sync",
        json!({"cards":[{"id":"card","threadId":"thread","environmentId":"env","projectId":"project","purpose":"Build","status":"running","instructionRevision":1}]}),
    );
    supervisor
}

fn project_grant(folders: Value, delete: Value) -> Value {
    json!({"id":"grant","scope":{"kind":"project","id":"project"},"folders":folders,"delete":delete,"maxAccess":1})
}

/// The owner's message, numbered in the order it was typed, naming every path the tests use.
fn from_message(grant: Value, message: &str) -> Value {
    let at: u64 = message
        .trim_start_matches(|c: char| !c.is_ascii_digit())
        .parse()
        .unwrap();
    json!({"actor":"coordinator","sourceMessageId":message,"sourceMessageAt":at,"sourceMessageText":"Work in src, src/a and docs; delete src/old.ts and src/new.ts.","grant":grant})
}

const THREAD: &str =
    r#"{"threadId":"thread","projectId":"project","environmentId":"env","assignmentId":"work"}"#;

fn covering(supervisor: &mut Supervisor) -> Value {
    call(
        supervisor,
        "grants.resolve",
        serde_json::from_str(THREAD).unwrap(),
    )["grant"]
        .clone()
}

#[test]
fn the_coordinator_grants_only_on_a_message_the_owner_typed_and_never_more_than_it_said() {
    let mut supervisor = ready();
    let narrow = project_grant(json!(["src"]), json!(["src/old.ts"]));
    assert!(
        refused(
            &mut supervisor,
            "grants.set",
            json!({"actor":"coordinator","grant":narrow})
        )
        .contains("sourceMessageId")
    );
    assert!(
        refused(
            &mut supervisor,
            "grants.set",
            json!({"actor":"thread","grant":narrow})
        )
        .contains("actor")
    );
    let made = call(
        &mut supervisor,
        "grants.set",
        from_message(narrow.clone(), "message-1"),
    );
    assert_eq!(made["grant"]["sourceMessageId"], "message-1");
    assert_eq!(covering(&mut supervisor)["id"], "grant");
    // The same words cannot make a second grant.
    let mut other = narrow.clone();
    other["id"] = json!("other");
    assert!(
        refused(
            &mut supervisor,
            "grants.set",
            from_message(other, "message-1")
        )
        .contains("already")
    );
    // Each way of widening is the owner's.
    for wider in [
        project_grant(json!([]), json!(["src/old.ts"])),
        project_grant(json!(["src", "docs"]), json!(["src/old.ts"])),
        project_grant(json!(["src"]), json!(["src/old.ts", "src/new.ts"])),
        json!({"id":"grant","scope":{"kind":"project","id":"project"},"folders":["src"],"delete":["src/old.ts"],"maxAccess":2}),
        json!({"id":"grant","scope":{"kind":"project","id":"elsewhere"},"folders":["src"],"delete":["src/old.ts"],"maxAccess":1}),
    ] {
        assert!(
            refused(
                &mut supervisor,
                "grants.set",
                from_message(wider, "message-2")
            )
            .contains("widen")
        );
    }
    // Narrowing on the owner's later word is allowed.
    call(
        &mut supervisor,
        "grants.set",
        from_message(project_grant(json!(["src/a"]), json!([])), "message-3"),
    );
    // Nothing beyond one project, nothing for the Coordinator's own thread.
    for (scope, reason) in [
        (json!({"kind":"global","id":null}), "beyond one project"),
        (
            json!({"kind":"environment","id":"env"}),
            "beyond one project",
        ),
        (json!({"kind":"thread","id":"coordinator"}), "itself"),
    ] {
        assert!(
            refused(
                &mut supervisor,
                "grants.set",
                from_message(json!({"id":"wide","scope":scope}), "message-4")
            )
            .contains(reason)
        );
    }
    // The owner may widen it.
    call(
        &mut supervisor,
        "grants.set",
        json!({"actor":"user","grant":project_grant(json!([]), json!([]))}),
    );
    assert_eq!(covering(&mut supervisor)["actor"], "user");
}

#[test]
fn a_grant_stays_inside_the_repository_and_ends_when_withdrawn_or_expired() {
    let mut supervisor = ready();
    for folder in ["/etc", "../other", "src/../../x", "C:\\work", " "] {
        refused(
            &mut supervisor,
            "grants.set",
            json!({"actor":"user","grant":project_grant(json!([folder]), json!([]))}),
        );
        refused(
            &mut supervisor,
            "grants.set",
            json!({"actor":"user","grant":project_grant(json!([]), json!([folder]))}),
        );
    }
    let mut expiring = project_grant(json!([]), json!([]));
    expiring["expiresAt"] = json!(NOW);
    refused(
        &mut supervisor,
        "grants.set",
        json!({"actor":"user","grant":expiring}),
    );
    expiring["expiresAt"] = json!(NOW + 10);
    let revision = call(
        &mut supervisor,
        "grants.set",
        json!({"actor":"user","grant":expiring}),
    )["policyRevision"]
        .as_u64()
        .unwrap();
    assert_eq!(covering(&mut supervisor)["id"], "grant");
    assert!(
        supervisor
            .call_at(
                "grants.resolve",
                serde_json::from_str(THREAD).unwrap(),
                NOW + 10
            )
            .unwrap()["grant"]
            .is_null()
    );
    // The Coordinator may not renew what expired.
    let mut renewed = project_grant(json!([]), json!([]));
    renewed["expiresAt"] = json!(NOW + 100);
    assert!(
        supervisor
            .call_at("grants.set", from_message(renewed, "message-5"), NOW + 20)
            .is_err()
    );
    let withdrawn = call(
        &mut supervisor,
        "grants.withdraw",
        json!({"actor":"coordinator","id":"grant"}),
    );
    assert_eq!(withdrawn["grant"]["revoked"], true);
    assert!(covering(&mut supervisor).is_null());
    assert!(
        call(&mut supervisor, "snapshot", json!({}))["policyRevision"]
            .as_u64()
            .unwrap()
            > revision
    );
    assert_eq!(
        call(&mut supervisor, "snapshot", json!({}))["grants"],
        json!([])
    );
}

#[test]
fn the_most_specific_grant_applies_and_none_covers_the_coordinators_thread_or_a_persons() {
    let mut supervisor = ready();
    call(
        &mut supervisor,
        "grants.set",
        json!({"actor":"user","grant":project_grant(json!([]), json!([]))}),
    );
    call(
        &mut supervisor,
        "grants.set",
        json!({"actor":"user","grant":{"id":"thread-grant","scope":{"kind":"thread","id":"thread"},"folders":["src"]}}),
    );
    assert_eq!(covering(&mut supervisor)["id"], "thread-grant");
    assert!(
        call(
            &mut supervisor,
            "grants.resolve",
            json!({"threadId":"coordinator","projectId":"project","environmentId":"env","assignmentId":"work"})
        )["grant"]
            .is_null()
    );
    // A thread a person started and drives is under no grant, Coordinator on or not.
    assert!(
        call(
            &mut supervisor,
            "grants.resolve",
            json!({"threadId":"thread","projectId":"project","environmentId":"env"})
        )["grant"]
            .is_null()
    );
}

#[test]
fn a_grant_from_a_message_holds_only_what_the_owner_wrote_for_a_day_at_most() {
    let mut supervisor = ready();
    let says = |text: &str, at: u64, grant: Value| json!({"actor":"coordinator","sourceMessageId":format!("m{at}"),"sourceMessageAt":at,"sourceMessageText":text,"grant":grant});
    let grant = project_grant(json!(["src"]), json!(["src/old.ts"]));
    // Words the owner did not write, a wider access, no folder or a longer time are proposed.
    let mut longer = grant.clone();
    longer["expiresAt"] = json!(NOW + 86_400_001);
    let mut full = grant.clone();
    full["maxAccess"] = json!(2);
    for (text, proposal, reason) in [
        ("hello", grant.clone(), "does not name src"),
        ("work in src", grant.clone(), "does not name src/old.ts"),
        (
            "work in src, delete src/old.ts",
            full,
            "More than workspace",
        ),
        (
            "work in src, delete src/old.ts",
            project_grant(json!([]), json!([])),
            "names its folders",
        ),
        ("work in src, delete src/old.ts", longer, "at most a day"),
    ] {
        let result = call(&mut supervisor, "grants.set", says(text, 10, proposal));
        assert!(
            result["reason"].as_str().unwrap().contains(reason),
            "{text}: {result}"
        );
        assert!(result["grant"].is_null());
    }
    assert!(covering(&mut supervisor).is_null());
    let made = call(
        &mut supervisor,
        "grants.set",
        says("work in src, delete src/old.ts", 10, grant.clone()),
    );
    assert_eq!(made["grant"]["expiresAt"], NOW + 86_400_000);
    // An older message cannot make a grant after a newer one did.
    let mut other = grant.clone();
    other["id"] = json!("other");
    assert!(
        supervisor
            .call_at(
                "grants.set",
                says("work in src, delete src/old.ts", 9, other),
                NOW
            )
            .unwrap_err()
            .message
            .contains("later message")
    );
}

#[test]
fn the_whole_project_is_granted_as_a_dot_from_words_that_say_so_and_covers_every_path() {
    let says = |text: &str, grant: Value| json!({"actor":"coordinator","sourceMessageId":"m10","sourceMessageAt":10,"sourceMessageText":text,"grant":grant});
    let whole = project_grant(json!(["."]), json!(["notes/old.txt"]));
    let words = "You may work in the whole project folder. Delete the file notes/old.txt.";
    // Words that do not give the whole project, or rule it out, only propose it; so does
    // deleting all of it, whatever the words.
    for (text, grant) in [
        ("Work in src. Delete notes/old.txt.", whole.clone()),
        (
            "Do not touch the whole project; delete notes/old.txt.",
            whole.clone(),
        ),
        (
            "The whole project is off limits. Delete notes/old.txt.",
            whole.clone(),
        ),
        (
            "Work in the whole project except secrets/. Delete notes/old.txt.",
            whole.clone(),
        ),
        (
            "Use the entire repository, but not src. Delete notes/old.txt.",
            whole.clone(),
        ),
        (
            "Work in the whole project apart from secrets/. Delete notes/old.txt.",
            whole.clone(),
        ),
        (
            "Work in the whole project; do not touch secrets/. Delete notes/old.txt.",
            whole.clone(),
        ),
        (
            "The whole project is prohibited. Delete notes/old.txt.",
            whole.clone(),
        ),
        (
            "Work in the whole project. Stay away from secrets/. Delete notes/old.txt.",
            whole.clone(),
        ),
        (
            "Work in the whole project. Do not touch secrets/. Delete notes/old.txt.",
            whole.clone(),
        ),
        (
            "Work in the whole project. Do not touch secrets/, thanks. Delete notes/old.txt.",
            whole.clone(),
        ),
        (
            "Work in the whole project. Touch nothing except src/. Delete notes/old.txt.",
            whole.clone(),
        ),
        (
            "Work in the whole project. Stay out of secrets/. Delete notes/old.txt.",
            whole.clone(),
        ),
        (
            "Is the whole project yours? Delete notes/old.txt.",
            whole.clone(),
        ),
        (
            "Work in the whole project. Don\u{2019}t touch secrets/.",
            whole.clone(),
        ),
        (
            "Work in the whole project. You mustn't edit secrets/.",
            whole.clone(),
        ),
        (
            "Work in the whole project. Keep clear of secrets/.",
            whole.clone(),
        ),
        (
            "Work in the whole project. secrets/ is excluded.",
            whole.clone(),
        ),
        ("Work in the whole project. Stick to src/.", whole.clone()),
        ("Work in the whole project. Ignore secrets/.", whole.clone()),
        (
            "Work in the whole project. Refrain from editing secrets/.",
            whole.clone(),
        ),
        (
            "Work in the whole project secrets/ aside. Delete notes/old.txt.",
            whole.clone(),
        ),
        ("Work in the whole project. Remove access.", whole.clone()),
        (
            "You may work in the whole project. Editing .env requires confirmation.",
            whole.clone(),
        ),
        (
            "You may work in the whole project. Changes to credentials are banned.",
            whole.clone(),
        ),
        (
            "You may work in the whole project. Modifying secrets is disallowed.",
            whole.clone(),
        ),
        (
            "Add a word-count command. You may work in the whole project.",
            whole.clone(),
        ),
        (
            "Work in src\\app. You may work in the whole project folder.",
            whole.clone(),
        ),
        (
            "Work in the whole project. Ignore the tests.",
            whole.clone(),
        ),
        (
            "Work in the whole project. Document it in README.md.",
            whole.clone(),
        ),
        (
            "Work in the whole project. Stick to the source folder.",
            whole.clone(),
        ),
        (
            "Work in the whole project. You mustn't change the tests.",
            whole.clone(),
        ),
        (
            "I give you the whole project. Remove access to config/secrets.",
            whole.clone(),
        ),
        (
            "Work in the whole project. Then work in src/app.",
            whole.clone(),
        ),
        (
            "Work in the whole project. You can touch src/app and src/lib.",
            whole.clone(),
        ),
        (
            "Work in the whole project. Edit files w/o config/secrets.",
            whole.clone(),
        ),
        (
            "You may work in the whole project folder. Actually...no.",
            whole.clone(),
        ),
        (
            "You may work in the whole project folder. Except.for secrets/.",
            whole.clone(),
        ),
        (
            "You may work in the whole project folder. Do.not touch.secrets/.",
            whole.clone(),
        ),
        (
            "You may work in the whole project folder.\nNot.yet",
            whole.clone(),
        ),
        (
            "I have full access to the whole repo; you may edit this folder.",
            whole.clone(),
        ),
        (
            "You may access the whole project, edit this folder.",
            whole.clone(),
        ),
        (
            "You may work in the whole project, use this folder.",
            whole.clone(),
        ),
        ("The whole project. Delete notes/old.txt.", whole.clone()),
        (
            "You may work in the whole project. You may work in the whole project.",
            whole.clone(),
        ),
        (
            "Update docs/cli.md. You may work in the whole project folder.",
            whole.clone(),
        ),
        (
            "You may work in the whole project folder. Delete notes/../../old.txt.",
            whole.clone(),
        ),
        (words, project_grant(json!(["."]), json!(["."]))),
    ] {
        let result = call(&mut ready(), "grants.set", says(text, grant));
        assert!(
            result["reason"]
                .as_str()
                .unwrap()
                .contains("does not name ."),
            "{text}: {result}"
        );
    }
    let mut supervisor = ready();
    let made = call(&mut supervisor, "grants.set", says(words, whole));
    assert_eq!(made["grant"]["folders"], json!(["."]));
    assert_eq!(made["grant"]["delete"], json!(["notes/old.txt"]));
    // Every path in the project is inside it; one that leaves the project is not.
    let inside = |supervisor: &mut Supervisor, path: &str| {
        let mut request = json!({"category":"file-change","resource":path,"paths":[path],"deletes":[],"outsideWorkspace":false,"requestedAccess":1,"accessIncreaseUnknown":false,"currentAccess":1,"destinationMaxAccess":2,"supported":true});
        for (key, value) in serde_json::from_str::<Value>(THREAD)
            .unwrap()
            .as_object()
            .unwrap()
        {
            request[key] = value.clone();
        }
        call(supervisor, "permissions.effective", request)["effect"].clone()
    };
    assert_eq!(inside(&mut supervisor, "README.md"), "allow");
    assert_eq!(inside(&mut supervisor, "src/deep/a.ts"), "allow");
    assert_ne!(inside(&mut supervisor, "../sibling/a.ts"), "allow");
    // The root has one spelling: another would cover nothing.
    for folders in [json!(["./src"]), json!(["./"])] {
        let mut grant = project_grant(folders, json!([]));
        grant["id"] = json!("other");
        assert!(
            refused(
                &mut supervisor,
                "grants.set",
                json!({"actor":"user","grant":grant})
            )
            .contains("\".\" for the whole project")
        );
    }
}

#[test]
fn a_proposal_waits_for_the_owner_until_they_grant_or_dismiss_it() {
    let mut supervisor = ready();
    let grant = project_grant(json!(["src"]), json!([]));
    let proposals = |supervisor: &mut Supervisor| {
        call(supervisor, "snapshot", json!({}))["grantProposals"]
            .as_array()
            .unwrap()
            .len()
    };
    let says = json!({"actor":"coordinator","sourceMessageId":"m1","sourceMessageAt":1,"sourceMessageText":"hello","grant":grant});
    let proposed = call(&mut supervisor, "grants.set", says.clone());
    assert_eq!(proposed["proposal"]["actor"], "coordinator");
    assert_eq!(proposals(&mut supervisor), 1);
    // Only the owner dismisses one.
    assert!(
        supervisor
            .call_at(
                "grants.dismiss",
                json!({"actor":"coordinator","id":"grant"}),
                NOW
            )
            .is_err()
    );
    call(
        &mut supervisor,
        "grants.dismiss",
        json!({"actor":"user","id":"grant"}),
    );
    assert_eq!(proposals(&mut supervisor), 0);
    call(&mut supervisor, "grants.set", says);
    call(
        &mut supervisor,
        "grants.set",
        json!({"actor":"user","grant":grant}),
    );
    assert_eq!(proposals(&mut supervisor), 0);
}

#[test]
fn a_folder_counts_as_named_only_whole_and_never_where_the_owner_ruled_it_out() {
    for (text, folder, granted) in [
        ("work in packages/shared only", "packages", false),
        ("work in packages/shared only", "packages/shared", true),
        ("fix the apps folder", "app", false),
        ("fix the mapper in src.", "src", true),
        ("update src/old.ts", "src/old", false),
        ("work in src but don't touch src/auth", "src/auth", false),
        ("work in src, except docs", "docs", false),
        ("do not change docs", "docs", false),
        ("work in src, docs and tests", "docs", true),
        ("don't touch tests, work in docs", "docs", true),
    ] {
        let mut supervisor = ready();
        let grant = project_grant(json!([folder]), json!([]));
        let result = call(
            &mut supervisor,
            "grants.set",
            json!({"actor":"coordinator","sourceMessageId":"m1","sourceMessageAt":1,"sourceMessageText":text,"grant":grant}),
        );
        assert_eq!(result["proposal"].is_null(), granted, "{text} / {folder}");
    }
}

#[test]
fn a_message_the_coordinator_already_answered_only_proposes() {
    let mut supervisor = ready();
    let grant = project_grant(json!(["src"]), json!([]));
    let result = call(
        &mut supervisor,
        "grants.set",
        json!({"actor":"coordinator","sourceMessageId":"m1","sourceMessageAt":1,"sourceMessageText":"work in src","sourceMessageAnswered":true,"grant":grant}),
    );
    assert!(
        result["reason"]
            .as_str()
            .unwrap()
            .contains("already replied")
    );
    assert!(covering(&mut supervisor).is_null());
}

#[test]
fn a_proposal_goes_when_a_newer_one_for_its_thread_comes_or_the_thread_settles() {
    let mut supervisor = ready();
    let propose = |supervisor: &mut Supervisor, id: &str, kind: &str, target: &str| {
        let grant =
            json!({"id":id,"scope":{"kind":kind,"id":target},"folders":["docs"],"maxAccess":1});
        call(
            supervisor,
            "grants.set",
            json!({"actor":"coordinator","sourceMessageId":"m1","sourceMessageAt":1,"sourceMessageText":"go","grant":grant}),
        );
    };
    let ids = |supervisor: &mut Supervisor| {
        call(supervisor, "snapshot", json!({}))["grantProposals"]
            .as_array()
            .unwrap()
            .iter()
            .map(|proposal| proposal["grant"]["id"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>()
    };
    propose(&mut supervisor, "first", "thread", "thread");
    propose(&mut supervisor, "other", "project", "project");
    propose(&mut supervisor, "second", "thread", "thread");
    assert_eq!(ids(&mut supervisor), ["other", "second"]);
    call(
        &mut supervisor,
        "cards.settle",
        json!({"actor":"user","id":"card"}),
    );
    assert_eq!(ids(&mut supervisor), ["other"]);
}
