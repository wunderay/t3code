pub mod board;
mod danger;
mod events;
mod grant;
mod merge;
pub mod model;
mod policy;
mod registry;
mod remote;
mod repairs;
mod results;
mod router;
mod routing;
mod settlement;
mod store;
mod supervision;
mod view;

use model::*;
use rusqlite::{Connection, Transaction, TransactionBehavior, params};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::{
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Clone, Debug, Serialize)]
pub struct Error {
    pub code: i32,
    pub message: String,
}

impl Error {
    pub fn invalid(message: impl Into<String>) -> Self {
        Self {
            code: -32602,
            message: message.into(),
        }
    }
    pub fn parse(message: impl Into<String>) -> Self {
        Self {
            code: -32700,
            message: message.into(),
        }
    }
    pub fn conflict(message: impl Into<String>) -> Self {
        Self {
            code: -32009,
            message: message.into(),
        }
    }
    pub fn forbidden(message: impl Into<String>) -> Self {
        Self {
            code: -32003,
            message: message.into(),
        }
    }
    pub fn not_found(message: impl Into<String>) -> Self {
        Self {
            code: -32004,
            message: message.into(),
        }
    }
    pub fn internal(error: impl std::fmt::Display) -> Self {
        Self {
            code: -32603,
            message: error.to_string(),
        }
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for Error {}

pub struct Supervisor {
    connection: Connection,
}

impl Supervisor {
    pub fn open(path: &Path) -> Result<Self> {
        Ok(Self {
            connection: store::open(path)?,
        })
    }

    pub fn call(&mut self, method: &str, parameters: Value) -> Result<Value> {
        self.call_at(method, parameters, now())
    }

    pub fn call_at(&mut self, method: &str, parameters: Value, now: u64) -> Result<Value> {
        if !parameters.is_object() {
            return Err(Error::invalid("params must be an object"));
        }
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(Error::internal)?;
        let revision = store::revision(&tx)?
            .checked_add(1)
            .ok_or_else(|| Error::internal("Revision exhausted"))?;
        if let Some(expected) = parameters.get("expectedRevision").and_then(Value::as_u64)
            && expected.checked_add(1) != Some(revision)
        {
            return Err(Error::conflict(
                "Supervisor revision changed; reload before retrying",
            ));
        }
        let event_id = parameters.get("eventId").and_then(Value::as_str);
        let fingerprint = format!(
            "{method}:{}",
            serde_json::to_string(&parameters).map_err(Error::internal)?
        );
        if let Some(event_id) = event_id {
            identifier(event_id)?;
            let mut statement = tx
                .prepare("SELECT fingerprint,result FROM inbox WHERE id=?1")
                .map_err(Error::internal)?;
            let mut rows = statement.query([event_id]).map_err(Error::internal)?;
            if let Some(row) = rows.next().map_err(Error::internal)? {
                let previous: String = row.get(0).map_err(Error::internal)?;
                if previous != fingerprint {
                    return Err(Error::conflict(
                        "eventId was already used for another event",
                    ));
                }
                let result: String = row.get(1).map_err(Error::internal)?;
                return serde_json::from_str(&result).map_err(Error::internal);
            }
        }
        let result = match method {
            "snapshot" => snapshot(&tx, &parameters)
                .and_then(|snapshot| policy::with_routes(&tx, snapshot, now))
                .and_then(|snapshot| board::with_reached(&tx, snapshot, now)),
            "configure" => configure(&tx, &parameters, revision, now),
            "proof.record" => record_proof(&tx, &parameters, revision, now),
            "guidance.save" => registry::save_guidance(&tx, &parameters, revision),
            "guidance.notes.save" => registry::save_coordinator_notes(&tx, &parameters, revision),
            "cards.sync" => registry::sync_cards(&tx, &parameters, revision),
            "cards.list" => list_cards(&tx, &parameters),
            "cards.find" => find_card(&tx, &parameters),
            "cards.get" => {
                Ok(json!({"card":store::required::<Card>(&tx,"card",field(&parameters,"id")?)?}))
            }
            "cards.settle" => registry::settle(&tx, &parameters, revision, true),
            "cards.reopen" => registry::settle(&tx, &parameters, revision, false),
            "goals.get" => {
                Ok(json!({"goal":store::required::<Goal>(&tx,"goal",field(&parameters,"id")?)?}))
            }
            "goals.upsert" => registry::upsert_goal(&tx, &parameters, revision),
            "goals.block" => registry::block_goal(&tx, &parameters, revision),
            "goals.resolve" => registry::resolve_goal(&tx, &parameters, revision, now),
            "goals.merged" => merge::merged(&tx, &parameters, revision, now),
            "merges.list" => merge::list(&tx),
            "merges.local" => merge::local(&parameters),
            "merges.contains" => merge::contains(&parameters),
            "merges.reverts" => merge::reverts(&tx, &parameters),
            "merges.reverted" => merge::reverted(&tx, &parameters, revision, now),
            "merges.wait" => merge::wait(&tx, &parameters, revision, now),
            "merges.rereview" => merge::rereview(&tx, &parameters, revision, now),
            "goals.list" => page::<Goal>(&tx, "goal", "1", &parameters),
            "board.next" => board::next(&tx, &parameters, revision, now),
            "board.budget" => board::set_budget(&tx, &parameters, revision),
            "board.limits" => board::set_limits(&tx, &parameters, revision),
            "board.view" => view::board(&tx, &parameters, now),
            "decisions.record" => registry::record_decision(&tx, &parameters, revision),
            "decisions.list" => page::<Decision>(&tx, "decision", "1", &parameters),
            "decisions.get" => Ok(
                json!({"decision":store::get::<Decision>(&tx,"decision",field(&parameters,"id")?)?}),
            ),
            "permissions.set" => policy::set_policy(&tx, &parameters, revision, now),
            "permissions.preset.save" => policy::save_preset(&tx, &parameters, revision, now),
            "permissions.preset.apply" => policy::apply_preset(&tx, &parameters, revision, now),
            "permissions.preset.delete" => policy::delete_preset(&tx, &parameters, revision),
            "permissions.effective" => policy::effective(&tx, &parameters, now),
            "permissions.preview" => policy::preview(&tx, &parameters, now),
            "permissions.request" => policy::request(&tx, &parameters, revision),
            "permissions.decide" => policy::decide(&tx, &parameters, revision, now),
            "permissions.pass" => policy::pass(&tx, &parameters, revision, now),
            "grants.set" => grant::set(&tx, &parameters, revision, now),
            "grants.withdraw" => grant::withdraw(&tx, &parameters, revision),
            "grants.dismiss" => grant::dismiss(&tx, &parameters, revision),
            "grants.resolve" => grant::resolve(&tx, &parameters, now),
            "danger.list" => danger::get(&tx),
            "danger.set" => danger::set(&tx, &parameters, revision),
            "danger.reset" => danger::reset(&tx, &parameters, revision),
            "results.base" => results::base(&parameters),
            "results.check" => results::check(&tx, &parameters, revision),
            "results.clean" => results::clean(&parameters),
            "results.accept" => results::accept(&tx, &parameters, revision),
            "results.discard" => results::discard(&tx, &parameters, revision, now),
            "overrides.set" => policy::set_override(&tx, &parameters, revision),
            "overrides.resolve" => policy::resolve_override(&tx, &parameters),
            "catalog.sync" => registry::sync_catalog(&tx, &parameters, revision, now),
            "catalog.source.set" => registry::set_source(&tx, &parameters, revision),
            "catalog.model.set" => registry::set_model(&tx, &parameters, revision),
            "catalog.list" => page::<CatalogModel>(&tx, "catalog", "1", &parameters),
            "catalog.refresh" => registry::refresh_catalog(&tx, &parameters, revision, now),
            "router.score" => router::score(&tx, &parameters, now),
            "router.weights.set" => router::set_weights(&tx, &parameters, revision),
            "outcomes.record" => router::record_outcome(&tx, &parameters, revision),
            "allowance.record" => router::record_allowance(&tx, &parameters, revision, now),
            "bench.set" => router::set_bench(&tx, &parameters, revision),
            "account.hold" => router::hold_account(&tx, &parameters, revision, now),
            "routing.enqueue" => routing::enqueue(&tx, &parameters, revision, now),
            "routing.ready" => routing::ready(&tx, &parameters, revision, now),
            "routing.claim" => routing::claim(&tx, &parameters, revision, now),
            "routing.cancel" => routing::cancel(&tx, &parameters, revision),
            "routing.defer" => routing::defer(&tx, &parameters, revision, now),
            "events.append" => events::append(&tx, &parameters, now),
            "events.read" => events::read(&tx, &parameters),
            "events.pending" => events::pending(&tx),
            "events.woken" => events::woken(&tx, &parameters),
            "events.position" => events::position(&tx),
            "events.confirm" => events::confirm(&tx, &parameters),
            "assignments.prepare" => {
                let result = supervision::prepare(&tx, &parameters, revision, now)?;
                // A blocked prepare made no assignment; its routing intent keeps waiting.
                if result["blocked"] != true {
                    routing::prepared(&tx, &parameters, &result["assignment"], revision)?;
                }
                Ok(result)
            }
            "assignments.update" | "assignments.ack" => {
                supervision::update(&tx, &parameters, revision, now)
            }
            "assignments.revalidate" => supervision::revalidate(&tx, &parameters, revision, now),
            "assignments.forThread" => {
                let mut statement=tx.prepare("SELECT body FROM documents WHERE kind='assignment' AND (json_extract(body,'$.cardId')=?1 OR json_extract(body,'$.idempotencyKey')=?2) LIMIT 2").map_err(Error::internal)?;
                let rows = statement
                    .query_map(
                        params![
                            field(&parameters, "cardId")?,
                            field(&parameters, "idempotencyKey")?
                        ],
                        |row| row.get::<_, String>(0),
                    )
                    .map_err(Error::internal)?;
                let items: Vec<Assignment> = rows
                    .map(|row| {
                        serde_json::from_str(&row.map_err(Error::internal)?)
                            .map_err(Error::internal)
                    })
                    .collect::<Result<_>>()?;
                if items.len() != 1 {
                    Err(Error::not_found(
                        "Assignment thread binding is missing or ambiguous",
                    ))
                } else {
                    Ok(json!({"assignment":items[0]}))
                }
            }
            "assignments.get" => {
                let item: Assignment =
                    store::required(&tx, "assignment", field(&parameters, "id")?)?;
                Ok(json!({"assignment":item}))
            }
            "assignments.list" => {
                let filter = if parameters.get("open").and_then(Value::as_bool) == Some(true) {
                    OPEN_ASSIGNMENTS
                } else {
                    "1"
                };
                page::<Assignment>(&tx, "assignment", filter, &parameters)
            }
            "assignments.cancel" => supervision::cancel(&tx, &parameters, revision, now),
            "pause" => supervision::pause(&tx, &parameters, revision, now),
            "resume" => supervision::resume(&tx, &parameters, revision, now),
            "stop" => supervision::stop(&tx, &parameters, revision, now),
            "tick" => supervision::tick(&tx, &parameters, revision, now),
            "actions.list" => {
                page::<Action>(&tx, "action", action_filter(&parameters), &parameters)
            }
            "actions.get" => Ok(
                json!({"action":store::required::<Action>(&tx,"action",field(&parameters,"id")?)?}),
            ),
            "actions.claim" => supervision::claim(&tx, &parameters, revision, now),
            "actions.ack" => supervision::ack(&tx, &parameters, revision, now),
            "settlements.unfinished" => settlement::unfinished(&tx),
            "settlements.finished" => settlement::finished(&tx, &parameters, revision),
            method if method.starts_with("remote.") => remote::call(&tx, method, &parameters, now),
            _ => Err(Error {
                code: -32601,
                message: format!("Unknown method: {method}"),
            }),
        }?;
        settlement::after(&tx, method, &parameters, &result, revision, now)?;
        if let Some(event_id) = event_id {
            tx.execute(
                "INSERT INTO inbox(id,fingerprint,result) VALUES (?1,?2,?3)",
                params![
                    event_id,
                    fingerprint,
                    serde_json::to_string(&result).map_err(Error::internal)?
                ],
            )
            .map_err(Error::internal)?;
        }
        tx.commit().map_err(Error::internal)?;
        Ok(result)
    }
}

pub(crate) fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis().try_into().unwrap_or(u64::MAX))
}

