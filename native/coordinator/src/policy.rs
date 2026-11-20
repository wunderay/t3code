use crate::{
    Error, Result, config, danger, decode, field, grant, identifier, model::*, pause_state,
    plain_label, policy_revision, store, text, user,
};
use rusqlite::{Transaction, params};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

pub(crate) fn valid_scope(scope: &Scope, overrides: bool) -> Result<()> {
    if !["global", "project", "environment", "thread"].contains(&scope.kind.as_str())
        && !(overrides && scope.kind == "assignment")
    {
        return Err(Error::invalid("Unsupported policy scope"));
    }
    if scope.kind == "global" {
        if scope.id.is_some() {
            return Err(Error::invalid("Global scope cannot have an id"));
        }
    } else {
        identifier(
            scope
                .id
                .as_deref()
                .ok_or_else(|| Error::invalid("Scoped policies require an id"))?,
        )?;
    }
    Ok(())
}

fn preset_policy(preset: &Value, now: u64) -> Result<PermissionPolicy> {
    let name = field(preset, "name")?;
    plain_label(name)?;
    let mut policy: PermissionPolicy = serde_json::from_value(json!({
        "id":field(preset,"id")?,"name":name,"mode":"custom","scope":{"kind":"global","id":null},
        "rules":preset.get("rules").cloned().unwrap_or_else(||json!([])),
        "maxAccess":preset.get("maxAccess").cloned().unwrap_or_else(||json!(0)),
        "delegateApproval":preset.get("delegateApproval").cloned().unwrap_or(Value::Bool(false)),
        "allowAccessIncrease":preset.get("allowAccessIncrease").cloned().unwrap_or(Value::Bool(false))
    })).map_err(Error::internal)?;
    validate_policy(&mut policy, now)?;
    Ok(policy)
}

pub(crate) fn preview(tx: &Transaction<'_>, parameters: &Value, now: u64) -> Result<Value> {
    let scope: Scope = decode(parameters, "scope")?;
    valid_scope(&scope, false)?;
    let current = parameters["currentAccess"]
        .as_u64()
        .filter(|value| *value <= 2)
        .ok_or_else(|| Error::invalid("currentAccess must be 0, 1 or 2"))?;
    let requested = parameters
        .get("requestedAccess")
        .map(|value| {
            value
                .as_u64()
                .filter(|value| *value <= 2)
                .ok_or_else(|| Error::invalid("requestedAccess must be 0, 1 or 2"))
        })
        .transpose()?;
    let category = field(parameters, "category")?;
    let supported = [
        "command",
        "file-read",
        "file-change",
        "mcp-elicitation",
        "permission",
        "thread.access",
    ]
    .contains(&category);
    let mut query = json!({"category":category,"resource":parameters.get("resource"),"currentAccess":current,"requestedAccess":requested.unwrap_or(2),"accessIncreaseUnknown":requested.is_none(),"destinationMaxAccess":2,"supported":supported,"environmentId":parameters.get("environmentId")});
    match scope.kind.as_str() {
        "thread" => {
            let mut statement = tx.prepare("SELECT body FROM documents WHERE kind='card' AND json_extract(body,'$.threadId')=?1 LIMIT 2").map_err(Error::internal)?;
            let cards = statement
                .query_map([scope.id.as_deref().unwrap_or("")], |row| {
                    row.get::<_, String>(0)
                })
                .map_err(Error::internal)?
                .map(|row| {
                    serde_json::from_str::<Card>(&row.map_err(Error::internal)?)
                        .map_err(Error::internal)
                })
                .collect::<Result<Vec<_>>>()?;
            if cards.len() != 1 {
                return Err(Error::conflict(
                    "Preview requires a known unambiguous thread",
                ));
            }
            query["threadId"] = json!(cards[0].thread_id);
            query["projectId"] = json!(cards[0].project_id);
            query["environmentId"] = json!(cards[0].environment_id);
        }
        "project" => query["projectId"] = json!(scope.id),
        "environment" => query["environmentId"] = json!(scope.id),
        _ => {
            query
                .as_object_mut()
                .ok_or_else(|| Error::internal("Invalid preview context"))?
                .remove("environmentId");
        }
    }
    let mut result = effective(tx, &query, now)?;
    result["hypothetical"] = json!(true);
    Ok(result)
}

