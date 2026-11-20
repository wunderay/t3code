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

/// A repository of its own per test, removed when the test ends.
struct Repository(PathBuf);

impl Repository {
    fn new(name: &str) -> Self {
        let path = std::env::temp_dir().join(format!("t3-results-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        git(&path, &["init", "-q", "-b", "main"]);
        Self(path)
    }
    fn write(&self, path: &str, body: &str) {
        let file = self.0.join(path);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(file, body).unwrap();
    }
    fn commit(&self) -> String {
        git(&self.0, &["add", "-A"]);
        git(&self.0, &["commit", "-q", "--allow-empty", "-m", "change"]);
        git(&self.0, &["rev-parse", "HEAD"])
    }
    fn path(&self) -> &str {
        self.0.to_str().unwrap()
    }
}

impl Drop for Repository {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn the_base_is_the_commit_a_ref_names_at_dispatch() {
    let repository = Repository::new("base");
    repository.write("projects/app/a.txt", "a");
    let first = repository.commit();
    let project = format!("{}/projects/app", repository.path());
    let mut supervisor = Supervisor::open(Path::new(":memory:")).unwrap();
    let base = call(
        &mut supervisor,
        "results.base",
        json!({"repository":repository.path(),"ref":"main","project":project}),
    );
    assert_eq!(
        base,
        json!({"base":first,"prefix":"projects/app/","branch":"main"})
    );
    let current = call(
        &mut supervisor,
        "results.base",
        json!({"repository":repository.path(),"ref":"HEAD","project":project}),
    );
    assert_eq!(current["branch"], "main");
    let detached = call(
        &mut supervisor,
        "results.base",
        json!({"repository":repository.path(),"ref":first,"project":project}),
    );
    assert_eq!(detached["branch"], Value::Null);
    for refused in [
        json!({"repository":"relative","ref":"main","project":project}),
        json!({"repository":repository.path(),"ref":"missing","project":project}),
        json!({"repository":repository.path(),"ref":"--output=/tmp/x","project":project}),
        json!({"repository":repository.path(),"ref":"main","project":"projects/app"}),
    ] {
        assert!(supervisor.call_at("results.base", refused, NOW).is_err());
    }
}

fn supervisor_with(base: &str, grant: Value) -> Supervisor {
    supervisor_in(base, "", grant)
}

fn supervisor_in(base: &str, prefix: &str, grant: Value) -> Supervisor {
    let mut supervisor = Supervisor::open(Path::new(":memory:")).unwrap();
    call(
        &mut supervisor,
        "configure",
        json!({"actor":"user","enabled":true,"coordinatorProvider":"replay","coordinatorModel":"replay"}),
    );
    call(
        &mut supervisor,
        "cards.sync",
        json!({"cards":[{"id":"parent","threadId":"parent","environmentId":"env","projectId":"project","purpose":"Build","status":"running","instructionRevision":1}]}),
    );
    call(
        &mut supervisor,
        "catalog.sync",
        json!({"sourceId":"provider","models":[{"id":"catalog:local:model","sourceId":"provider","provider":"replay","model":"model","destination":"local","account":null,"efforts":["high"],"compatible":true,"accessible":true,"policyAllowed":true,"qualificationVerified":true,"identityVerified":true,"evidence":["qualification:exact-model-and-options"]}]}),
    );
    let recorded = if grant.is_null() {
        Value::Null
    } else {
        call(
            &mut supervisor,
            "grants.set",
            json!({"actor":"user","grant":grant}),
        )["grant"]
            .clone()
    };
    let revision = call(&mut supervisor, "snapshot", json!({}))["policyRevision"].clone();
    let prepared = call(
        &mut supervisor,
        "assignments.prepare",
        json!({"assignment":{"id":"work","idempotencyKey":"request:work","cardId":"parent","goalId":null,"route":{"provider":"replay","model":"model","effort":"high","destination":"local"},"instructionRevision":1,"pauseRevision":0,"grantRevision":revision,"reservation":{"id":"reservation:work","owner":"guild-capacity","expiresAt":NOW+60_000,"policyRevision":"policy-v1","sharedCapacity":true},"brief":"Build the bounded result, verify acceptance, and preserve user scope.","returnRoute":"coordinator:coordinator"}}),
    );
    let id = prepared["action"]["id"].clone();
    call(&mut supervisor, "actions.claim", json!({"id":id}));
    call(
        &mut supervisor,
        "actions.ack",
        json!({"id":id,"status":"completed","result":{"status":"running","receipt":{"id":"receipt:work","base":base,"prefix":prefix,"grant":recorded},"executionId":"turn:work"}}),
    );
    supervisor
}

fn check(supervisor: &mut Supervisor, repository: &Repository) -> Value {
    call(
        supervisor,
        "results.check",
        json!({"assignmentId":"work","repository":repository.path()}),
    )["resultCheck"]
        .clone()
}

fn grant(folders: Value, delete: Value) -> Value {
    json!({"id":"grant","scope":{"kind":"project","id":"project"},"folders":folders,"delete":delete})
}

fn started(name: &str) -> (Repository, String) {
    let repository = Repository::new(name);
    repository.write("src/app.ts", "export const app = 1;\n");
    repository.write("src/old.ts", "export const old = 1;\n");
    repository.write("docs/notes.txt", "notes\n");
    repository.write(
        "src/app.test.ts",
        "it(\"works\", () => {});\nit(\"still works\", () => {});\n",
    );
    repository.write("src/lib.rs", "#[test]\nfn works() {}\n");
    repository.write("tests/test_app.py", "def test_app():\n    pass\n");
    let base = repository.commit();
    (repository, base)
}

#[test]
fn a_change_inside_the_grant_passes_and_is_recorded() {
    let (repository, base) = started("inside");
    repository.write(
        "src/app.ts",
        "export const app = 2;\n-- a line that looks like a header\n",
    );
    repository.write(
        "src/app.test.ts",
        "it(\"works\", () => {});\nit(\"still works\", () => {});\nit(\"new\", () => {});\n",
    );
    // A conditional skip is a portability guard, not a hidden failure.
    repository.write(
        "tests/test_app.py",
        "import pytest\n@pytest.mark.skipif(True, reason=\"x\")\ndef test_app():\n    pass\n",
    );
    fs::remove_file(repository.0.join("src/old.ts")).unwrap();
    let head = repository.commit();
    let mut supervisor =
        supervisor_with(&base, grant(json!(["src", "tests"]), json!(["src/old.ts"])));
    let result = check(&mut supervisor, &repository);
    assert_eq!(result["blocking"], json!([]));
    assert_eq!(result["passed"], true);
    assert_eq!(result["head"], head);
    assert_eq!(result["grantId"], "grant");
    assert_eq!(
        call(&mut supervisor, "snapshot", json!({}))["resultChecks"],
        json!([])
    );
}

#[test]
fn a_grant_of_the_whole_project_covers_every_changed_file() {
    let (repository, base) = started("whole");
    repository.write("README.md", "# Read me\n");
    repository.write("src/deep/new.ts", "export const deep = 1;\n");
    repository.commit();
    let mut supervisor = supervisor_with(&base, grant(json!(["."]), json!([])));
    let result = check(&mut supervisor, &repository);
    assert_eq!(result["blocking"], json!([]));
    assert_eq!(result["passed"], true);
}

#[test]
fn each_kind_of_miss_blocks_the_result() {
    type Change<'a> = &'a dyn Fn(&Repository);
    let cases: [(&str, Change, &str); 7] = [
        (
            "outside",
            &|r| r.write("docs/notes.txt", "changed\n"),
            "outside the grant's folders: docs/notes.txt",
        ),
        (
            "deleted",
            &|r| fs::remove_file(r.0.join("src/app.ts")).unwrap(),
            "deleted outside the delete list: src/app.ts",
        ),
        (
            "skip-ts",
            &|r| {
                r.write(
                    "src/app.test.ts",
                    "it(\"works\", () => {});\nit.skip(\"still works\", () => {});\n",
                )
            },
            "skip added in src/app.test.ts",
        ),
        (
            "only-ts",
            &|r| {
                r.write(
                    "src/app.test.ts",
                    "it.only(\"works\", () => {});\nit(\"still works\", () => {});\n",
                )
            },
            "skip added in src/app.test.ts",
        ),
        (
            "skip-py",
            &|r| {
                r.write(
                    "tests/test_app.py",
                    "import pytest\n@pytest.mark.skip\ndef test_app():\n    pass\n",
                )
            },
            "skip added in tests/test_app.py",
        ),
        (
            "skip-rs",
            &|r| r.write("src/lib.rs", "#[test]\n#[ignore]\nfn works() {}\n"),
            "skip added in src/lib.rs",
        ),
        (
            "fewer",
            &|r| r.write("src/app.test.ts", "it(\"works\", () => {});\n"),
            "fewer tests than the base: 1 removed, 0 added",
        ),
    ];
    for (name, change, finding) in cases {
        let (repository, base) = started(name);
        change(&repository);
        repository.commit();
        let mut supervisor = supervisor_with(&base, grant(json!(["src", "tests"]), json!([])));
        let result = check(&mut supervisor, &repository);
        assert_eq!(result["passed"], false, "{name}");
        assert!(
            result["blocking"]
                .as_array()
                .unwrap()
                .iter()
                .any(|item| item.as_str().unwrap().contains(finding)),
            "{name}: {result}"
        );
        assert_eq!(
            call(&mut supervisor, "snapshot", json!({}))["resultChecks"][0]["assignmentId"],
            "work"
        );
    }
}

#[test]
fn a_change_outside_the_goals_touches_blocks() {
    let (repository, base) = started("touches");
    repository.write("src/app.ts", "export const app = 2;\n");
    repository.write("src/new.ts", "export const added = 1;\n");
    repository.commit();
    let mut supervisor = supervisor_with(&base, grant(json!(["src"]), json!([])));
    let mut receipt = call(&mut supervisor, "assignments.get", json!({"id":"work"}))["assignment"]
        ["receipt"]
        .clone();
    receipt["touches"] = json!(["src/app.ts"]);
    call(
        &mut supervisor,
        "assignments.update",
        json!({"id":"work","receipt":receipt}),
    );
    assert_eq!(
        check(&mut supervisor, &repository)["blocking"],
        json!(["changed outside the goal's touches: src/new.ts"])
    );
}

#[test]
fn without_a_grant_any_deletion_blocks_and_without_a_base_nothing_is_checked() {
    let (repository, base) = started("ungranted");
    fs::remove_file(repository.0.join("src/old.ts")).unwrap();
    repository.write("docs/notes.txt", "changed\n");
    repository.commit();
    let mut supervisor = supervisor_with(&base, Value::Null);
    assert_eq!(
        check(&mut supervisor, &repository)["blocking"],
        json!([
            "no grant was recorded at dispatch",
            "deleted outside the delete list: src/old.ts"
        ])
    );
    let mut unbased = supervisor_with("", Value::Null);
    assert!(
        unbased
            .call_at(
                "results.check",
                json!({"assignmentId":"work","repository":repository.path()}),
                NOW
            )
            .is_err()
    );
}

#[test]
fn in_a_project_folder_the_grant_is_the_projects_and_a_sibling_project_is_outside_it() {
    let repository = Repository::new("monorepo");
    repository.write("projects/app/src/app.ts", "export const app = 1;\n");
    repository.write("projects/app/src/old.ts", "export const old = 1;\n");
    repository.write("projects/other/src/other.ts", "export const other = 1;\n");
    let base = repository.commit();
    repository.write("projects/app/src/app.ts", "export const app = 2;\n");
    fs::remove_file(repository.0.join("projects/app/src/old.ts")).unwrap();
    repository.commit();
    let granted = || grant(json!(["src"]), json!(["src/old.ts"]));
    let mut supervisor = supervisor_in(&base, "projects/app/", granted());
    assert_eq!(check(&mut supervisor, &repository)["blocking"], json!([]));
    repository.write("projects/other/src/other.ts", "export const other = 2;\n");
    repository.commit();
    let mut supervisor = supervisor_in(&base, "projects/app/", granted());
    assert_eq!(
        check(&mut supervisor, &repository)["blocking"],
        json!(["changed outside the project folder: projects/other/src/other.ts"])
    );
}

#[test]
fn the_check_holds_to_the_grant_recorded_at_dispatch() {
    let (repository, base) = started("recorded");
    repository.write("src/app.ts", "export const app = 2;\n");
    repository.commit();
    let mut supervisor = supervisor_with(&base, grant(json!(["src"]), json!([])));
    // Withdrawing or widening the grant later changes nothing for work already dispatched.
    call(
        &mut supervisor,
        "grants.withdraw",
        json!({"actor":"user","id":"grant"}),
    );
    assert_eq!(check(&mut supervisor, &repository)["passed"], true);
    call(
        &mut supervisor,
        "grants.set",
        json!({"actor":"user","grant":grant(json!([]), json!([]))}),
    );
    repository.write("docs/notes.txt", "changed\n");
    repository.commit();
    assert_eq!(
        check(&mut supervisor, &repository)["blocking"],
        json!(["changed outside the grant's folders: docs/notes.txt"])
    );
}

#[test]
fn a_link_out_of_the_grant_or_a_submodule_change_blocks() {
    let cases: [(&str, &str, Option<&str>); 4] = [
        ("link-inside", "app.ts", None),
        (
            "link-up",
            "../../etc/passwd",
            Some("symbolic link reaching outside the grant: src/link"),
        ),
        (
            "link-absolute",
            "/etc/passwd",
            Some("symbolic link reaching outside the grant: src/link"),
        ),
        (
            "link-sibling",
            "../docs/notes.txt",
            Some("symbolic link reaching outside the grant: src/link"),
        ),
    ];
    for (name, target, finding) in cases {
        let (repository, base) = started(name);
        std::os::unix::fs::symlink(target, repository.0.join("src/link")).unwrap();
        repository.commit();
        let mut supervisor = supervisor_with(&base, grant(json!(["src", "tests"]), json!([])));
        let blocking = check(&mut supervisor, &repository)["blocking"].clone();
        match finding {
            None => assert_eq!(blocking, json!([]), "{name}"),
            Some(finding) => assert!(
                blocking[0].as_str().unwrap().starts_with(finding),
                "{name}: {blocking}"
            ),
        }
    }
    let (repository, base) = started("submodule");
    git(
        &repository.0,
        &[
            "update-index",
            "--add",
            "--cacheinfo",
            &format!("160000,{base},src/vendor"),
        ],
    );
    git(&repository.0, &["commit", "-q", "-m", "submodule"]);
    let mut supervisor = supervisor_with(&base, grant(json!(["src", "tests"]), json!([])));
    assert_eq!(
        check(&mut supervisor, &repository)["blocking"],
        json!(["submodule changed: src/vendor"])
    );
}

#[test]
fn a_worktree_is_clean_only_with_nothing_untracked_or_ignored() {
    let repository = Repository::new("clean");
    repository.write(".gitignore", "*.local\n");
    repository.commit();
    let mut supervisor = Supervisor::open(Path::new(":memory:")).unwrap();
    let clean = |supervisor: &mut Supervisor| {
        call(
            supervisor,
            "results.clean",
            json!({"repository":repository.path()}),
        )["clean"]
            .clone()
    };
    assert_eq!(clean(&mut supervisor), true);
    repository.write(".env.local", "SECRET=1");
    assert_eq!(clean(&mut supervisor), false);
    // An ignored file is no uncommitted work.
    assert_eq!(
        call(
            &mut supervisor,
            "results.clean",
            json!({"repository":repository.path(),"ignored":false}),
        )["clean"],
        true
    );
    fs::remove_file(repository.0.join(".env.local")).unwrap();
    repository.write("new.txt", "untracked");
    assert_eq!(clean(&mut supervisor), false);
}

#[test]
fn the_owner_releases_or_discards_held_work_and_it_waits_no_longer() {
    let held = |name: &str| {
        let (repository, base) = started(name);
        repository.write("docs/notes.txt", "changed\n");
        repository.commit();
        let mut supervisor = supervisor_with(&base, grant(json!(["src"]), json!([])));
        assert_eq!(check(&mut supervisor, &repository)["passed"], false);
        (repository, supervisor)
    };
    let waiting = |supervisor: &mut Supervisor| {
        call(supervisor, "snapshot", json!({}))["resultChecks"]
            .as_array()
            .unwrap()
            .len()
    };
    let (repository, mut supervisor) = held("release");
    assert_eq!(waiting(&mut supervisor), 1);
    let shown = call(&mut supervisor, "snapshot", json!({}))["resultChecks"][0]["head"].clone();
    // Only the owner releases it; once released, checking it again holds it no longer.
    assert!(
        supervisor
            .call_at(
                "results.accept",
                json!({"actor":"coordinator","assignmentId":"work","head":shown}),
                NOW
            )
            .is_err()
    );
    // A release of the commit shown does not release a later one checked since.
    repository.write("docs/notes.txt", "changed later\n");
    let later = repository.commit();
    assert_eq!(check(&mut supervisor, &repository)["passed"], false);
    assert!(
        supervisor
            .call_at(
                "results.accept",
                json!({"actor":"user","assignmentId":"work","head":shown}),
                NOW
            )
            .is_err()
    );
    assert_eq!(waiting(&mut supervisor), 1);
    call(
        &mut supervisor,
        "results.accept",
        json!({"actor":"user","assignmentId":"work","head":later}),
    );
    assert_eq!(check(&mut supervisor, &repository)["passed"], true);
    assert_eq!(waiting(&mut supervisor), 0);
    // A new commit after the release is checked afresh.
    repository.write("docs/notes.txt", "changed again\n");
    repository.commit();
    assert_eq!(check(&mut supervisor, &repository)["passed"], false);

    let (_repository, mut supervisor) = held("discard");
    let discarded = call(
        &mut supervisor,
        "results.discard",
        json!({"actor":"user","assignmentId":"work"}),
    );
    assert_eq!(discarded["action"]["kind"], "cancel");
    assert_eq!(waiting(&mut supervisor), 0);
}

#[test]
fn attributes_and_quoted_names_do_not_hide_a_skip_or_a_removed_test() {
    let names = ["src/ü.test.ts", "src/\"q\".test.ts", "src/t\tb.test.ts"];
    for (index, name) in names.iter().enumerate() {
        for removed in [false, true] {
            let repository = Repository::new(&format!("quoted-{index}-{removed}"));
            repository.write(name, "it(\"works\", () => {});\n");
            let base = repository.commit();
            let body = if removed {
                ""
            } else {
                "it.skip(\"works\", () => {});\n"
            };
            repository.write(name, body);
            repository.commit();
            let mut supervisor = supervisor_with(&base, grant(json!(["src"]), json!([])));
            let result = check(&mut supervisor, &repository);
            assert_eq!(result["passed"], false, "{name} {removed}: {result}");
        }
    }
    // A granted attribute that marks tests binary must not turn a skip into "Binary files differ".
    let (repository, base) = started("attributes");
    repository.write("src/.gitattributes", "*.test.ts -diff\n");
    repository.commit();
    repository.write(
        "src/app.test.ts",
        "it(\"works\", () => {});\nit.skip(\"still works\", () => {});\n",
    );
    repository.commit();
    let mut supervisor = supervisor_with(&base, grant(json!(["src", "tests"]), json!([])));
    let result = check(&mut supervisor, &repository);
    assert!(
        result["blocking"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item
                .as_str()
                .unwrap()
                .contains("skip added in src/app.test.ts")),
        "{result}"
    );
}
