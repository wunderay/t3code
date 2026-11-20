use crate::{
    Error, Result, config, danger, decode, field, identifier, model::Scope, policy,
    policy_revision, store, text,
};
use rusqlite::Transaction;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// What the owner allowed: where a thread may work, what it may delete, and how far its access goes.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Grant {
    pub id: String,
    pub scope: Scope,
    /// Folders relative to the project folder; none, or `.`, means the whole project.
    #[serde(default)]
    pub folders: Vec<String>,
    #[serde(default)]
    pub delete: Vec<String>,
    #[serde(default = "workspace")]
    pub max_access: u8,
    /// Lines of the danger list this grant lets the host answer; only the owner lifts one.
    #[serde(default)]
    pub lifts: Vec<String>,
    #[serde(default)]
    pub expires_at: Option<u64>,
    #[serde(default)]
    pub revoked: bool,
    #[serde(default)]
    pub actor: String,
    #[serde(default)]
    pub source_message_id: Option<String>,
    #[serde(default)]
    pub source_message_at: Option<u64>,
    #[serde(default)]
    pub revision: u64,
}

const DAY: u64 = 86_400_000;
/// The project folder itself, as a grant spells it.
const ROOT: &str = ".";

fn workspace() -> u8 {
    1
}

fn relative_paths(paths: &[String], name: &str) -> Result<()> {
    if paths.len() > 100 {
        return Err(Error::invalid(format!("Too many {name} entries")));
    }
    for path in paths {
        text(path, 1024, name)?;
        let parts = path.split(['\\', '/']).collect::<Vec<_>>();
        if path.starts_with(['/', '\\']) || path.get(1..2) == Some(":") || parts.contains(&"..") {
            return Err(Error::invalid(format!(
                "{name} entries must be relative to the repository and stay inside it"
            )));
        }
    }
    Ok(())
}

/// A grant's paths as changed files and requests spell theirs: `./src` would cover nothing.
fn plain_paths(paths: &[String], name: &str) -> Result<()> {
    relative_paths(paths, name)?;
    if paths
        .iter()
        .any(|path| path != ROOT && path.split(['\\', '/']).any(|part| part == ROOT))
    {
        return Err(Error::invalid(format!(
            "A {name} entry is a path inside the project without \"./\", or \".\" for the whole project"
        )));
    }
    Ok(())
}

/// A path is inside a boundary when it is the boundary or below it; everything that stays in
/// the project is inside its root.
pub(crate) fn within(path: &str, boundary: &str) -> bool {
    let boundary = boundary.trim_end_matches(['\\', '/']);
    if boundary == ROOT {
        return relative_paths(&[path.to_owned()], "path").is_ok();
    }
    path == boundary
        || path
            .strip_prefix(boundary)
            .is_some_and(|rest| rest.starts_with(['\\', '/']))
}

pub(crate) fn covers(path: &str, boundaries: &[String]) -> bool {
    boundaries.iter().any(|boundary| within(path, boundary))
}

/// True when `next` allows anything `previous` did not.
fn widens(previous: &Grant, next: &Grant) -> bool {
    next.scope != previous.scope
        || next.max_access > previous.max_access
        || (!previous.folders.is_empty()
            && (next.folders.is_empty()
                || next
                    .folders
                    .iter()
                    .any(|folder| !covers(folder, &previous.folders))))
        || next
            .delete
            .iter()
            .any(|path| !covers(path, &previous.delete))
        || next.lifts.iter().any(|id| !previous.lifts.contains(id))
        || previous
            .expires_at
            .is_some_and(|expiry| next.expires_at.is_none_or(|next| next > expiry))
}

const NEGATIONS: [&str; 10] = [
    "not",
    "don't",
    "dont",
    "never",
    "except",
    "excluding",
    "exclude",
    "without",
    "avoid",
    "no",
];