pub(crate) fn save_preset(
    tx: &Transaction<'_>,
    parameters: &Value,
    revision: u64,
    now: u64,
) -> Result<Value> {
    user(parameters)?;
    let preset = parameters
        .get("preset")
        .ok_or_else(|| Error::invalid("Missing preset"))?;
    let policy = preset_policy(preset, now)?;
    if store::get::<Value>(tx, "permissionPreset", &policy.id)?.is_none()
        && store::count(tx, "permissionPreset", "1")? >= 100
    {
        return Err(Error::conflict("Saved permission preset limit reached"));
    }
    let saved = json!({"id":policy.id,"name":policy.name,"rules":policy.rules,"maxAccess":policy.max_access,"delegateApproval":policy.delegate_approval,"allowAccessIncrease":policy.allow_access_increase,"revision":revision});
    store::put(
        tx,
        "permissionPreset",
        field(&saved, "id")?,
        &saved,
        revision,
    )?;
    // No policy revision, grant, approval invalidation or configuration mutation occurs on save.
    Ok(json!({"preset":saved}))
}

pub(crate) fn apply_preset(
    tx: &Transaction<'_>,
    parameters: &Value,
    revision: u64,
    now: u64,
) -> Result<Value> {
    user(parameters)?;
    let preset: Value = store::required(tx, "permissionPreset", field(parameters, "presetId")?)?;
    let mut policy = preset_policy(&preset, now)?;
    policy.id = format!("preset-applied:{revision}");
    policy.scope = decode(parameters, "scope")?;
    set_policy(tx, &json!({"actor":"user","policy":policy}), revision, now)
}

pub(crate) fn delete_preset(
    tx: &Transaction<'_>,
    parameters: &Value,
    revision: u64,
) -> Result<Value> {
    user(parameters)?;
    store::remove(
        tx,
        "permissionPreset",
        field(parameters, "presetId")?,
        revision,
    )?;
    Ok(json!({"deleted":true}))
}

fn validate_policy(policy: &mut PermissionPolicy, now: u64) -> Result<()> {
    identifier(&policy.id)?;
    valid_scope(&policy.scope, false)?;
    if policy.max_access > 2 {
        return Err(Error::invalid(
            "maxAccess must be 0 (read), 1 (workspace), or 2 (full)",
        ));
    }
    if policy.expires_at.is_some_and(|expiry| expiry <= now) && !policy.revoked {
        return Err(Error::invalid("Policy expiry must be in the future"));
    }
    if let Some(name) = &policy.name {
        plain_label(name)?;
    }
    if policy.rules.len() > 100 {
        return Err(Error::invalid("Too many permission rules"));
    }
    for rule in &policy.rules {
        text(&rule.category, 80, "category")?;
        if !["allow", "ask", "deny"].contains(&rule.effect.as_str()) {
            return Err(Error::invalid("Rule effect must be allow, ask, or deny"));
        }
        if let Some(resource) = &rule.resource {
            text(resource, 1024, "resource")?;
            if resource.split(['\\', '/']).any(|part| part == "..") {
                return Err(Error::invalid(
                    "Resource boundaries cannot contain parent traversal",
                ));
            }
        }
    }
    if !policy.rules.is_empty() {
        policy.mode = PermissionMode::Custom;
    }
    match policy.mode {
        PermissionMode::Ask => {
            policy.delegate_approval = false;
            policy.allow_access_increase = false;
        }
        PermissionMode::Approve => {
            policy.delegate_approval = true;
            policy.allow_access_increase = false;
            if policy.max_access == 0 {
                policy.max_access = 2;
            }
        }
        PermissionMode::Full => {
            policy.delegate_approval = true;
            policy.allow_access_increase = true;
            policy.max_access = 2;
        }
        PermissionMode::Custom => {}
    }
    Ok(())
}

