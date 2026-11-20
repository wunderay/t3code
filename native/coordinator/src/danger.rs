use crate::{
    Error, Result, decode, grant, grant::Grant, identifier, plain_label, store, text, user,
};
use rusqlite::Transaction;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// A request the host never answers: it always goes to the owner, while other work goes on.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DangerRule {
    pub id: String,
    pub label: String,
    #[serde(default = "any")]
    pub category: String,
    /// Words that appear in this order in the command, or one of them in a path; `*` matches
    /// any run of characters.
    #[serde(default)]
    pub words: Vec<String>,
    /// `outside-workspace` or `delete-outside-grant`.
    #[serde(default)]
    pub when: Option<String>,
}

fn any() -> String {
    "*".into()
}

const CONDITIONS: [&str; 2] = ["outside-workspace", "delete-outside-grant"];

/// Words in order; see [`word_matches`] for what a word matches.
const WORDS: &[(&str, &str, &str)] = &[
    ("force-push", "Force push", "git push --force*"),
    ("force-push-short", "Force push", "git push -f"),
    ("force-push-refspec", "Force push", "git push +*"),
    ("mirror-push", "Force push", "git push --mirror"),
    ("hard-reset", "Hard reset", "git reset --hard"),
    ("clean", "Removing untracked files", "git clean"),
    ("checkout-discard", "Discarding changes", "git checkout --"),
    ("restore", "Discarding changes", "git restore"),
    ("filter", "History rewrite", "git filter-*"),
    ("reflog-expire", "History rewrite", "git reflog expire"),
    ("update-ref-delete", "History rewrite", "git update-ref -d"),
    ("branch-delete", "Branch deletion", "git branch -d"),
    ("branch-delete-force", "Branch deletion", "git branch -D"),
    (
        "branch-delete-long",
        "Branch deletion",
        "git branch --delete",
    ),
    (
        "remote-branch-delete",
        "Branch deletion",
        "git push --delete",
    ),
    (
        "remote-branch-delete-short",
        "Branch deletion",
        "git push -d",
    ),
    ("tag-delete", "Tag deletion", "git tag -d"),
    ("pr-merge", "Merging a pull request", "gh pr merge"),
    ("repo-delete", "Deleting a repository", "gh repo delete"),
    (
        "api-delete",
        "Deleting through the GitHub API",
        "gh api -X delete",
    ),
    (
        "api-delete-long",
        "Deleting through the GitHub API",
        "gh api --method delete",
    ),
    ("s3-rm", "Deleting cloud data", "aws s3 rm"),
    (
        "kubectl-delete",
        "Deleting cloud resources",
        "kubectl delete",
    ),
    (
        "terraform-destroy",
        "Deleting cloud resources",
        "terraform destroy",
    ),
    ("sudo", "Running as another user", "sudo"),
    ("su", "Running as another user", "su"),
    ("doas", "Running as another user", "doas"),
    ("printenv", "Reading the environment", "printenv"),
    ("env-dump", "Reading the environment", "env ;"),
    ("echo-token", "Reading a secret", "echo $*token*"),
    ("echo-secret", "Reading a secret", "echo $*secret*"),
    ("echo-key", "Reading a secret", "echo $*key*"),
    ("echo-password", "Reading a secret", "echo $*password*"),
    ("rm-recursive", "Recursive deletion", "rm -r"),
    ("rm-recursive-upper", "Recursive deletion", "rm -R"),
    ("rm-recursive-long", "Recursive deletion", "rm --recursive"),
    ("find-delete", "Deletion by find", "find -delete"),
    ("find-exec", "Deletion by find", "find -exec*"),
    ("dd", "Raw disk writes", "dd"),
    ("shred", "Destroying files", "shred"),
    ("chmod-recursive", "Recursive permission change", "chmod -R"),
    ("chown-recursive", "Recursive owner change", "chown -R"),
    ("curl-sh", "A download run by a shell", "curl | *sh"),
    ("wget-sh", "A download run by a shell", "wget | *sh"),
    ("shell-curl", "A download run by a shell", "*sh ( curl"),
    ("shell-wget", "A download run by a shell", "*sh ( wget"),
    ("upload-data", "Uploading a file", "curl -d @*"),
    ("upload-data-long", "Uploading a file", "curl --data* @*"),
    ("upload-form", "Uploading a file", "curl -F *@*"),
    ("upload-file", "Uploading a file", "curl -T"),
    ("upload-file-long", "Uploading a file", "curl --upload-file"),
    ("scp", "Copying to another machine", "scp"),
    ("rsync-remote", "Copying to another machine", "rsync *:*"),
    ("drop-table", "Dropping data", "drop table"),
    ("drop-database", "Dropping data", "drop database"),
    ("drop-schema", "Dropping data", "drop schema"),
    ("truncate-table", "Dropping data", "truncate table"),
    ("npm-publish", "Publishing", "npm publish"),
    ("pnpm-publish", "Publishing", "pnpm publish"),
    ("yarn-publish", "Publishing", "yarn publish"),
    ("vp-publish", "Publishing", "vp publish"),
    ("cargo-publish", "Publishing", "cargo publish"),
    ("twine-upload", "Publishing", "twine upload"),
    ("poetry-publish", "Publishing", "poetry publish"),
    ("uv-publish", "Publishing", "uv publish"),
    ("gem-push", "Publishing", "gem push"),
    ("docker-push", "Publishing", "docker push"),
    ("podman-push", "Publishing", "podman push"),
    ("helm-push", "Publishing", "helm push"),
    ("vsce-publish", "Publishing", "vsce publish"),
    ("release", "Releasing", "gh release create"),
    ("avalon-publish", "Publishing", "avalon publish"),
    ("workflow-run", "Spending CI minutes", "gh workflow run"),
    ("workflow-rerun", "Spending CI minutes", "gh run rerun"),
    ("ssh", "Credential access", "*.ssh/*"),
    ("dotenv", "Credential access", ".env*"),
    ("npmrc", "Credential access", "*.npmrc"),
    ("netrc", "Credential access", "*.netrc"),
    ("credentials", "Credential access", "*credentials*"),
    ("private-key", "Credential access", "*.pem"),
    ("key-file", "Credential access", "*.key"),
    ("id-rsa", "Credential access", "*id_rsa*"),
    ("id-ed25519", "Credential access", "*id_ed25519*"),
    ("aws", "Credential access", "*.aws/*"),
    (
        "git-hooks",
        "Changing the repository's hooks",
        "*.git/hooks*",
    ),
    (
        "git-config",
        "Changing the repository's settings",
        "*.git/config",
    ),
    ("workflows", "Changing CI workflows", "*.github/workflows*"),
    ("claude", "Changing agent settings", "*.claude/*"),
    ("codex", "Changing agent settings", "*.codex/*"),
    ("agents", "Changing agent settings", "*.agents/*"),
];