/// The owner's message names `path` as a whole path, not as part of a longer one, and never in a
/// clause that rules it out ("don't touch X", "except X", "not X").
fn named(text: &str, path: &str) -> bool {
    let inner = |c: char| c.is_alphanumeric() || matches!(c, '/' | '\\' | '_' | '-' | '.');
    let mut mentions = text.match_indices(path).filter(|(start, _)| {
        let before = text[..*start].chars().next_back();
        let rest = &text[start + path.len()..];
        let mut after = rest.chars();
        let whole_end = match after.next() {
            None => true,
            // A full stop ends a sentence; one followed by more of a name lengthens the path.
            Some('.') => !after.next().is_some_and(|c| c.is_alphanumeric()),
            Some(c) => !inner(c),
        };
        before.is_none_or(|c| !inner(c)) && whole_end
    });
    let mut any = false;
    let ruled_out = mentions.any(|(start, _)| {
        any = true;
        ruled_out_by(&text[..start])
    });
    any && !ruled_out
}

/// The clause that ends here rules out what follows it; "nothing except" and "nothing but"
/// name what they leave.
fn ruled_out_by(before: &str) -> bool {
    let clause = before
        .rsplit(['.', ';', '!', '?', '\n', ','])
        .next()
        .unwrap_or("")
        .to_lowercase();
    let words = clause
        .split(|c: char| !(c.is_alphanumeric() || c == '\''))
        .collect::<Vec<_>>();
    let negations = words
        .iter()
        .filter(|word| NEGATIONS.contains(word))
        .collect::<Vec<_>>();
    let leaves = words
        .iter()
        .skip_while(|word| **word != "nothing")
        .any(|word| ["except", "but"].contains(word));
    !(negations.is_empty() || leaves && negations.iter().all(|word| **word == "except"))
}

/// Takes one of the phrases off the front of the words, the first that fits.
fn take(rest: &mut &[&str], phrases: &[&str]) -> bool {
    for phrase in phrases {
        let count = phrase.split(' ').count();
        if rest.len() >= count && phrase.split(' ').eq(rest[..count].iter().copied()) {
            *rest = &rest[count..];
            return true;
        }
    }
    false
}

/// The sentence gives the whole project and says nothing else: "You may work in the whole
/// project folder." One fixed shape, since any other word may narrow the grant.
fn gives_root(sentence: &[&str]) -> bool {
    let mut words = Vec::new();
    for token in sentence {
        let word = token.trim_end_matches(['.', '!', ',']);
        if word.is_empty() || !word.chars().all(char::is_alphabetic) {
            return false;
        }
        words.push(word);
    }
    let rest = &mut &words[..];
    take(rest, &["please"]);
    let mut said = take(
        rest,
        &[
            "you may",
            "you can",
            "go ahead and",
            "feel free to",
            "i give you",
            "i grant you",
        ],
    );
    said |= take(rest, &["work", "edit", "write", "change", "modify", "use"]);
    take(
        rest,
        &["anywhere in", "in", "on", "inside", "within", "across"],
    );
    if !(take(rest, &["the", "this"])
        && take(rest, &["whole", "entire"])
        && take(rest, &["project", "repository", "repo", "folder"]))
    {
        return false;
    }
    take(rest, &["folder"]);
    // "The whole project." alone gives nothing: it may answer what is off limits.
    said |= take(rest, &["is yours"]);
    take(rest, &["please", "thanks", "thank you"]);
    said && rest.is_empty()
}

/// The sentence only deletes named paths: "Then delete the file notes/old.txt and tmp/."
fn deletes_paths(sentence: &[&str]) -> bool {
    let words: Vec<&str> = sentence
        .iter()
        .map(|token| token.trim_end_matches(['.', '!', ',']))
        .collect();
    let rest = &mut &words[..];
    take(rest, &["please", "then", "also"]);
    if !take(rest, &["delete", "remove"]) {
        return false;
    }
    take(rest, &["the"]);
    take(rest, &["file", "files", "folder"]);
    let path = |word: &str| {
        word.contains(['/', '\\', '.'])
            && !word.contains("..")
            && !word.starts_with('-')
            && word
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "_-./\\".contains(c))
    };
    let mut named = false;
    while let Some((word, more)) = rest.split_first() {
        *rest = more;
        if *word == "and" && named && !more.is_empty() {
            named = false;
        } else if path(word) {
            named = true;
        } else {
            return false;
        }
    }
    named
}