pub(crate) fn set_policy(
    tx: &Transaction<'_>,
    parameters: &Value,
    revision: u64,
    now: u64,
) -> Result<Value> {
    user(parameters)?;
    let mut policy: PermissionPolicy = decode(parameters, "policy")?;
    validate_policy(&mut policy, now)?;
    let mut statement = tx.prepare("SELECT id FROM documents WHERE kind='permission' AND json_extract(body,'$.scope.kind')=?1 AND COALESCE(json_extract(body,'$.scope.id'),'')=?2 AND id<>?3").map_err(Error::internal)?;
    let ids = statement
        .query_map(
            params![
                policy.scope.kind,
                policy.scope.id.as_deref().unwrap_or(""),
                policy.id
            ],
            |r| r.get::<_, String>(0),
        )
        .map_err(Error::internal)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(Error::internal)?;
    for id in ids {
        store::remove(tx, "permission", &id, revision)?;
    }
    policy.revision = revision;
    store::put(tx, "permission", &policy.id, &policy, revision)?;
    store::put(tx, "system", "policyRevision", &revision, revision)?;
    invalidate_queued_approvals(tx, revision)?;
    if policy.scope.kind == "global" {
        let mut configuration = config(tx)?;
        configuration.permission_mode = policy.mode.clone();
        store::put(tx, "system", "configuration", &configuration, revision)?;
    }
    Ok(json!({"policy":policy,"policyRevision":revision}))
}

pub(crate) fn scope_rank(scope: &Scope, parameters: &Value) -> Option<u8> {
    let (key, rank) = match scope.kind.as_str() {
        "global" => return Some(0),
        "project" => ("projectId", 1),
        "environment" => ("environmentId", 1),
        "thread" => ("threadId", 2),
        "assignment" => ("assignmentId", 3),
        _ => return None,
    };
    (parameters.get(key).and_then(Value::as_str) == scope.id.as_deref()).then_some(rank)
}

pub(crate) fn all_matching<T: DeserializeOwned>(
    tx: &Transaction<'_>,
    kind: &str,
    filter: &str,
) -> Result<Vec<T>> {
    // Policies are bounded at write time; do not silently ignore a late, more specific deny.
    let count = store::count(tx, kind, filter)?;
    if count > 4096 {
        return Err(Error::conflict(format!(
            "The {kind} registry exceeds its safe evaluation limit"
        )));
    }
    store::list(tx, kind, filter, "", 4096)
}

// Normalized provider approvals do not currently retain the native requested permission set.
// Missing metadata on persisted requests must remain conservative before host resynchronization.
fn access_increase_unknown(parameters: &Value) -> bool {
    parameters
        .get("accessIncreaseUnknown")
        .and_then(Value::as_bool)
        .unwrap_or_else(|| {
            matches!(
                parameters.get("category").and_then(Value::as_str),
                Some("command" | "file-read" | "file-change" | "mcp-elicitation" | "permission")
            )
        })
}

const UNPARSED: &str = "Unparsed: for the Coordinator to answer";
const OUTSIDE: &str = "Outside the grant: for the Coordinator to answer";