pub(crate) fn decode<T: DeserializeOwned>(parameters: &Value, key: &str) -> Result<T> {
    serde_json::from_value(
        parameters
            .get(key)
            .cloned()
            .ok_or_else(|| Error::invalid(format!("Missing {key}")))?,
    )
    .map_err(|e| Error::invalid(e.to_string()))
}

pub(crate) fn field<'a>(parameters: &'a Value, key: &str) -> Result<&'a str> {
    parameters
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| Error::invalid(format!("Missing string {key}")))
}

pub(crate) fn identifier(id: &str) -> Result<()> {
    text(id, 256, "identifier")?;
    if id.chars().any(char::is_control) {
        return Err(Error::invalid(
            "Identifiers cannot contain control characters",
        ));
    }
    Ok(())
}

pub(crate) fn text(value: &str, max: usize, name: &str) -> Result<()> {
    if value.trim().is_empty()
        || value.chars().count() > max
        || value
            .chars()
            .any(|c| c.is_control() && c != '\n' && c != '\t')
    {
        return Err(Error::invalid(format!(
            "{name} must be nonblank, at most {max} characters, without control characters"
        )));
    }
    Ok(())
}

pub(crate) fn plain_label(value: &str) -> Result<()> {
    text(value, 80, "label")?;
    if value.chars().any(char::is_control) {
        return Err(Error::invalid("Labels cannot contain control characters"));
    }
    Ok(())
}