/// The owner's message gives the whole project in exactly one sentence of a fixed shape, and
/// every other sentence only deletes named paths. Anything else, a question included, may
/// narrow or withdraw the grant in words no list foresees, so it is proposed instead.
fn names_root(text: &str) -> bool {
    if text.contains('?') {
        return false;
    }
    let text = text.to_lowercase();
    let mut given = 0;
    for line in text.lines() {
        let mut sentence: Vec<&str> = Vec::new();
        let mut tokens = line.split_whitespace().peekable();
        while let Some(token) = tokens.next() {
            sentence.push(token);
            if !(token.ends_with(['.', '!']) || tokens.peek().is_none()) {
                continue;
            }
            if gives_root(&sentence) {
                given += 1;
            } else if !deletes_paths(&sentence) {
                return false;
            }
            sentence.clear();
        }
    }
    given == 1
}

fn live(grant: &Grant, now: u64) -> bool {
    !grant.revoked && grant.expires_at.is_none_or(|expiry| expiry > now)
}

/// A grant changes what the host may answer, so it invalidates answers queued under the old one.
pub(crate) fn changed(tx: &Transaction<'_>, revision: u64) -> Result<()> {
    store::put(tx, "system", "policyRevision", &revision, revision)?;
    policy::invalidate_queued_approvals(tx, revision)
}

pub(crate) fn set(
    tx: &Transaction<'_>,
    parameters: &Value,
    revision: u64,
    now: u64,
) -> Result<Value> {
    let mut grant: Grant = decode(parameters, "grant")?;
    identifier(&grant.id)?;
    policy::valid_scope(&grant.scope, true)?;
    plain_paths(&grant.folders, "folder")?;
    plain_paths(&grant.delete, "delete")?;
    if grant.max_access > 2 {
        return Err(Error::invalid(
            "maxAccess must be 0 (read), 1 (workspace), or 2 (full)",
        ));
    }
    if grant.expires_at.is_some_and(|expiry| expiry <= now) {
        return Err(Error::invalid("Grant expiry must be in the future"));
    }
    let rules = danger::list(tx)?;
    if grant
        .lifts
        .iter()
        .any(|id| !rules.iter().any(|rule| &rule.id == id))
    {
        return Err(Error::invalid(
            "A grant can lift only a line of the danger list",
        ));
    }
    let previous = store::get::<Grant>(tx, "grant", &grant.id)?;
    let actor = parameters
        .get("actor")
        .and_then(Value::as_str)
        .unwrap_or("");
    grant.source_message_id = None;
    grant.source_message_at = None;
    match actor {
        "user" => {}
        "coordinator" => {
            // The host has already checked that the owner typed this message in the Coordinator's
            // thread; the Coordinator cannot grant anything on its own word.
            let message = field(parameters, "sourceMessageId")?;
            identifier(message)?;
            grant.expires_at.get_or_insert(now + DAY);
            if !grant.lifts.is_empty() {
                return Err(Error::forbidden(
                    "Lifting a line of the danger list needs the owner's own confirmation",
                ));
            }
            if !["project", "thread", "assignment"].contains(&grant.scope.kind.as_str()) {
                return Err(Error::forbidden(
                    "A grant beyond one project needs the owner's own confirmation",
                ));
            }
            let configuration = config(tx)?;
            if grant.scope.kind == "thread"
                && grant.scope.id.is_some()
                && grant.scope.id == configuration.coordinator_thread_id
            {
                return Err(Error::forbidden(
                    "The Coordinator cannot grant itself access",
                ));
            }
            if previous
                .as_ref()
                .is_some_and(|previous| !live(previous, now) || widens(previous, &grant))
            {
                return Err(Error::forbidden(
                    "Only the owner can widen or renew a grant",
                ));
            }
            if all(tx)?.iter().any(|other| {
                other.id != grant.id && other.source_message_id.as_deref() == Some(message)
            }) {
                return Err(Error::conflict("That message already made another grant"));
            }
            let at = parameters
                .get("sourceMessageAt")
                .and_then(Value::as_u64)
                .ok_or_else(|| Error::invalid("Missing sourceMessageAt"))?;
            if all(tx)?
                .iter()
                .any(|other| other.source_message_at.is_some_and(|earlier| earlier >= at))
            {
                return Err(Error::conflict(
                    "A grant was already made from a later message",
                ));
            }
            // The owner's words bound what the Coordinator may record: what they did not write
            // is only proposed to them.
            let text = field(parameters, "sourceMessageText")?;
            // The whole project is given in words, never by a full stop; deleting all of it is
            // the owner's to confirm.
            let unsaid = grant
                .folders
                .iter()
                .filter(|path| !(*path == ROOT && names_root(text)))
                .chain(&grant.delete)
                .find(|path| *path == ROOT || !named(text, path));
            let answered = parameters
                .get("sourceMessageAnswered")
                .and_then(Value::as_bool)
                == Some(true);
            let reason = if answered {
                Some(
                    "The Coordinator already replied to that message; the owner confirms"
                        .to_owned(),
                )
            } else if grant.max_access > 1 {
                Some("More than workspace access needs the owner".to_owned())
            } else if grant.folders.is_empty() {
                Some(
                    "A grant from a message names its folders; \".\" is the whole project"
                        .to_owned(),
                )
            } else if grant.expires_at.is_some_and(|expiry| expiry > now + DAY) {
                Some("A grant from a message lasts at most a day".to_owned())
            } else {
                unsaid.map(|path| {
                    format!("The owner's message does not name {path}, or rules it out")
                })
            };
            if let Some(reason) = reason {
                // Said by the Coordinator, so it reads as a whole grant the owner can confirm.
                grant.actor = actor.into();
                // Kept until the owner grants or dismisses it, a newer one for the same target
                // replaces it, or that thread settles; so it waits for them in the thread.
                for (id, _) in proposals(tx)?
                    .into_iter()
                    .filter(|(_, scope)| *scope == grant.scope)
                {
                    store::remove(tx, "grantProposal", &id, revision)?;
                }
                store::put(
                    tx,
                    "grantProposal",
                    &grant.id,
                    &json!({"grant":grant,"reason":reason,"sourceMessageId":message}),
                    revision,
                )?;
                return Ok(json!({"proposal":grant,"reason":reason}));
            }
            grant.source_message_id = Some(message.into());
            grant.source_message_at = Some(at);
        }
        _ => return Err(Error::forbidden("Unknown grant actor")),
    }
    if previous.is_none() && store::count(tx, "grant", "1")? >= 4096 {
        return Err(Error::conflict("Grant limit reached"));
    }
    if actor == "user" && store::get::<Value>(tx, "grantProposal", &grant.id)?.is_some() {
        store::remove(tx, "grantProposal", &grant.id, revision)?;
    }
    grant.actor = actor.into();
    grant.revoked = false;
    grant.revision = revision;
    store::put(tx, "grant", &grant.id, &grant, revision)?;
    changed(tx, revision)?;
    Ok(json!({"grant":grant,"policyRevision":policy_revision(tx)?}))
}