pub(crate) fn effective(tx: &Transaction<'_>, parameters: &Value, now: u64) -> Result<Value> {
    let policies = all_matching::<PermissionPolicy>(tx, "permission", "1")?;
    let mut matching = policies
        .into_iter()
        .filter(|p| !p.revoked && p.expires_at.is_none_or(|e| e > now))
        .filter_map(|p| scope_rank(&p.scope, parameters).map(|rank| (rank, p)))
        .collect::<Vec<_>>();
    let rank = matching.iter().map(|(rank, _)| *rank).max();
    matching.retain(|(candidate, _)| Some(*candidate) == rank);
    let category = parameters
        .get("category")
        .and_then(Value::as_str)
        .unwrap_or("");
    let resource = parameters.get("resource").and_then(Value::as_str);
    let unknown_increase = access_increase_unknown(parameters);
    let requested = if unknown_increase {
        2
    } else {
        parameters
            .get("requestedAccess")
            .and_then(Value::as_u64)
            .unwrap_or(0)
    };
    let current = parameters
        .get("currentAccess")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let destination_max = parameters
        .get("destinationMaxAccess")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let supported = parameters
        .get("supported")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let mut effect = "allow";
    let mut max_access = 2;
    let mut delegated = !matching.is_empty();
    let mut increase = !matching.is_empty();
    let mut ids = Vec::new();
    for (_, policy) in &matching {
        ids.push(&policy.id);
        max_access = max_access.min(u64::from(policy.max_access));
        delegated &= policy.delegate_approval;
        increase &= policy.allow_access_increase;
        let candidate = match policy.mode {
            PermissionMode::Ask => "ask",
            PermissionMode::Approve | PermissionMode::Full => "allow",
            PermissionMode::Custom => {
                let mut matched = false;
                let mut selected = "allow";
                for rule in &policy.rules {
                    if rule.category != "*" && rule.category != category {
                        continue;
                    }
                    if let Some(boundary) = &rule.resource {
                        let Some(resource) = resource else {
                            continue;
                        };
                        let boundary = boundary.trim_end_matches(['\\', '/']);
                        if resource != boundary
                            && !resource
                                .strip_prefix(boundary)
                                .is_some_and(|suffix| suffix.starts_with(['\\', '/']))
                        {
                            continue;
                        }
                        if resource.split(['\\', '/']).any(|part| part == "..") {
                            continue;
                        }
                    }
                    matched = true;
                    if rule.effect == "deny" {
                        selected = "deny";
                        break;
                    }
                    if rule.effect == "ask" {
                        selected = "ask";
                    }
                }
                if matched { selected } else { "ask" }
            }
        };
        if candidate == "deny" {
            effect = "deny";
        } else if candidate == "ask" && effect != "deny" {
            effect = "ask";
        }
    }
    // Delegated work inside a grant: on the danger list it goes to the owner, inside the grant it
    // is allowed, anything else goes to the owner. A deny the owner set still holds.
    let grant = grant::covering(tx, parameters, now)?;
    let danger = match &grant {
        Some(grant) => danger::matching(&danger::list(tx)?, parameters, grant),
        None => None,
    };
    let danger_reason = danger
        .as_ref()
        .map(|rule| format!("On the danger list: {}", rule.label));
    let reason = if !supported {
        Some("Destination does not support this permission operation")
    } else if requested > destination_max {
        Some("Destination access ceiling is lower than requested access")
    } else if let Some(reason) = &danger_reason {
        Some(reason.as_str())
    } else if let Some(grant) = &grant {
        // A grant never answers what the owner's own policy keeps for them, whatever else holds.
        if !ids.is_empty() && (!delegated || effect == "ask") {
            Some("The owner's policy keeps this for them")
        } else if grant::inside(grant, parameters, requested) {
            None
        } else if parameters.get("unparsed").and_then(Value::as_bool) == Some(true)
            && grant::readably_inside(grant, parameters)
            // Only one shown whole, at no more than the grant's access, is the model's to allow.
            && !unknown_increase
            && requested <= u64::from(grant.max_access)
            && parameters
                .get("operation")
                .and_then(Value::as_str)
                .is_some_and(|operation| !operation.trim().is_empty())
        {
            Some(UNPARSED)
        } else {
            Some(OUTSIDE)
        }
    } else if requested > max_access {
        Some("Request exceeds the granted access ceiling")
    } else if unknown_increase && !increase {
        Some(
            "The provider request's access expansion is unknown; an explicit broader grant or direct user decision is required",
        )
    } else if requested > current && !increase {
        Some("Access increases require an explicit broader grant")
    } else if !delegated {
        Some("Permission response requires a direct user decision")
    } else {
        None
    };
    if reason.is_some() && effect != "deny" {
        effect = "ask";
    } else if grant.is_some() && effect != "deny" {
        effect = "allow";
    }
    // Within a grant, what no rule settles and nothing marks as dangerous is the Coordinator's
    // to answer or pass on; everything else that asks is the owner's.
    let passed = parameters.get("passedToOwner").and_then(Value::as_bool) == Some(true);
    let route = if effect == "allow" || effect == "deny" {
        "rule"
    } else if grant.is_some() && !passed && matches!(reason, Some(UNPARSED | OUTSIDE)) {
        "coordinator"
    } else {
        "owner"
    };
    Ok(
        json!({"grantId":grant.map(|grant| grant.id),"danger":danger,"route":route,"effect":effect,"delegated":delegated,"allowAccessIncrease":increase,"accessIncreaseUnknown":unknown_increase,"requestedAccess":requested,"maxAccess":max_access.min(destination_max),"policyIds":ids,"policyRevision":policy_revision(tx)?,"reason":reason,"inherited":rank.unwrap_or(0)<2}),
    )
}