fn defaults() -> Vec<DangerRule> {
    let rule = |id: &str, label: &str, category: &str, when: Option<&str>| DangerRule {
        id: id.into(),
        label: label.into(),
        category: category.into(),
        words: Vec::new(),
        when: when.map(Into::into),
    };
    let mut rules = vec![
        rule(
            "delete-outside-grant",
            "Deleting outside the delete list",
            "*",
            Some("delete-outside-grant"),
        ),
        rule(
            "write-outside-worktree",
            "Writing outside the worktree",
            "file-change",
            Some("outside-workspace"),
        ),
        rule(
            "command-outside-worktree",
            "Reaching outside the worktree",
            "command",
            Some("outside-workspace"),
        ),
        rule(
            "read-outside-worktree",
            "Reading outside the worktree",
            "file-read",
            Some("outside-workspace"),
        ),
        rule("permission", "A change of permissions", "permission", None),
        rule(
            "mcp-elicitation",
            "A tool asking for input",
            "mcp-elicitation",
            None,
        ),
    ];
    rules.extend(WORDS.iter().map(|(id, label, words)| DangerRule {
        words: words.split_whitespace().map(Into::into).collect(),
        ..rule(id, label, "*", None)
    }));
    rules
}

pub(crate) fn list(tx: &Transaction<'_>) -> Result<Vec<DangerRule>> {
    Ok(store::get(tx, "system", "dangerList")?.unwrap_or_else(defaults))
}

pub(crate) fn get(tx: &Transaction<'_>) -> Result<Value> {
    Ok(json!({"rules":list(tx)?}))
}

/// The owner edits the list; nobody else can, and a lifted line is lifted only for one grant.
pub(crate) fn set(tx: &Transaction<'_>, parameters: &Value, revision: u64) -> Result<Value> {
    user(parameters)?;
    let rules: Vec<DangerRule> = decode(parameters, "rules")?;
    if rules.len() > 200 {
        return Err(Error::invalid("Too many danger rules"));
    }
    for (index, rule) in rules.iter().enumerate() {
        identifier(&rule.id)?;
        plain_label(&rule.label)?;
        text(&rule.category, 80, "category")?;
        if rules[..index].iter().any(|other| other.id == rule.id) {
            return Err(Error::invalid("Danger rule ids must be unique"));
        }
        if rule.words.len() > 16 {
            return Err(Error::invalid("Too many words in a danger rule"));
        }
        for word in &rule.words {
            text(word, 256, "word")?;
        }
        if rule
            .when
            .as_deref()
            .is_some_and(|when| !CONDITIONS.contains(&when))
        {
            return Err(Error::invalid("Unknown danger condition"));
        }
        if rule.category == "*" && rule.words.is_empty() && rule.when.is_none() {
            return Err(Error::invalid(
                "A danger rule over every request needs words or a condition",
            ));
        }
    }
    store::put(tx, "system", "dangerList", &rules, revision)?;
    grant::changed(tx, revision)?;
    Ok(json!({"rules":rules}))
}