fn all(tx: &Transaction<'_>) -> Result<Vec<Grant>> {
    if store::count(tx, "grant", "1")? > 4096 {
        return Err(Error::conflict(
            "Grant registry exceeds safe evaluation limit",
        ));
    }
    store::list(tx, "grant", "1", "", 4096)
}

/// Withdrawing only narrows, so the Coordinator may withdraw as well as the owner.
pub(crate) fn withdraw(tx: &Transaction<'_>, parameters: &Value, revision: u64) -> Result<Value> {
    if !["user", "coordinator"].contains(
        &parameters
            .get("actor")
            .and_then(Value::as_str)
            .unwrap_or(""),
    ) {
        return Err(Error::forbidden("Unknown grant actor"));
    }
    let mut grant: Grant = store::required(tx, "grant", field(parameters, "id")?)?;
    grant.revoked = true;
    grant.revision = revision;
    store::put(tx, "grant", &grant.id, &grant, revision)?;
    changed(tx, revision)?;
    Ok(json!({"grant":grant}))
}

fn proposals(tx: &Transaction<'_>) -> Result<Vec<(String, Scope)>> {
    Ok(
        store::list::<Value>(tx, "grantProposal", "1", "", i64::MAX as usize)?
            .into_iter()
            .filter_map(|proposal| {
                let grant: Grant = serde_json::from_value(proposal["grant"].clone()).ok()?;
                Some((grant.id, grant.scope))
            })
            .collect(),
    )
}