pub(crate) fn request(tx: &Transaction<'_>, parameters: &Value, revision: u64) -> Result<Value> {
    let mut request = parameters
        .get("request")
        .cloned()
        .ok_or_else(|| Error::invalid("Missing request"))?;
    let id = field(&request, "id")?.to_owned();
    identifier(&id)?;
    let card: Card = store::required(tx, "card", field(&request, "cardId")?)?;
    text(field(&request, "category")?, 80, "category")?;
    for key in ["requestedAccess", "currentAccess", "destinationMaxAccess"] {
        if !request
            .get(key)
            .and_then(Value::as_u64)
            .is_some_and(|v| v <= 2)
        {
            return Err(Error::invalid(format!(
                "{key} must be an access level 0..2"
            )));
        }
    }
    if request
        .get("accessIncreaseUnknown")
        .is_some_and(|value| !value.is_boolean())
    {
        return Err(Error::invalid("accessIncreaseUnknown must be boolean"));
    }
    let object = request
        .as_object_mut()
        .ok_or_else(|| Error::invalid("request must be an object"))?;
    object.insert("threadId".into(), json!(card.thread_id));
    object.insert("projectId".into(), json!(card.project_id));
    object.insert("environmentId".into(), json!(card.environment_id));
    object.insert("assignmentId".into(), json!(card.assignment_id));
    object.insert(
        "instructionRevision".into(),
        json!(card.instruction_revision),
    );
    object.insert("status".into(), json!("pending"));
    object.insert("revision".into(), json!(revision));
    if let Some(existing) = store::get::<Value>(tx, "permissionRequest", &id)? {
        for key in ["cardId", "category", "resource", "instructionRevision"] {
            if existing.get(key) != request.get(key) {
                return Err(Error::conflict("Permission request identity was reused"));
            }
        }
        let certainty_changed =
            existing.get("accessIncreaseUnknown") != request.get("accessIncreaseUnknown");
        let ceiling_changed = existing.get("requestedAccess") != request.get("requestedAccess");
        if certainty_changed || ceiling_changed {
            // Permit only a conservative refinement, never reinterpret an existing request more broadly.
            if !access_increase_unknown(&request) || request["requestedAccess"].as_u64() != Some(2)
            {
                return Err(Error::conflict(
                    "Permission request certainty or ceiling changed",
                ));
            }
            if !["pending", "answering", "uncertain"]
                .contains(&existing["status"].as_str().unwrap_or(""))
                || existing["actor"] == "user"
            {
                return Ok(existing);
            }
            invalidate_queued_approvals_for(tx, revision, Some(&id))?;
            let mut refined: Value = store::required(tx, "permissionRequest", &id)?;
            // Claimed/uncertain responses may already be at the provider. Keep their receipt boundary;
            // never reset or replay them as a new request during normalization refinement.
            if refined["status"] != "pending" {
                return Ok(refined);
            }
            refined["requestedAccess"] = json!(2);
            refined["accessIncreaseUnknown"] = json!(true);
            refined["revision"] = json!(revision);
            store::put(tx, "permissionRequest", &id, &refined, revision)?;
            return Ok(refined);
        }
        return Ok(existing);
    }
    if serde_json::to_string(&request)
        .map_err(Error::internal)?
        .len()
        > 8192
    {
        return Err(Error::invalid("Permission request exceeds metadata budget"));
    }
    store::put(tx, "permissionRequest", &id, &request, revision)?;
    Ok(request)
}

/// The Coordinator's model answers only what the rules left to it, and allows only what could not
/// be read but, as far as it can be, stays inside the grant: it never widens it.
pub(crate) fn model_may(effective: &Value, decision: &str) -> Result<()> {
    if effective["route"] != "coordinator" {
        return Err(Error::forbidden(
            "This request is for a rule or the owner, not the Coordinator",
        ));
    }
    if decision == "approve" && effective["reason"] != UNPARSED {
        return Err(Error::forbidden(
            "Outside the grant: deny it or pass it to the owner",
        ));
    }
    Ok(())
}