pub(crate) fn strings(values: &[String], max_items: usize, max_chars: usize) -> Result<()> {
    if values.len() > max_items {
        return Err(Error::invalid("Too many list items"));
    }
    for value in values {
        text(value, max_chars, "list item")?;
    }
    Ok(())
}

pub(crate) fn user(parameters: &Value) -> Result<()> {
    // An owner's operation names its actor; a request that names none is not the owner's.
    if parameters.get("actor").and_then(Value::as_str) != Some("user") {
        return Err(Error::forbidden(
            "This operation requires a direct user instruction",
        ));
    }
    Ok(())
}

pub(crate) fn config(tx: &Transaction<'_>) -> Result<Configuration> {
    Ok(store::get(tx, "system", "configuration")?.unwrap_or_default())
}

pub(crate) fn pause_state(tx: &Transaction<'_>) -> Result<PauseState> {
    Ok(store::get(tx, "system", "pause")?.unwrap_or_default())
}

pub(crate) fn policy_revision(tx: &Transaction<'_>) -> Result<u64> {
    Ok(store::get(tx, "system", "policyRevision")?.unwrap_or(0))
}

fn configure(tx: &Transaction<'_>, parameters: &Value, revision: u64, now: u64) -> Result<Value> {
    user(parameters)?;
    let mut configuration = config(tx)?;
    let original_provider = configuration.coordinator_provider.clone();
    let original_model = configuration.coordinator_model.clone();
    if parameters.get("restoreLabels").and_then(Value::as_bool) == Some(true) {
        configuration.labels = Labels::default();
    }
    if let Some(patch) = parameters.get("labels") {
        let labels = patch
            .as_object()
            .ok_or_else(|| Error::invalid("labels must be an object"))?;
        for (key, value) in labels {
            let label = value
                .as_str()
                .ok_or_else(|| Error::invalid("Labels must be strings"))?;
            if key == "coordinatorNameKind" {
                if !matches!(label, "role" | "given") {
                    return Err(Error::invalid("coordinatorNameKind must be role or given"));
                }
                configuration.labels.coordinator_name_kind = Some(label.into());
                continue;
            }
            plain_label(label)?;
            let target = match key.as_str() {
                "coordinatorSingular" => &mut configuration.labels.coordinator_singular,
                "coordinatorPlural" => &mut configuration.labels.coordinator_plural,
                "threadSingular" => &mut configuration.labels.thread_singular,
                "threadPlural" => &mut configuration.labels.thread_plural,
                "profileSingular" => &mut configuration.labels.profile_singular,
                "profilePlural" => &mut configuration.labels.profile_plural,
                _ => return Err(Error::invalid(format!("Unknown label: {key}"))),
            };
            *target = label.into();
        }
    }
    for (key, target) in [
        ("enabled", &mut configuration.enabled),
        ("coordinatorPaused", &mut configuration.coordinator_paused),
        (
            "manageOtherThreads",
            &mut configuration.manage_other_threads,
        ),
    ] {
        if let Some(value) = parameters.get(key) {
            *target = value
                .as_bool()
                .ok_or_else(|| Error::invalid(format!("{key} must be boolean")))?;
        }
    }
    if parameters.get("placement").is_some() {
        configuration.placement = decode(parameters, "placement")?;
    }
    if parameters.get("manualMergeProjects").is_some() {
        let projects: Vec<String> = decode(parameters, "manualMergeProjects")?;
        for project in &projects {
            identifier(project)?;
        }
        configuration.manual_merge_projects = projects;
    }
    for (key, target) in [
        ("checkInMinutes", &mut configuration.check_in_minutes),
        ("parkMinutes", &mut configuration.park_minutes),
    ] {
        if let Some(value) = parameters.get(key) {
            // The host acts on its minute tick, so a minute is the shortest.
            *target = Some(
                value
                    .as_u64()
                    .filter(|minutes| *minutes >= 1)
                    .and_then(|minutes| u32::try_from(minutes).ok())
                    .ok_or_else(|| {
                        Error::invalid(format!("{key} must be a whole number of minutes"))
                    })?,
            );
        }
    }
    if parameters.get("managedCeiling").is_some() {
        configuration.managed_ceiling = decode(parameters, "managedCeiling")?;
    }
    for (key, target) in [
        ("coordinatorTitle", &mut configuration.coordinator_title),
        (
            "coordinatorProvider",
            &mut configuration.coordinator_provider,
        ),
        ("coordinatorModel", &mut configuration.coordinator_model),
        (
            "coordinatorProjectId",
            &mut configuration.coordinator_project_id,
        ),
        (
            "coordinatorThreadId",
            &mut configuration.coordinator_thread_id,
        ),
    ] {
        if let Some(value) = parameters.get(key) {
            *target = if value.is_null() {
                None
            } else {
                let value = value
                    .as_str()
                    .ok_or_else(|| Error::invalid("Expected string"))?;
                text(value, 256, key)?;
                Some(value.into())
            };
        }
    }
    if configuration.coordinator_provider != original_provider
        || configuration.coordinator_model != original_model
    {
        // A proof holds for the instance and model it was made with.
        configuration.thread_proof = None;
    }
    if parameters.get("guildBindings").is_some() {
        let bindings: Vec<GuildBinding> = decode(parameters, "guildBindings")?;
        if bindings.len() > 100 {
            return Err(Error::invalid("At most 100 Guild bindings are supported"));
        }
        let mut ids = std::collections::BTreeSet::new();
        for binding in &bindings {
            identifier(&binding.id)?;
            plain_label(&binding.name)?;
            identifier(&binding.provider_instance_id)?;
            identifier(&binding.guild_provider)?;
            if !ids.insert(binding.id.clone()) {
                return Err(Error::invalid("Guild binding identifiers must be unique"));
            }
            for value in [
                &binding.guild_account,
                &binding.profile_id,
                &binding.environment_id,
            ]
            .into_iter()
            .flatten()
            {
                identifier(value)?;
            }
            if binding.guild_account.is_none() && binding.profile_id.is_none() {
                return Err(Error::invalid(
                    "Guild bindings require an explicit account or roster profile",
                ));
            }
            if let Some(cloud) = &binding.cloud {
                for value in [
                    &cloud.project_id,
                    &cloud.destination,
                    &cloud.guild_model,
                    &cloud.repository,
                    &cloud.environment,
                    &cloud.branch,
                ] {
                    identifier(value)?;
                }
                if !cloud.destination.starts_with("cloud:")
                    || [cloud.head.as_str(), cloud.base.as_str()]
                        .iter()
                        .any(|sha| sha.len() != 40 || !sha.chars().all(|c| c.is_ascii_hexdigit()))
                {
                    return Err(Error::invalid(
                        "Cloud bindings require a cloud destination and full immutable commit ids",
                    ));
                }
            }
        }
        configuration.guild_bindings = bindings;
    }
    if let Some(value) = parameters.get("allowUnverifiedCloudModels") {
        configuration.allow_unverified_cloud_models = value
            .as_bool()
            .ok_or_else(|| Error::invalid("allowUnverifiedCloudModels must be boolean"))?;
    }
    if let Some(value) = parameters.get("permissionMode") {
        let mode: PermissionMode = serde_json::from_value(value.clone())
            .map_err(|error| Error::invalid(error.to_string()))?;
        if mode != configuration.permission_mode {
            // Preset changes use the same scope replacement, normalization, revision and queued
            // approval revocation as the explicit policy editor. Unrelated saves leave Custom intact.
            policy::set_policy(
                tx,
                &json!({"actor":"user","policy":{"id":"coordinator-global-preset","mode":mode,"scope":{"kind":"global","id":null},"maxAccess":2}}),
                revision,
                now,
            )?;
            configuration.permission_mode = mode;
        }
    }
    store::put(tx, "system", "configuration", &configuration, revision)?;
    snapshot(tx, &json!({}))
}