/// The owner goes back to the shipped list, and with it to whatever later versions ship.
pub(crate) fn reset(tx: &Transaction<'_>, parameters: &Value, revision: u64) -> Result<Value> {
    user(parameters)?;
    store::remove(tx, "system", "dangerList", revision)?;
    grant::changed(tx, revision)?;
    get(tx)
}

fn glob(pattern: &[u8], text: &[u8]) -> bool {
    match pattern.split_first() {
        None => text.is_empty(),
        Some((b'*', rest)) => (0..=text.len()).any(|skip| glob(rest, &text[skip..])),
        Some((first, rest)) => text
            .split_first()
            .is_some_and(|(head, tail)| head == first && glob(rest, tail)),
    }
}

const SEPARATORS: [&str; 3] = [";", "|", "&"];

/// Words of a command, quotes dropped so a script handed to a shell is read too, with the
/// characters that join or nest commands as words of their own.
fn tokens(command: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    for character in command.chars() {
        if character == '"' || character == '\'' || character == '\\' {
            continue;
        }
        if character.is_whitespace() || "|;&()<>`".contains(character) {
            if !current.is_empty() {
                tokens.push(std::mem::take(&mut current));
            }
            match character {
                '\n' | ';' => tokens.push(";".into()),
                '`' => tokens.push("(".into()),
                character if !character.is_whitespace() => tokens.push(character.into()),
                _ => {}
            }
        } else {
            current.push(character);
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens.push(";".into());
    tokens
}

/// A flag word is exact in case, and `-x` matches any cluster of short flags holding `x`; `;`
/// matches the end of a command; other words ignore case, and a word with a folder also matches
/// by its last part, so `/bin/rm` is `rm`.
fn word_matches(word: &str, token: &str) -> bool {
    if word == ";" {
        return SEPARATORS.contains(&token);
    }
    if let Some(flag) = word
        .strip_prefix('-')
        .filter(|flag| flag.len() == 1 && flag.chars().all(char::is_alphanumeric))
    {
        return token.starts_with('-') && !token.starts_with("--") && token[1..].contains(flag);
    }
    if word.starts_with('-') {
        return glob(word.as_bytes(), token.as_bytes());
    }
    let (word, token) = (word.to_lowercase(), token.to_lowercase());
    glob(word.as_bytes(), token.as_bytes())
        || token
            .rsplit_once('/')
            .is_some_and(|(_, last)| !last.is_empty() && glob(word.as_bytes(), last.as_bytes()))
}

/// The words in order, at any place in the command; `;` must follow the word before it.
fn in_order(words: &[String], tokens: &[String]) -> bool {
    let mut at = 0;
    for (index, word) in words.iter().enumerate() {
        if word == ";" && index > 0 {
            if !tokens
                .get(at)
                .is_some_and(|token| word_matches(word, token))
            {
                return false;
            }
            at += 1;
            continue;
        }
        match tokens[at..]
            .iter()
            .position(|token| word_matches(word, token))
        {
            Some(found) => at += found + 1,
            None => return false,
        }
    }
    true
}

fn strings<'a>(request: &'a Value, key: &str) -> Vec<&'a str> {
    request
        .get(key)
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default()
}

/// The first line of the danger list a request under a grant falls under, unless the grant lifted it.
pub(crate) fn matching(rules: &[DangerRule], request: &Value, grant: &Grant) -> Option<DangerRule> {
    let category = request
        .get("category")
        .and_then(Value::as_str)
        .unwrap_or("");
    let mut paths = strings(request, "paths");
    paths.extend(request.get("resource").and_then(Value::as_str));
    let deletes = strings(request, "deletes");
    paths.extend(&deletes);
    let mut candidates = paths
        .iter()
        .map(|path| vec![(*path).to_owned()])
        .collect::<Vec<_>>();
    if let Some(command) = request.get("command").and_then(Value::as_str) {
        candidates.push(tokens(command));
    }
    rules
        .iter()
        .filter(|rule| !grant.lifts.contains(&rule.id))
        .find(|rule| {
            (rule.category == "*" || rule.category == category)
                && match rule.when.as_deref() {
                    Some("outside-workspace") => request["outsideWorkspace"] == true,
                    Some("delete-outside-grant") => deletes
                        .iter()
                        .any(|path| !grant::covers(path, &grant.delete)),
                    _ => true,
                }
                && (rule.words.is_empty()
                    || candidates
                        .iter()
                        .any(|candidate| in_order(&rule.words, candidate)))
        })
        .cloned()
}