pub(crate) fn decide(
    tx: &Transaction<'_>,
    parameters: &Value,
    revision: u64,
    now: u64,
) -> Result<Value> {
    let id = field(parameters, "requestId")?;
    let mut request: Value = store::required(tx, "permissionRequest", id)?;
    // An answer names who gives it; one that names no one is not the owner's.
    let actor = parameters
        .get("actor")
        .and_then(Value::as_str)
        .ok_or_else(|| Error::forbidden("A permission answer names its actor"))?;
    let already_answered = parameters.get("alreadyAnswered").and_then(Value::as_bool) == Some(true);
    let direct = actor == "user" && already_answered;
    if request.get("status").and_then(Value::as_str) != Some("pending")
        && !(direct
            && ["answering", "uncertain"].contains(&request["status"].as_str().unwrap_or("")))
    {
        return Err(Error::conflict(
            "Permission request already has a response or is awaiting destination acknowledgement",
        ));
    }
    let decision = field(parameters, "decision")?;
    if !["approve", "deny"].contains(&decision) {
        return Err(Error::invalid("decision must be approve or deny"));
    }
    let card: Card = store::required(tx, "card", field(&request, "cardId")?)?;
    if !direct
        && (request.get("instructionRevision").and_then(Value::as_u64)
            != Some(card.instruction_revision)
            || card.settled
            || card.archived)
    {
        return Err(Error::conflict(
            "Permission request was invalidated by direct user changes",
        ));
    }
    let effective = effective(tx, &request, now)?;
    if actor != "user" {
        if parameters.get("grantRevision").and_then(Value::as_u64) != Some(policy_revision(tx)?) {
            return Err(Error::conflict("Permission grant changed"));
        }
        if effective["grantId"].is_null() {
            return Err(Error::forbidden(
                "The host answers only for delegated work inside a grant",
            ));
        }
        let effect = effective.get("effect").and_then(Value::as_str);
        if actor == "coordinator-model" {
            model_may(&effective, decision)?;
        } else if actor != "coordinator" {
            return Err(Error::forbidden("Unknown permission actor"));
        } else if effect == Some("ask") || (decision == "approve" && effect != Some("allow")) {
            return Err(Error::forbidden(
                "Current policy does not authorize this autonomous response",
            ));
        }
    }
    if !direct
        && decision == "approve"
        && (request.get("supported").and_then(Value::as_bool) != Some(true)
            || request["requestedAccess"].as_u64() > request["destinationMaxAccess"].as_u64())
    {
        return Err(Error::forbidden(
            "Destination does not support the requested access",
        ));
    }
    request["status"] = json!(if already_answered {
        "answered"
    } else {
        "answering"
    });
    request["decision"] = json!(decision);
    request["actor"] = json!(actor);
    request["policyRevision"] = json!(policy_revision(tx)?);
    request["revision"] = json!(revision);
    store::put(tx, "permissionRequest", id, &request, revision)?;
    if request["status"] == "answering" {
        let action = Action {
            id: format!("permission:{id}:{revision}"),
            kind: "permission.respond".into(),
            assignment_id: None,
            thread_id: Some(card.thread_id),
            environment_id: Some(card.environment_id),
            payload: json!({"requestId":id,"destinationRequestId":request.get("destinationRequestId").cloned().unwrap_or_else(||json!(id)),"decision":decision,"actor":actor,"operation":request.get("operation"),"policyIds":effective["policyIds"],"requestRevision":revision}),
            status: "pending".into(),
            revision,
            created_at: now,
            pause_revision: pause_state(tx)?.revision,
            instruction_revision: Some(card.instruction_revision),
            grant_revision: Some(policy_revision(tx)?),
        };
        store::put(tx, "action", &action.id, &action, revision)?;
    }
    Ok(request)
}

/// Who each pending request waits for and why, so the owner sees what is theirs.
pub(crate) fn with_routes(tx: &Transaction<'_>, mut snapshot: Value, now: u64) -> Result<Value> {
    if let Some(requests) = snapshot["permissionRequests"].as_array_mut() {
        for request in requests {
            let effective = effective(tx, request, now)?;
            request["route"] = effective["route"].clone();
            request["reason"] = effective["reason"].clone();
        }
    }
    Ok(snapshot)
}