/// The host's record of the Coordinator thread's first turn for its instance and model.
fn record_proof(
    tx: &Transaction<'_>,
    parameters: &Value,
    revision: u64,
    now: u64,
) -> Result<Value> {
    let mut configuration = config(tx)?;
    let provider = field(parameters, "provider")?;
    let model = field(parameters, "model")?;
    if configuration.coordinator_provider.as_deref() != Some(provider)
        || configuration.coordinator_model.as_deref() != Some(model)
    {
        return Err(Error::conflict(
            "The Coordinator's instance or model changed",
        ));
    }
    let proved = parameters.get("proved").and_then(Value::as_bool) == Some(true);
    if configuration
        .thread_proof
        .as_ref()
        // Only the first turn can show the tools missing; a proof, once made, stands.
        .is_some_and(|proof| proof.proved || !proved)
    {
        return Ok(json!({"threadProof":configuration.thread_proof}));
    }
    let reason = parameters.get("reason").and_then(Value::as_str);
    if let Some(reason) = reason {
        text(reason, 500, "reason")?;
    }
    configuration.thread_proof = Some(ThreadProof {
        provider: provider.into(),
        model: model.into(),
        proved,
        reason: if proved { None } else { reason.map(Into::into) },
        at: now,
    });
    store::put(tx, "system", "configuration", &configuration, revision)?;
    Ok(json!({"threadProof":configuration.thread_proof}))
}