/// A settled thread needs no grant, so what was proposed for it, or its assignment, goes.
pub(crate) fn forget_proposals_for(
    tx: &Transaction<'_>,
    card: &crate::model::Card,
    revision: u64,
) -> Result<()> {
    for (id, scope) in proposals(tx)? {
        let target = scope.id.as_deref();
        if (scope.kind == "thread" && target == Some(card.thread_id.as_str()))
            || (scope.kind == "assignment"
                && target.is_some()
                && target == card.assignment_id.as_deref())
        {
            store::remove(tx, "grantProposal", &id, revision)?;
        }
    }
    Ok(())
}

/// The owner declines a grant the Coordinator proposed.
pub(crate) fn dismiss(tx: &Transaction<'_>, parameters: &Value, revision: u64) -> Result<Value> {
    crate::user(parameters)?;
    let id = field(parameters, "id")?;
    store::required::<Value>(tx, "grantProposal", id)?;
    store::remove(tx, "grantProposal", id, revision)?;
    Ok(json!({}))
}

/// The most specific live grant over delegated work. A thread a person drives is never under
/// one (the owner: threads work as they do without the Coordinator), nor is the Coordinator's.
pub(crate) fn covering(
    tx: &Transaction<'_>,
    parameters: &Value,
    now: u64,
) -> Result<Option<Grant>> {
    let thread = parameters.get("threadId").and_then(Value::as_str);
    if parameters
        .get("assignmentId")
        .and_then(Value::as_str)
        .is_none()
        || (thread.is_some() && thread == config(tx)?.coordinator_thread_id.as_deref())
    {
        return Ok(None);
    }
    Ok(all(tx)?
        .into_iter()
        .filter(|grant| live(grant, now))
        .filter_map(|grant| policy::scope_rank(&grant.scope, parameters).map(|rank| (rank, grant)))
        .max_by_key(|(rank, grant)| (*rank, grant.revision))
        .map(|(_, grant)| grant))
}

pub(crate) fn resolve(tx: &Transaction<'_>, parameters: &Value, now: u64) -> Result<Value> {
    Ok(json!({"grant":covering(tx, parameters, now)?}))
}

/// What can be read of a request stays inside the grant: its paths, deletions and workspace.
pub(crate) fn readably_inside(grant: &Grant, request: &Value) -> bool {
    let strings = |key: &str| {
        request
            .get(key)
            .and_then(Value::as_array)
            .map(|items| items.iter().map(Value::as_str).collect::<Option<Vec<_>>>())
            .unwrap_or(Some(Vec::new()))
    };
    let (Some(mut paths), Some(deletes)) = (strings("paths"), strings("deletes")) else {
        return false;
    };
    paths.extend(request.get("resource").and_then(Value::as_str));
    let relative = |path: &&str| {
        relative_paths(&[(*path).to_owned()], "path").is_ok() && !path.starts_with(['~', '$'])
    };
    request.get("outsideWorkspace").and_then(Value::as_bool) != Some(true)
        && paths.iter().all(|path| {
            relative(path) && (grant.folders.is_empty() || covers(path, &grant.folders))
        })
        && deletes
            .iter()
            .all(|path| relative(path) && covers(path, &grant.delete))
}

/// Inside a grant: within its access and folders, inside the checkout, deleting only what it lists.
pub(crate) fn inside(grant: &Grant, request: &Value, requested: u64) -> bool {
    let strings = |key: &str| {
        request
            .get(key)
            .and_then(Value::as_array)
            .map(|items| items.iter().map(Value::as_str).collect::<Option<Vec<_>>>())
            .unwrap_or(Some(Vec::new()))
    };
    let paths = strings("paths").unwrap_or_default().len()
        + usize::from(request.get("resource").and_then(Value::as_str).is_some());
    request.get("unparsed").and_then(Value::as_bool) != Some(true)
        && requested <= u64::from(grant.max_access)
        && request
            .get("accessIncreaseUnknown")
            .and_then(Value::as_bool)
            == Some(false)
        && paths > 0
        && readably_inside(grant, request)
}