/// The Coordinator's model hands a request the rules left to it on to the owner, who then answers it.
pub(crate) fn pass(
    tx: &Transaction<'_>,
    parameters: &Value,
    revision: u64,
    now: u64,
) -> Result<Value> {
    if parameters.get("actor").and_then(Value::as_str) != Some("coordinator-model") {
        return Err(Error::forbidden(
            "Only the Coordinator's model passes a request on",
        ));
    }
    let id = field(parameters, "requestId")?;
    let mut request: Value = store::required(tx, "permissionRequest", id)?;
    if request.get("status").and_then(Value::as_str) != Some("pending") {
        return Err(Error::conflict("Permission request already has a response"));
    }
    if effective(tx, &request, now)?["route"] != "coordinator" {
        return Err(Error::forbidden(
            "This request is for a rule or the owner, not the Coordinator",
        ));
    }
    request["passedToOwner"] = json!(true);
    request["revision"] = json!(revision);
    store::put(tx, "permissionRequest", id, &request, revision)?;
    Ok(request)
}

pub(crate) fn invalidate_queued_approvals(tx: &Transaction<'_>, revision: u64) -> Result<()> {
    invalidate_queued_approvals_for(tx, revision, None)
}

fn invalidate_queued_approvals_for(
    tx: &Transaction<'_>,
    revision: u64,
    only_request: Option<&str>,
) -> Result<()> {
    let mut after = String::new();
    loop {
        let actions = store::list::<Action>(
            tx,
            "action",
            "json_extract(body,'$.kind')='permission.respond' AND json_extract(body,'$.status')='pending'",
            &after,
            100,
        )?;
        if actions.is_empty() {
            break;
        }
        for mut action in actions {
            after.clone_from(&action.id);
            if action.payload["actor"] == "user" {
                continue;
            }
            let request_id = field(&action.payload, "requestId")?;
            if only_request.is_some_and(|id| id != request_id) {
                continue;
            }
            let mut request: Value = store::required(tx, "permissionRequest", request_id)?;
            if request["status"] == "answering"
                && request["revision"] == action.payload["requestRevision"]
            {
                request["status"] = json!("pending");
                request["revision"] = json!(revision);
                store::put(tx, "permissionRequest", request_id, &request, revision)?;
            }
            action.status = "invalidated".into();
            action.revision = revision;
            store::put(tx, "action", &action.id, &action, revision)?;
        }
    }
    Ok(())
}

