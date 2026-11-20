use crate::{Error, Result, field, grant, model::Assignment, store, text};
use rusqlite::Transaction;
use serde_json::{Value, json};
use std::{path::Path, process::Command};

fn repository(parameters: &Value) -> Result<&str> {
    let repository = field(parameters, "repository")?;
    text(repository, 4096, "repository")?;
    if !Path::new(repository).is_absolute() {
        return Err(Error::invalid("repository must be an absolute path"));
    }
    Ok(repository)
}

/// A thread's worktree is as untrusted as any workspace, so git reads it as the server's workspace
/// reads do (`WORKSPACE_GIT_HARDENED_CONFIG_ARGS`, and a bare repository only when named).
pub(crate) const HARDENED: [&str; 6] = [
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.untrackedCache=false",
    "-c",
    "safe.bareRepository=explicit",
];

pub(crate) fn git(repository: &str, arguments: &[&str]) -> Result<String> {
    let output = Command::new("git")
        .args(HARDENED)
        .arg("-C")
        .arg(repository)
        .args(arguments)
        .output()
        .map_err(Error::internal)?;
    if !output.status.success() {
        return Err(Error::conflict(format!(
            "git {} failed: {}",
            arguments.first().unwrap_or(&""),
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    String::from_utf8(output.stdout).map_err(Error::internal)
}

pub(crate) fn commit(repository: &str, reference: &str) -> Result<String> {
    text(reference, 256, "ref")?;
    let resolved = git(
        repository,
        &[
            "rev-parse",
            "--verify",
            "--end-of-options",
            &format!("{reference}^{{commit}}"),
        ],
    )?;
    Ok(resolved.trim().into())
}

/// The commit an assignment's worktree starts from, fixed at dispatch so later moves of the
/// branch it came from cannot change what its result is compared with.
/// With it, where the project's folder sits in its repository: grants and checks are in the
/// project's terms, and a sibling project in the same repository is outside them.
/// And the branch the ref names, which the assignment's change is merged into; none when detached.
pub(crate) fn base(parameters: &Value) -> Result<Value> {
    let repository = repository(parameters)?;
    let reference = field(parameters, "ref")?;
    let base = commit(repository, reference)?;
    let project = field(parameters, "project")?;
    if !Path::new(project).is_absolute() {
        return Err(Error::invalid("project must be an absolute path"));
    }
    let prefix = git(project, &["rev-parse", "--show-prefix"])?;
    let name = git(
        repository,
        &[
            "rev-parse",
            "--symbolic-full-name",
            "--end-of-options",
            reference,
        ],
    )?;
    // The ref was verified above; this command echoes the options marker before the name.
    let branch = name
        .lines()
        .last()
        .and_then(|name| name.strip_prefix("refs/heads/"));
    Ok(json!({"base":base,"prefix":prefix.trim(),"branch":branch}))
}

/// Whether a worktree holds nothing but what git tracks unchanged: no change, no untracked file
/// and, unless `ignored` is false, no ignored one. Only such a worktree is the host's to remove;
/// anything else may be someone's. Without ignored files, it says whether work is uncommitted.
pub(crate) fn clean(parameters: &Value) -> Result<Value> {
    let repository = repository(parameters)?;
    let mut arguments = vec!["status", "--porcelain", "--untracked-files=all"];
    if parameters.get("ignored").and_then(Value::as_bool) != Some(false) {
        arguments.push("--ignored");
    }
    let status = git(repository, &arguments)?;
    let held: Vec<&str> = status.lines().collect();
    Ok(json!({"clean":held.is_empty(),"held":held}))
}

/// A test file in any common layout: Python's, a test or spec folder anywhere, or a
/// `*.test.*` / `*_test.*` / `*.spec.*` name.
fn is_test_path(path: &str) -> bool {
    let parts = path.split(['\\', '/']).collect::<Vec<_>>();
    let name = parts.last().copied().unwrap_or("");
    parts[..parts.len().saturating_sub(1)].iter().any(|part| {
        [
            "test",
            "tests",
            "spec",
            "specs",
            "__tests__",
            "e2e",
            "testing",
        ]
        .contains(part)
    }) || name.starts_with("test_")
        || ["_test.", ".test.", "_spec.", ".spec."]
            .iter()
            .any(|marker| name.contains(marker))
        || name == "conftest.py"
}

/// Rust keeps unit tests beside the code, so its files are read as tests wherever they are.
fn holds_tests(path: &str) -> bool {
    is_test_path(path) || path.ends_with(".rs")
}

/// Unconditional skips hide failures; a focused test skips every other one.
fn skips(line: &str) -> bool {
    let python = (line.contains("pytest.mark.skip") && !line.contains("pytest.mark.skipif"))
        || line.contains("pytest.mark.xfail")
        || line.contains("pytest.xfail(")
        || (line.contains("unittest.skip")
            && !line.contains("unittest.skipIf")
            && !line.contains("unittest.skipUnless"));
    let script = [
        "it.skip",
        "test.skip",
        "describe.skip",
        "suite.skip",
        "it.effect.skip",
        "it.live.skip",
        "it.todo",
        "test.todo",
        "xit(",
        "xtest(",
        "xdescribe(",
        "it.only",
        "test.only",
        "describe.only",
        "it.effect.only",
        "it.live.only",
    ]
    .iter()
    .any(|pattern| line.contains(pattern));
    python || script || line.contains("#[ignore")
}

fn defines_test(line: &str) -> bool {
    let line = line.trim_start();
    [
        "def test_",
        "async def test_",
        "it(",
        "test(",
        "it.effect(",
        "it.live(",
        "it.scoped(",
        "it.each",
        "test.each",
        "it.prop(",
        "#[test]",
        "#[tokio::test",
    ]
    .iter()
    .any(|start| line.starts_with(start))
}

/// Whether a link at `link` (in the project's terms) to `target` lands inside the project and,
/// when the grant names folders, inside one of them.
fn link_stays_inside(link: &str, target: &str, folders: &[String]) -> bool {
    if target.starts_with(['/', '\\', '~']) || target.get(1..2) == Some(":") {
        return false;
    }
    let mut parts = link.split('/').collect::<Vec<_>>();
    parts.pop();
    for part in target.split(['/', '\\']) {
        match part {
            "" | "." => {}
            ".." => {
                if parts.pop().is_none() {
                    return false;
                }
            }
            part => parts.push(part),
        }
    }
    let resolved = parts.join("/");
    folders.is_empty()
        || folders
            .iter()
            .any(|folder| grant::within(&resolved, folder))
}

/// Ported from the Guild's tamper check, which only warned about changes outside a quest's
/// files. Here they block: changes outside the grant's folders or the goal's touches, deletions
/// not on its delete list, added skips, and fewer tests than the base.
pub(crate) fn check(tx: &Transaction<'_>, parameters: &Value, revision: u64) -> Result<Value> {
    let repository = repository(parameters)?;
    let assignment: Assignment =
        store::required(tx, "assignment", field(parameters, "assignmentId")?)?;
    let recorded = |key: &str| {
        assignment
            .receipt
            .as_ref()
            .and_then(|receipt| receipt.get(key))
            .and_then(Value::as_str)
    };
    let base =
        recorded("base").ok_or_else(|| Error::invalid("The assignment has no recorded base"))?;
    let prefix = recorded("prefix").unwrap_or("");
    // Checked against the grant recorded at dispatch: a grant changed or withdrawn later does
    // not open the check, and work dispatched with none has no folder it may change.
    let recorded_grant = assignment
        .receipt
        .as_ref()
        .and_then(|receipt| receipt.get("grant"))
        .filter(|grant| grant.is_object());
    let list = |from: Option<&Value>, key: &str| -> Vec<String> {
        from.and_then(|record| record.get(key))
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(Into::into)
                    .collect()
            })
            .unwrap_or_default()
    };
    let (folders, delete) = (
        list(recorded_grant, "folders"),
        list(recorded_grant, "delete"),
    );
    let touches = list(assignment.receipt.as_ref(), "touches");
    let base = commit(repository, base)?;
    let head = commit(
        repository,
        parameters
            .get("head")
            .and_then(Value::as_str)
            .unwrap_or("HEAD"),
    )?;
    let mut blocking = Vec::new();
    if recorded_grant.is_none() {
        blocking.push("no grant was recorded at dispatch".to_owned());
    }
    let mut sanctioned = Vec::new();
    let status = git(
        repository,
        &[
            "diff",
            "--raw",
            "--no-renames",
            "-z",
            "--no-abbrev",
            &base,
            &head,
        ],
    )?;
    let fields = status.split('\0').collect::<Vec<_>>();
    for pair in fields.chunks(2) {
        let [meta, path] = pair else { continue };
        // `:old-mode new-mode old-id new-id status`
        let meta = meta.trim_start_matches(':').split(' ').collect::<Vec<_>>();
        let [old_mode, new_mode, _, new_id, kind] = meta[..] else {
            continue;
        };
        let Some(local) = path.strip_prefix(prefix) else {
            blocking.push(format!("changed outside the project folder: {path}"));
            continue;
        };
        if old_mode == "160000" || new_mode == "160000" {
            blocking.push(format!("submodule changed: {path}"));
        }
        if new_mode == "120000" {
            let target = git(repository, &["cat-file", "blob", new_id])?;
            if !link_stays_inside(local, &target, &folders) {
                blocking.push(format!(
                    "symbolic link reaching outside the grant: {path} -> {target}"
                ));
            }
        }
        let path = local;
        if !folders.is_empty() && !folders.iter().any(|folder| grant::within(path, folder)) {
            blocking.push(format!("changed outside the grant's folders: {path}"));
        }
        if !touches.is_empty() && !grant::covers(path, &touches) {
            blocking.push(format!("changed outside the goal's touches: {path}"));
        }
        if kind.starts_with('D') {
            if delete.iter().any(|listed| grant::within(path, listed)) {
                sanctioned.push(path);
            } else {
                blocking.push(format!("deleted outside the delete list: {path}"));
            }
        }
    }
    let (mut removed, mut added) = (0, 0);
    // Each test file is diffed on its own, by the name the `-z` list gave, so no header has to
    // be parsed back into a name; `--text` and `--no-textconv` keep a granted `.gitattributes`
    // from turning the change into "Binary files differ" or into another text.
    for path in fields.chunks(2).filter_map(|pair| pair.get(1)) {
        if !holds_tests(path) {
            continue;
        }
        let deletion_sanctioned = path
            .strip_prefix(prefix)
            .is_some_and(|local| sanctioned.contains(&local));
        let diff = git(
            repository,
            &[
                "diff",
                "--unified=0",
                "--text",
                "--no-textconv",
                "--no-color",
                "--no-ext-diff",
                "--no-renames",
                &base,
                &head,
                "--",
                &format!(":(top,literal){path}"),
            ],
        )?;
        // A changed line may itself start with "--- ", so only lines after a hunk header count.
        let mut header = false;
        for line in diff.lines() {
            if line.starts_with("diff --git ") {
                header = true;
            } else if line.starts_with("@@") {
                header = false;
            } else if header {
            } else if let Some(text) = line.strip_prefix('+') {
                if skips(text) {
                    let shown = text.trim().chars().take(80).collect::<String>();
                    blocking.push(format!("skip added in {path}: {shown}"));
                }
                added += usize::from(defines_test(text));
            } else if let Some(text) = line.strip_prefix('-')
                && !deletion_sanctioned
            {
                removed += usize::from(defines_test(text));
            }
        }
    }
    if removed > added {
        blocking.push(format!(
            "fewer tests than the base: {removed} removed, {added} added"
        ));
    }
    blocking.truncate(50);
    // The owner accepted this very change: it is released whatever the check finds again.
    let accepted = store::get::<Value>(tx, "resultCheck", &assignment.id)?
        .is_some_and(|previous| previous["acceptedBy"] == "user" && previous["head"] == head);
    let mut result = json!({"assignmentId":assignment.id,"base":base,"head":head,"grantId":recorded_grant.and_then(|grant| grant.get("id")),"passed":blocking.is_empty() || accepted,"blocking":blocking,"revision":revision});
    if accepted {
        result["acceptedBy"] = json!("user");
    }
    store::put(tx, "resultCheck", &assignment.id, &result, revision)?;
    Ok(json!({"resultCheck":result}))
}

/// The owner releases work its result check held: it goes on to review and merge as it is.
pub(crate) fn accept(tx: &Transaction<'_>, parameters: &Value, revision: u64) -> Result<Value> {
    crate::user(parameters)?;
    let id = field(parameters, "assignmentId")?;
    let mut check: Value = store::required(tx, "resultCheck", id)?;
    // The owner released the commit they were shown; a later check of another one is not theirs.
    if check["head"] != field(parameters, "head")? {
        return Err(Error::conflict(
            "The held work changed since it was shown; look at it again",
        ));
    }
    check["passed"] = json!(true);
    check["acceptedBy"] = json!("user");
    check["revision"] = json!(revision);
    store::put(tx, "resultCheck", id, &check, revision)?;
    Ok(json!({"resultCheck":check}))
}

/// The owner discards work its result check held: the assignment is cancelled and the hold goes.
pub(crate) fn discard(
    tx: &Transaction<'_>,
    parameters: &Value,
    revision: u64,
    now: u64,
) -> Result<Value> {
    crate::user(parameters)?;
    let id = field(parameters, "assignmentId")?;
    store::required::<Value>(tx, "resultCheck", id)?;
    let cancelled =
        crate::supervision::cancel(tx, &json!({"id":id,"actor":"user"}), revision, now)?;
    store::remove(tx, "resultCheck", id, revision)?;
    Ok(cancelled)
}