/// What waits for the owner is listed whole, never cut at a page, so no count of it undercounts.
const OWNER_ALL: usize = i64::MAX as usize;

/// Unfinished assignments and every assignment of a goal not yet done.
const OPEN_ASSIGNMENTS: &str = "json_extract(body,'$.status') NOT IN ('completed','verified','cancelled','failed') OR json_extract(body,'$.goalId') IN (SELECT id FROM documents WHERE kind='goal' AND json_extract(body,'$.status') IN ('active','blocked','merging'))";

pub(crate) fn snapshot(tx: &Transaction<'_>, parameters: &Value) -> Result<Value> {
    let limit = page_limit(parameters)?;
    let pause = pause_state(tx)?;
    Ok(json!({
        "protocolVersion":PROTOCOL_VERSION,"revision":store::revision(tx)?,
        "configuration":config(tx)?,
        "guidance":registry::guidance(tx)?,
        "pause":{"active":pause.active,"revision":pause.revision,"label":if pause.active {"Resume all"} else {"Pause all"}},
        "cards":store::list::<Card>(tx,"card",card_filter(&json!({})),"",limit)?,
        "goals":store::list::<Goal>(tx,"goal","json_extract(body,'$.status') IN ('active','blocked','merging')","",limit)?,
        "assignments":store::list::<Assignment>(tx,"assignment",OPEN_ASSIGNMENTS,"",limit)?,
        "routingWaits":routing::compact(tx,limit)?,
        "pendingActions":store::list::<Action>(tx,"action","json_extract(body,'$.status') IN ('pending','claimed','uncertain')","",limit)?,
        "catalog":store::list::<CatalogModel>(tx,"catalog","1","",limit)?,
        "overrides":store::list::<ModelOverride>(tx,"override","1","",limit)?,
        "permissions":store::list::<PermissionPolicy>(tx,"permission","1","",limit)?,
        // Held work the owner has yet to act on; one whose assignment ended no longer waits.
        "resultChecks":store::list::<Value>(tx,"resultCheck","json_extract(body,'$.passed')=0 AND json_extract(body,'$.assignmentId') IN (SELECT id FROM documents WHERE kind='assignment' AND json_extract(body,'$.status') NOT IN ('completed','verified','cancelled','failed'))","",OWNER_ALL)?,
        "ownerMerges":merge::for_owner(tx, OWNER_ALL)?,
        "grants":store::list::<grant::Grant>(tx,"grant","json_extract(body,'$.revoked')=0","",limit)?,
        "grantProposals":store::list::<Value>(tx,"grantProposal","1","",OWNER_ALL)?,
        "permissionPresets":store::list::<Value>(tx,"permissionPreset","1","",limit)?,
        "decisions":store::recent::<Decision>(tx,"decision",limit)?,
        "permissionRequests":store::list::<Value>(tx,"permissionRequest","json_extract(body,'$.status')='pending'","",OWNER_ALL)?,
        "catalogSources":store::list::<Value>(tx,"catalogSource","1","",limit)?,
        "counts":{"cards":store::count(tx,"card",card_filter(&json!({})))?,"history":store::count(tx,"card","1")?,"goals":store::count(tx,"goal","1")?,"catalog":store::count(tx,"catalog","1")?},
        "policyRevision":policy_revision(tx)?,
        "pageLimit":limit
    }))
}