pub(crate) fn set_override(
    tx: &Transaction<'_>,
    parameters: &Value,
    revision: u64,
) -> Result<Value> {
    user(parameters)?;
    if parameters.get("clear").and_then(Value::as_bool) == Some(true) {
        let scope: Scope = decode(parameters, "scope")?;
        valid_scope(&scope, true)?;
        for existing in all_matching::<ModelOverride>(tx, "override", "1")? {
            if existing.scope == scope {
                store::remove(tx, "override", &existing.id, revision)?;
            }
        }
        return Ok(json!({"cleared":true,"scope":scope}));
    }
    let mut selection: ModelOverride = decode(parameters, "override")?;
    identifier(&selection.id)?;
    valid_scope(&selection.scope, true)?;
    let source_goal: Option<Goal> = if let Some(id) =
        parameters.get("sourceGoalId").and_then(Value::as_str)
    {
        let goal: Goal = store::required(tx, "goal", id)?;
        if parameters.get("sourceGoalRevision").and_then(Value::as_u64) != Some(goal.revision)
            || parameters.get("sourceGoalPurpose").and_then(Value::as_str)
                != Some(goal.purpose.as_str())
        {
            return Err(Error::conflict(
                "Source user goal changed before its exact override could be applied",
            ));
        }
        if let Some(receipt) = store::get::<Value>(tx, "overrideSource", id)?
            && receipt["purpose"] == goal.purpose
        {
            return Ok(json!({"deduplicated":true,"sourceGoalId":id}));
        }
        if selection.scope.kind != "thread" {
            return Err(Error::forbidden(
                "Source user model directives must bind one exact thread",
            ));
        }
        let thread_id = selection
            .scope
            .id
            .as_deref()
            .ok_or_else(|| Error::invalid("Missing target thread"))?;
        let body: String = tx.query_row("SELECT body FROM documents WHERE kind='card' AND json_extract(body,'$.threadId')=?1 LIMIT 1",[thread_id],|row|row.get(0)).map_err(Error::internal)?;
        let card: Card = serde_json::from_str(&body).map_err(Error::internal)?;
        if !goal.authorized_scope.iter().any(|scope| {
            [
                &card.id,
                &card.thread_id,
                &card.project_id,
                &card.environment_id,
            ]
            .contains(&scope)
        }) {
            return Err(Error::forbidden(
                "Source user goal does not authorize this thread",
            ));
        }
        if all_matching::<ModelOverride>(tx, "override", "1")?
            .iter()
            .any(|existing| existing.scope == selection.scope && existing.revision > goal.revision)
        {
            store::put(
                tx,
                "overrideSource",
                id,
                &json!({"purpose":goal.purpose,"sourceRevision":goal.revision,"status":"superseded-by-direct-user"}),
                revision,
            )?;
            return Ok(json!({"superseded":true,"sourceGoalId":id}));
        }
        selection.source_goal_id = Some(goal.id.clone());
        selection.source_goal_revision = Some(goal.revision);
        selection.provenance = Some("explicit-source-user-directive".into());
        Some(goal)
    } else {
        selection.source_goal_id = None;
        selection.source_goal_revision = None;
        selection.provenance = None;
        None
    };
    if source_goal.is_some() {
        for existing in all_matching::<ModelOverride>(tx, "override", "1")? {
            if existing.scope == selection.scope {
                macro_rules! preserve { ($($field:ident),+) => { $(if selection.selection.$field.is_none() { selection.selection.$field = existing.selection.$field.clone(); })+ }; }
                preserve!(profile_id, provider, model, effort, account, destination);
            }
        }
    }
    let fields = [
        &selection.selection.profile_id,
        &selection.selection.provider,
        &selection.selection.model,
        &selection.selection.effort,
        &selection.selection.account,
        &selection.selection.destination,
    ];
    if fields.iter().all(|v| v.is_none()) {
        return Err(Error::invalid(
            "An override must select at least one route field",
        ));
    }
    for field in fields.into_iter().flatten() {
        text(field, 256, "route selection")?;
    }
    for existing in all_matching::<ModelOverride>(tx, "override", "1")? {
        if existing.scope == selection.scope && existing.id != selection.id {
            store::remove(tx, "override", &existing.id, revision)?;
        }
    }
    selection.revision = revision;
    store::put(tx, "override", &selection.id, &selection, revision)?;
    if let Some(goal) = source_goal {
        store::put(
            tx,
            "overrideSource",
            &goal.id,
            &json!({"purpose":goal.purpose,"sourceRevision":goal.revision,"status":"applied"}),
            revision,
        )?;
    }
    Ok(json!({"override":selection,"pendingSafeBoundary":true}))
}

pub(crate) fn resolved(
    tx: &Transaction<'_>,
    parameters: &Value,
) -> Result<(RouteSelection, Vec<String>)> {
    let mut matches = all_matching::<ModelOverride>(tx, "override", "1")?
        .into_iter()
        .filter_map(|o| scope_rank(&o.scope, parameters).map(|r| (r, o)))
        .collect::<Vec<_>>();
    matches.sort_by_key(|(rank, o)| (*rank, o.revision));
    let mut result = RouteSelection::default();
    let mut ids = Vec::new();
    for (_, selection) in matches {
        ids.push(selection.id);
        macro_rules! overlay { ($($field:ident),+) => { $(if selection.selection.$field.is_some() { result.$field = selection.selection.$field; })+ }; }
        overlay!(profile_id, provider, model, effort, account, destination);
    }
    Ok((result, ids))
}

pub(crate) fn resolve_override(tx: &Transaction<'_>, parameters: &Value) -> Result<Value> {
    let (selection, ids) = resolved(tx, parameters)?;
    Ok(json!({"selection":selection,"overrideIds":ids,"exact":!ids.is_empty()}))
}

pub(crate) fn validate_selection(
    tx: &Transaction<'_>,
    assignment: &Assignment,
    card: &Card,
) -> Result<()> {
    let (pin, _) = resolved(
        tx,
        &json!({"assignmentId":assignment.id,"threadId":card.thread_id,"projectId":card.project_id,"environmentId":card.environment_id}),
    )?;
    macro_rules! check { ($($field:ident),+) => { $(if let Some(value) = &pin.$field && assignment.route.$field.as_ref() != Some(value) { return Err(Error::conflict(concat!("Route does not honor exact manual ",stringify!($field)," override"))); })+ }; }
    check!(profile_id, provider, model, effort, account, destination);
    Ok(())
}