pub(crate) fn page_limit(parameters: &Value) -> Result<usize> {
    let limit = parameters.get("limit").map_or(Ok(50), |v| {
        v.as_u64()
            .ok_or_else(|| Error::invalid("limit must be an integer"))
    })?;
    if limit == 0 || limit > MAX_PAGE as u64 {
        return Err(Error::invalid("limit must be between 1 and 100"));
    }
    Ok(limit as usize)
}

fn page<T: DeserializeOwned + Serialize>(
    tx: &Transaction<'_>,
    kind: &str,
    filter: &str,
    parameters: &Value,
) -> Result<Value> {
    let limit = page_limit(parameters)?;
    let cursor = parameters
        .get("cursor")
        .and_then(Value::as_str)
        .unwrap_or("");
    let mut items = store::list::<T>(tx, kind, filter, cursor, limit + 1)?;
    let has_more = items.len() > limit;
    items.truncate(limit);
    let cursor = if has_more {
        items
            .last()
            .map(serde_json::to_value)
            .transpose()
            .map_err(Error::internal)?
            .and_then(|v| v.get("id").cloned())
    } else {
        None
    };
    Ok(
        json!({"items":items,"nextCursor":cursor,"total":store::count(tx,kind,filter)?,"revision":store::revision(tx)?}),
    )
}

fn card_filter(parameters: &Value) -> &'static str {
    if parameters.get("history").and_then(Value::as_bool) == Some(true) {
        "1"
    } else {
        "COALESCE(json_extract(body,'$.settled'),0)=0 AND COALESCE(json_extract(body,'$.archived'),0)=0"
    }
}

fn action_filter(parameters: &Value) -> &'static str {
    if parameters.get("history").and_then(Value::as_bool) == Some(true) {
        "1"
    } else {
        "json_extract(body,'$.status') IN ('pending','claimed','uncertain')"
    }
}

fn list_cards(tx: &Transaction<'_>, parameters: &Value) -> Result<Value> {
    if parameters.get("projectId").is_none() {
        return page::<Card>(tx, "card", card_filter(parameters), parameters);
    }
    let project = field(parameters, "projectId")?;
    let cursor = parameters
        .get("cursor")
        .and_then(Value::as_str)
        .unwrap_or("");
    let limit = page_limit(parameters)?;
    let settled = parameters.get("settled").and_then(Value::as_bool);
    let mut statement = tx.prepare("SELECT body FROM documents WHERE kind='card' AND id>?1 AND json_extract(body,'$.projectId')=?2 AND (?3 IS NULL OR json_extract(body,'$.settled')=?3) ORDER BY id LIMIT ?4").map_err(Error::internal)?;
    let rows = statement
        .query_map(params![cursor, project, settled, limit as u64 + 1], |row| {
            row.get::<_, String>(0)
        })
        .map_err(Error::internal)?;
    let mut items: Vec<Card> = rows
        .map(|row| serde_json::from_str(&row.map_err(Error::internal)?).map_err(Error::internal))
        .collect::<Result<_>>()?;
    let more = items.len() > limit;
    items.truncate(limit);
    let next_cursor = if more {
        items.last().map(|card| card.id.clone())
    } else {
        None
    };
    Ok(json!({"items":items,"nextCursor":next_cursor}))
}
fn find_card(tx: &Transaction<'_>, parameters: &Value) -> Result<Value> {
    let mut statement = tx.prepare("SELECT body FROM documents WHERE kind='card' AND json_extract(body,'$.threadId')=?1 LIMIT 2").map_err(Error::internal)?;
    let rows = statement
        .query_map([field(parameters, "threadId")?], |row| {
            row.get::<_, String>(0)
        })
        .map_err(Error::internal)?;
    let cards: Vec<Card> = rows
        .map(|row| serde_json::from_str(&row.map_err(Error::internal)?).map_err(Error::internal))
        .collect::<Result<_>>()?;
    if cards.len() != 1 {
        return Err(Error::not_found("Thread card is missing or ambiguous"));
    }
    Ok(json!({"card":cards[0]}))
}
