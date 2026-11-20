use crate::{
    Error, Result, config, decode, events, field, identifier, model::*, pause_state, store,
    strings, text, user,
};
use rusqlite::Transaction;
use serde_json::{Value, json};
use std::collections::BTreeSet;

pub(crate) fn sync_cards(tx: &Transaction<'_>, parameters: &Value, revision: u64) -> Result<Value> {
    let raw_cards = parameters
        .get("cards")
        .and_then(Value::as_array)
        .ok_or_else(|| Error::invalid("cards must be an array"))?;
    if raw_cards.len() > MAX_PAGE {
        return Err(Error::invalid("Sync at most 100 compact cards per event"));
    }
    let projection = parameters.get("projection").and_then(Value::as_bool) == Some(true);
    let mut cards: Vec<Card> = Vec::new();
    for raw in raw_cards {
        let id = field(raw, "id")?;
        let existing: Option<Card> = store::get(tx, "card", id)?;
        let mut value = existing
            .as_ref()
            .map(serde_json::to_value)
            .transpose()
            .map_err(Error::internal)?
            .unwrap_or_else(|| json!({}));
        let object = value
            .as_object_mut()
            .ok_or_else(|| Error::invalid("Card must be an object"))?;
        for (key, value) in raw
            .as_object()
            .ok_or_else(|| Error::invalid("Card must be an object"))?
        {
            // T3's projection owns execution state; it cannot reset supervisor acceptance or assignment metadata.
            if projection
                && [
                    "assignmentId",
                    "profileId",
                    "verified",
                    "evidence",
                    "dependencies",
                    "acceptanceCriteria",
                    "nextStep",
                ]
                .contains(&key.as_str())
            {
                continue;
            }
            object.insert(key.clone(), value.clone());
        }
        cards.push(
            serde_json::from_value(value).map_err(|error| Error::invalid(error.to_string()))?,
        );
    }
    if cards.len() > MAX_PAGE {
        return Err(Error::invalid("Sync at most 100 compact cards per event"));
    }
    let mut ids = BTreeSet::new();
    let mut changed = Vec::new();
    for card in &mut cards {
        for id in [
            &card.id,
            &card.thread_id,
            &card.environment_id,
            &card.project_id,
        ] {
            identifier(id)?;
        }
        if !ids.insert(card.id.clone()) {
            return Err(Error::invalid("Duplicate card in one sync"));
        }
        text(&card.purpose, 2000, "purpose")?;
        if ![
            "idle",
            "queued",
            "submitted",
            "running",
            "blocked",
            "completed",
            "verified",
            "failed",
            "cancelled",
            "paused",
            "pausing",
            "unreachable",
            "unknown",
        ]
        .contains(&card.status.as_str())
        {
            return Err(Error::invalid("Unsupported card status"));
        }
        for value in [&card.blocker, &card.next_step].into_iter().flatten() {
            text(value, 1000, "card summary")?;
        }
        strings(&card.dependencies, 32, 256)?;
        strings(&card.acceptance_criteria, 16, 1000)?;
        strings(&card.evidence, 32, 512)?;
        let existing: Option<Card> = store::get(tx, "card", &card.id)?;
        if let Some(existing) = existing {
            if existing.thread_id != card.thread_id
                || existing.environment_id != card.environment_id
            {
                return Err(Error::conflict(
                    "Card identity cannot change its thread or environment",
                ));
            }
            if existing.instruction_revision > card.instruction_revision {
                continue;
            }
            if existing.instruction_revision != card.instruction_revision {
                card.verified = false;
                card.evidence.clear();
            }
            if projection {
                card.summary_updated_at = existing.summary_updated_at;
            }
            card.revision = existing.revision;
            if serde_json::to_value(&existing).map_err(Error::internal)?
                == serde_json::to_value(&*card).map_err(Error::internal)?
            {
                continue;
            }
        }
        card.revision = revision;
        store::put(tx, "card", &card.id, card, revision)?;
        if card.settled {
            crate::grant::forget_proposals_for(tx, card, revision)?;
        }
        changed.push(&card.id);
    }
    Ok(json!({"changed":changed,"revision":store::revision(tx)?}))
}

pub(crate) fn settle(
    tx: &Transaction<'_>,
    parameters: &Value,
    revision: u64,
    settled: bool,
) -> Result<Value> {
    let mut card: Card = store::required(tx, "card", field(parameters, "id")?)?;
    if settled && parameters.get("actor").and_then(Value::as_str) == Some("coordinator") {
        if !card.verified || card.evidence.is_empty() {
            return Err(Error::forbidden(
                "Coordinator settlement requires verified acceptance evidence",
            ));
        }
        for dependency in &card.dependencies {
            let dependency: Card = store::required(tx, "card", dependency)?;
            if !dependency.verified {
                return Err(Error::conflict("Dependency handoff is not verified"));
            }
        }
    }
    card.settled = settled;
    if !settled {
        card.stale = true;
    }
    card.revision = revision;
    store::put(tx, "card", &card.id, &card, revision)?;
    if settled {
        crate::grant::forget_proposals_for(tx, &card, revision)?;
    }
    Ok(json!({"card":card,"requiresRevalidation":!settled}))
}

pub(crate) fn upsert_goal(
    tx: &Transaction<'_>,
    parameters: &Value,
    revision: u64,
) -> Result<Value> {
    let mut goal: Goal = decode(parameters, "goal")?;
    identifier(&goal.id)?;
    if let Some(project) = &goal.project_id {
        identifier(project)?;
    }
    crate::board::keep_budget(tx, &mut goal)?;
    let previous = store::get::<Goal>(tx, "goal", &goal.id)?;
    let was_merging = previous
        .as_ref()
        .is_some_and(|goal| goal.status == "merging");
    // Only a passed review starts a merge and only the merge completes it.
    if was_merging != (goal.status == "merging") {
        if !was_merging || goal.status == "completed" {
            return Err(Error::forbidden(
                "A goal starts merging after its review and completes at its merge",
            ));
        }
        store::remove(tx, "merge", &goal.id, revision)?;
    }
    if let Some(previous) = previous {
        if parameters["goal"].get("revision").is_some() && goal.revision != previous.revision {
            return Err(Error::conflict(
                "Goal changed; reload before saving or extending repairs",
            ));
        }
        goal.max_attempts = goal.max_attempts.or(previous.max_attempts);
        if goal.max_attempts > previous.max_attempts {
            store::remove(
                tx,
                "decision",
                &format!("repair-limit:{}", goal.id),
                revision,
            )?;
            for mut entry in store::list::<Value>(
                tx,
                "routingIntent",
                "json_extract(body,'$.status')='repair-blocked'",
                "",
                100,
            )? {
                if entry["goalId"].as_str() == Some(goal.id.as_str()) {
                    entry["status"] = json!("waiting");
                    entry["nextAttemptAt"] = json!(0);
                    entry["revision"] = json!(revision);
                    store::put(tx, "routingIntent", field(&entry, "id")?, &entry, revision)?;
                }
            }
        }
    }
    goal.max_attempts = Some(goal.max_attempts.unwrap_or(3));
    text(&goal.purpose, 4000, "goal purpose")?;
    strings(&goal.acceptance_criteria, 32, 1000)?;
    strings(&goal.authorized_scope, 32, 1000)?;
    strings(&goal.dependencies, 32, 256)?;
    strings(&goal.touches, 64, 1000)?;
    strings(&goal.assignment_ids, 100, 256)?;
    strings(&goal.evidence, 64, 512)?;
    if !["active", "blocked", "completed", "cancelled", "merging"].contains(&goal.status.as_str()) {
        return Err(Error::invalid("Unsupported goal status"));
    }
    if goal.max_attempts == Some(0) {
        return Err(Error::invalid("maxAttempts must be positive"));
    }
    let mut frontier = goal.dependencies.clone();
    let mut visited = BTreeSet::new();
    while let Some(id) = frontier.pop() {
        if id == goal.id {
            return Err(Error::conflict("Goal dependencies contain a cycle"));
        }
        if !visited.insert(id.clone()) {
            continue;
        }
        if visited.len() > 1000 {
            return Err(Error::conflict(
                "Goal dependency graph exceeds validation bound",
            ));
        }
        let dependency: Goal = store::required(tx, "goal", &id)?;
        if goal.status == "completed" && dependency.status != "completed" {
            return Err(Error::conflict("Goal has incomplete dependencies"));
        }
        frontier.extend(dependency.dependencies);
    }
    if goal.status == "completed" {
        if !goal.verified
            || goal.evidence.is_empty()
            || goal.acceptance_criteria.is_empty()
            || goal.integration_owner.is_none()
        {
            return Err(Error::forbidden(
                "Goal completion requires acceptance criteria, integration ownership, and verified combined evidence",
            ));
        }
        for assignment in &goal.assignment_ids {
            let assignment: Assignment = store::required(tx, "assignment", assignment)?;
            if assignment.status != "verified" && !supersession_approved(tx, &goal, &assignment.id)?
            {
                return Err(Error::conflict("Goal has unverified assignments"));
            }
        }
    }
    goal.revision = revision;
    store::put(tx, "goal", &goal.id, &goal, revision)?;
    Ok(json!({"goal":goal}))
}

pub(crate) fn record_decision(
    tx: &Transaction<'_>,
    parameters: &Value,
    revision: u64,
) -> Result<Value> {
    let mut decision: Decision = decode(parameters, "decision")?;
    identifier(&decision.id)?;
    text(&decision.summary, 2000, "decision summary")?;
    text(&decision.provenance, 512, "decision provenance")?;
    strings(&decision.card_ids, 32, 256)?;
    strings(&decision.goal_ids, 32, 256)?;
    if decision.card_ids.is_empty() && decision.goal_ids.is_empty() && decision.expires_at.is_none()
    {
        return Err(Error::invalid(
            "Standing decisions require explicit applicability or an expiry",
        ));
    }
    decision.revision = revision;
    store::put(tx, "decision", &decision.id, &decision, revision)?;
    Ok(json!({"decision":decision}))
}

fn chars(value: &Value) -> Result<usize> {
    Ok(serde_json::to_string(value)
        .map_err(Error::internal)?
        .chars()
        .count())
}

pub(crate) fn guidance(tx: &Transaction<'_>) -> Result<Value> {
    let configuration = config(tx)?;
    match configuration.coordinator_thread_id {
        Some(thread_id) => {
            let mut guidance: Value = store::get(tx, "guidance", &thread_id)?.unwrap_or_else(
                || json!({"threadId":thread_id,"customPrompt":"","memory":"","revision":0}),
            );
            // Guidance saved before the Coordinator kept notes has none.
            if guidance.get("coordinatorNotes").is_none() {
                guidance["coordinatorNotes"] = json!("");
            }
            Ok(guidance)
        }
        None => Ok(Value::Null),
    }
}

fn coordinator_notes(value: &Value) -> Result<&str> {
    let notes = value
        .as_str()
        .ok_or_else(|| Error::invalid("coordinatorNotes must be text"))?;
    if notes.chars().count() > 2000 {
        return Err(Error::invalid(
            "Coordinator notes exceed 2000 characters; shorten them before saving",
        ));
    }
    Ok(notes)
}

fn guidance_thread<'a>(tx: &Transaction<'_>, parameters: &'a Value) -> Result<&'a str> {
    let thread_id = field(parameters, "threadId")?;
    if config(tx)?.coordinator_thread_id.as_deref() != Some(thread_id) {
        return Err(Error::conflict(
            "Guidance belongs to a different coordinator thread",
        ));
    }
    Ok(thread_id)
}

pub(crate) fn save_guidance(
    tx: &Transaction<'_>,
    parameters: &Value,
    revision: u64,
) -> Result<Value> {
    user(parameters)?;
    let thread_id = guidance_thread(tx, parameters)?;
    let custom_prompt = parameters["customPrompt"]
        .as_str()
        .ok_or_else(|| Error::invalid("customPrompt must be text"))?;
    let memory = parameters["memory"]
        .as_str()
        .ok_or_else(|| Error::invalid("memory must be text"))?;
    let text = json!({"customPrompt":custom_prompt,"memory":memory});
    if chars(&text)? > 4000 {
        return Err(Error::invalid(
            "Serialized coordinator guidance exceeds 4000 characters; shorten it before saving",
        ));
    }
    let notes = match parameters.get("coordinatorNotes") {
        Some(notes) => json!(coordinator_notes(notes)?),
        None => guidance(tx)?["coordinatorNotes"].clone(),
    };
    let saved = json!({"threadId":thread_id,"customPrompt":custom_prompt,"memory":memory,"coordinatorNotes":notes,"revision":revision});
    store::put(tx, "guidance", thread_id, &saved, revision)?;
    Ok(json!({"guidance":saved}))
}

/// The Coordinator's own notes; the person's texts beside them are kept as stored.
pub(crate) fn save_coordinator_notes(
    tx: &Transaction<'_>,
    parameters: &Value,
    revision: u64,
) -> Result<Value> {
    let thread_id = guidance_thread(tx, parameters)?;
    let notes = coordinator_notes(&parameters["coordinatorNotes"])?;
    let mut saved = guidance(tx)?;
    if parameters["expectedGuidanceRevision"].as_u64() != saved["revision"].as_u64() {
        return Err(Error::conflict(
            "Coordinator guidance changed since it was shown; plan from the current notes",
        ));
    }
    saved["coordinatorNotes"] = json!(notes);
    saved["revision"] = json!(revision);
    store::put(tx, "guidance", thread_id, &saved, revision)?;
    Ok(json!({"guidance":saved}))
}

pub(crate) fn sync_catalog(
    tx: &Transaction<'_>,
    parameters: &Value,
    revision: u64,
    now: u64,
) -> Result<Value> {
    let source_id = field(parameters, "sourceId")?;
    identifier(source_id)?;
    let previous_source: Value =
        store::get(tx, "catalogSource", source_id)?.unwrap_or_else(|| json!({}));
    let success = parameters
        .get("success")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let complete = parameters
        .get("complete")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    // A stored value stands only when the owner set it; one this sync stored itself follows the
    // provider's current default, which is off for one whose approvals state no operation.
    let automatic_eligibility = if previous_source["automaticEligibilitySetByOwner"] == true {
        previous_source.get("automaticEligibility")
    } else {
        parameters.get("automaticEligibility")
    }
    .and_then(Value::as_bool)
    .unwrap_or(true);
    let mut models: Vec<CatalogModel> = if success {
        decode(parameters, "models")?
    } else {
        Vec::new()
    };
    if models.len() > 1000 {
        return Err(Error::invalid(
            "Catalog sync exceeds 1000 models; partition sources",
        ));
    }
    let mut ids = BTreeSet::new();
    for model in &mut models {
        for id in [&model.id, &model.provider, &model.model, &model.destination] {
            identifier(id)?;
        }
        if model.source_id != source_id || !ids.insert(model.id.clone()) {
            return Err(Error::invalid("Catalog source mismatch or duplicate model"));
        }
        strings(&model.aliases, 32, 256)?;
        strings(&model.efforts, 32, 80)?;
        strings(&model.evidence, 32, 512)?;
        if let Some(existing) = store::get::<CatalogModel>(tx, "catalog", &model.id)?
            && (existing.provider != model.provider
                || existing.model != model.model
                || existing.destination != model.destination
                || existing.account != model.account
                || existing.source_id != model.source_id)
        {
            return Err(Error::conflict(
                "Catalog identity cannot change provider, model, destination, or account",
            ));
        }
        if model.qualification_verified && model.evidence.is_empty() {
            return Err(Error::invalid(
                "Qualification requires evidence for the exact model binding",
            ));
        }
        let manual: Value =
            store::get(tx, "catalogPolicy", &model.id)?.unwrap_or_else(|| json!({}));
        model.manually_quarantined = manual["quarantined"] == true;
        model.state = if model.manually_quarantined || !model.compatible {
            "quarantined"
        } else if !model.accessible || !model.policy_allowed {
            "discovered"
        } else if automatic_eligibility && model.qualification_verified && model.identity_verified {
            "eligible"
        } else {
            "validating"
        }
        .into();
        model.stale = false;
        model.missing_refreshes = 0;
        model.discovered_at = now;
        model.revision = revision;
        store::put(tx, "catalog", &model.id, model, revision)?;
    }
    let filter = "1";
    let mut after = String::new();
    loop {
        let previous = store::list::<CatalogModel>(tx, "catalog", filter, &after, 100)?;
        if previous.is_empty() {
            break;
        }
        for mut model in previous {
            after.clone_from(&model.id);
            if model.source_id != source_id || ids.contains(&model.id) {
                continue;
            }
            if success && complete {
                model.missing_refreshes = model.missing_refreshes.saturating_add(1);
                if model.missing_refreshes >= 2 {
                    model.state = "retired".into();
                }
            }
            model.stale = true;
            model.revision = revision;
            store::put(tx, "catalog", &model.id, &model, revision)?;
        }
    }
    let previous: Value = store::get(tx, "catalogSource", source_id)?.unwrap_or_else(|| json!({}));
    let failures = if success {
        0
    } else {
        previous["failures"]
            .as_u64()
            .unwrap_or(0)
            .saturating_add(1)
            .min(16)
    };
    let delay = if success {
        6 * 60 * 60 * 1000
    } else {
        (60_000u64.saturating_mul(1u64 << failures)).min(6 * 60 * 60 * 1000)
    };
    let source = json!({"id":source_id,"lastAttemptAt":now,"lastSuccessAt":if success {Some(now)} else {previous["lastSuccessAt"].as_u64()},"nextRefreshAt":now.saturating_add(delay),"failures":failures,"stale":!success,"refreshing":false,"automaticDiscovery":previous_source.get("automaticDiscovery").or_else(||parameters.get("automaticDiscovery")).and_then(Value::as_bool).unwrap_or(true),"automaticEligibility":automatic_eligibility,"automaticEligibilitySetByOwner":previous_source["automaticEligibilitySetByOwner"] == true,"discoverySupported":parameters.get("discoverySupported").and_then(Value::as_bool).unwrap_or(true),"changeToken":parameters.get("changeToken"),"paidOnboardingBudgetMicros":0,"revision":revision});
    store::put(tx, "catalogSource", source_id, &source, revision)?;
    Ok(json!({"source":source,"updated":models.len()}))
}

pub(crate) fn refresh_catalog(
    tx: &Transaction<'_>,
    parameters: &Value,
    revision: u64,
    now: u64,
) -> Result<Value> {
    let source_id = parameters
        .get("sourceId")
        .and_then(Value::as_str)
        .unwrap_or("configured");
    identifier(source_id)?;
    let mut source: Value =
        store::get(tx, "catalogSource", source_id)?.unwrap_or_else(|| json!({"id":source_id}));
    if source["refreshing"] == true {
        return Ok(json!({"deduplicated":true,"source":source}));
    }
    if parameters.get("automatic").and_then(Value::as_bool) == Some(true)
        && (source["automaticDiscovery"] == false
            || source["nextRefreshAt"]
                .as_u64()
                .is_some_and(|time| time > now))
    {
        return Ok(json!({"deferred":true,"source":source}));
    }
    source["refreshing"] = json!(true);
    source["lastAttemptAt"] = json!(now);
    source["revision"] = json!(revision);
    store::put(tx, "catalogSource", source_id, &source, revision)?;
    let action = Action {
        id: format!("catalog:{source_id}:{revision}"),
        kind: "catalog.refresh".into(),
        assignment_id: None,
        thread_id: None,
        environment_id: None,
        payload: json!({"sourceId":source_id,"changeToken":source.get("changeToken")}),
        status: "pending".into(),
        revision,
        created_at: now,
        pause_revision: pause_state(tx)?.revision,
        instruction_revision: None,
        grant_revision: None,
    };
    store::put(tx, "action", &action.id, &action, revision)?;
    Ok(json!({"action":action,"source":source}))
}

fn catalog_state(model: &CatalogModel, automatic_eligibility: bool) -> &'static str {
    if model.manually_quarantined || !model.compatible {
        "quarantined"
    } else if !model.accessible || !model.policy_allowed {
        "discovered"
    } else if automatic_eligibility && model.qualification_verified && model.identity_verified {
        "eligible"
    } else {
        "validating"
    }
}

pub(crate) fn set_source(tx: &Transaction<'_>, parameters: &Value, revision: u64) -> Result<Value> {
    user(parameters)?;
    let source_id = field(parameters, "sourceId")?;
    let mut source: Value = store::required(tx, "catalogSource", source_id)?;
    for key in ["automaticDiscovery", "automaticEligibility"] {
        if let Some(value) = parameters.get(key) {
            if !value.is_boolean() {
                return Err(Error::invalid("Source policy flags must be boolean"));
            }
            source[key] = value.clone();
        }
    }
    if parameters.get("automaticEligibility").is_some() {
        source["automaticEligibilitySetByOwner"] = json!(true);
    }
    if source["automaticDiscovery"] == false {
        source["refreshing"] = json!(false);
    }
    source["revision"] = json!(revision);
    store::put(tx, "catalogSource", source_id, &source, revision)?;
    let automatic_eligibility = source["automaticEligibility"] != false;
    let mut after = String::new();
    loop {
        let models = store::list::<CatalogModel>(tx, "catalog", "1", &after, 100)?;
        if models.is_empty() {
            break;
        }
        for mut model in models {
            after.clone_from(&model.id);
            if model.source_id != source_id || model.state == "retired" {
                continue;
            }
            model.state = catalog_state(&model, automatic_eligibility).into();
            model.revision = revision;
            store::put(tx, "catalog", &model.id, &model, revision)?;
        }
    }
    Ok(json!({"source":source}))
}

pub(crate) fn set_model(tx: &Transaction<'_>, parameters: &Value, revision: u64) -> Result<Value> {
    user(parameters)?;
    let model_id = field(parameters, "modelId")?;
    let quarantined = parameters["quarantined"]
        .as_bool()
        .ok_or_else(|| Error::invalid("quarantined must be boolean"))?;
    let mut model: CatalogModel = store::required(tx, "catalog", model_id)?;
    let source: Value = store::required(tx, "catalogSource", &model.source_id)?;
    model.manually_quarantined = quarantined;
    if model.state != "retired" {
        model.state = catalog_state(&model, source["automaticEligibility"] != false).into();
    }
    model.revision = revision;
    store::put(
        tx,
        "catalogPolicy",
        model_id,
        &json!({"id":model_id,"quarantined":quarantined,"revision":revision}),
        revision,
    )?;
    store::put(tx, "catalog", model_id, &model, revision)?;
    Ok(json!({"model":model}))
}

// Host-only: the transport planner can request resolution but cannot supply this attestation.
pub(crate) fn resolve_goal(
    tx: &Transaction<'_>,
    parameters: &Value,
    revision: u64,
    now: u64,
) -> Result<Value> {
    let mut goal: Goal = store::required(tx, "goal", field(parameters, "id")?)?;
    if parameters
        .get("expectedGoalRevision")
        .and_then(Value::as_u64)
        != Some(goal.revision)
        || !["active", "blocked"].contains(&goal.status.as_str())
    {
        return Err(Error::conflict("Goal changed during verification"));
    }
    if parameters.get("hostVerified").and_then(Value::as_bool) != Some(true) {
        return Err(Error::forbidden("Canonical host verification is required"));
    }
    let mut reviewer: Assignment =
        store::required(tx, "assignment", field(parameters, "reviewerAssignmentId")?)?;
    let subjects: Vec<ReviewSubject> = decode(parameters, "subjects")?;
    let reviewer_receipt: ReviewSubject = decode(parameters, "reviewerReceipt")?;
    let reviewer_execution = reviewer
        .receipt
        .as_ref()
        .and_then(|receipt| receipt.get("latestRunId").or_else(|| receipt.get("runId")))
        .and_then(Value::as_str)
        .or(reviewer.execution_id.as_deref());
    if reviewer_receipt.assignment_id != reviewer.id
        || Some(reviewer_receipt.execution_id.as_str()) != reviewer_execution
        || reviewer_receipt.digest.len() != 64
        || !reviewer_receipt
            .digest
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
        || reviewer
            .review_goal_digest
            .as_ref()
            .is_none_or(|digest| digest.len() != 64)
    {
        return Err(Error::conflict(
            "Canonical reviewer receipt does not match its completed execution",
        ));
    }
    let evidence: Vec<String> = decode(parameters, "evidence")?;
    let supersessions: Vec<Supersession> = parameters
        .get("supersessions")
        .map(|value| {
            serde_json::from_value(value.clone()).map_err(|error| Error::invalid(error.to_string()))
        })
        .transpose()?
        .unwrap_or_default();
    if supersessions != reviewer.review_supersessions || supersessions.len() > 32 {
        return Err(Error::conflict("Reviewer supersession binding changed"));
    }
    let mut reachable: BTreeSet<String> = subjects
        .iter()
        .map(|subject| subject.assignment_id.clone())
        .chain(std::iter::once(reviewer.id.clone()))
        .collect();
    for _ in 0..32 {
        let before = reachable.len();
        for proof in &supersessions {
            if reachable.contains(&proof.replacement_assignment_id) {
                reachable.insert(proof.assignment_id.clone());
            }
        }
        if before == reachable.len() {
            break;
        }
    }
    let mut approved = BTreeSet::new();
    for proof in &supersessions {
        let old: Assignment = store::required(tx, "assignment", &proof.assignment_id)?;
        let replacement: Assignment =
            store::required(tx, "assignment", &proof.replacement_assignment_id)?;
        if !reachable.contains(&proof.replacement_assignment_id)
            || old.goal_id != reviewer.goal_id
            || replacement.goal_id != reviewer.goal_id
            || !replacement.supersedes.contains(&old.id)
            || old.revision != proof.source_revision
            || !["completed", "failed", "cancelled"].contains(&old.status.as_str())
            || proof.digest.len() != 64
            || subjects
                .iter()
                .any(|subject| subject.assignment_id == old.id)
            || old.id == reviewer.id
        {
            return Err(Error::conflict(
                "Supersession is stale, unrelated, or not covered by the reviewed final lineage",
            ));
        }
        approved.insert(old.id);
    }
    strings(&evidence, 32, 512)?;
    if reviewer.role != "reviewer"
        || reviewer.goal_id.as_deref() != Some(goal.id.as_str())
        || reviewer.status != "completed"
        || reviewer.receipt.is_none()
        || subjects.is_empty()
        || subjects != reviewer.review_subjects
        || evidence.is_empty()
        || !evidence.contains(&format!(
            "review:{}:{}:{}",
            reviewer.id, reviewer_receipt.execution_id, reviewer_receipt.digest
        ))
        || goal.acceptance_criteria.is_empty()
    {
        return Err(Error::conflict("Independent review evidence is incomplete"));
    }
    let integration_owner = field(parameters, "integrationOwner")?;
    if !subjects
        .iter()
        .any(|s| s.assignment_id == integration_owner)
    {
        return Err(Error::conflict(
            "Integration owner must be a reviewed assignment",
        ));
    }
    for subject in &subjects {
        let mut source: Assignment = store::required(tx, "assignment", &subject.assignment_id)?;
        if source.id == reviewer.id
            || source.card_id == reviewer.card_id
            || source.goal_id != reviewer.goal_id
            || !["completed", "verified"].contains(&source.status.as_str())
            || source
                .receipt
                .as_ref()
                .and_then(|r| r.get("latestRunId"))
                .and_then(Value::as_str)
                .or(source.execution_id.as_deref())
                != Some(subject.execution_id.as_str())
        {
            return Err(Error::conflict(
                "Review source changed or self-review detected",
            ));
        }
        let mut card: Card = store::required(tx, "card", &source.card_id)?;
        if card.instruction_revision != source.instruction_revision {
            return Err(Error::conflict(
                "Direct user instructions superseded the reviewed assignment",
            ));
        }
        source.status = "verified".into();
        source.revision = revision;
        events::put_assignment(tx, &source, revision, parameters, now)?;
        card.verified = true;
        card.evidence = evidence.clone();
        card.revision = revision;
        store::put(tx, "card", &card.id, &card, revision)?;
    }
    let mut reviewer_card: Card = store::required(tx, "card", &reviewer.card_id)?;
    reviewer_card.verified = true;
    reviewer_card.evidence = evidence.clone();
    reviewer_card.revision = revision;
    store::put(tx, "card", &reviewer_card.id, &reviewer_card, revision)?;
    reviewer.status = "verified".into();
    reviewer.revision = revision;
    events::put_assignment(tx, &reviewer, revision, parameters, now)?;
    for id in &goal.assignment_ids {
        let assignment: Assignment = store::required(tx, "assignment", id)?;
        if assignment.status != "verified" && !approved.contains(id) {
            return Err(Error::conflict("Goal still has unreviewed assignments"));
        }
    }
    store::put(
        tx,
        "goalResolution",
        &goal.id,
        &json!({"reviewerAssignmentId":reviewer.id,"supersessions":supersessions,"purpose":goal.purpose,"criteria":goal.acceptance_criteria,"scope":goal.authorized_scope,"dependencies":goal.dependencies}),
        revision,
    )?;
    let merge = crate::merge::target(parameters)?;
    goal.verified = true;
    goal.evidence = evidence;
    goal.integration_owner = Some(integration_owner.into());
    let result = if merge.is_some() {
        goal.status = "merging".into();
        goal.revision = revision;
        store::put(tx, "goal", &goal.id, &goal, revision)?;
        json!({"goal":goal})
    } else {
        // Work that changed nothing is done once its result is taken.
        goal.status = "completed".into();
        let result = upsert_goal(tx, &json!({"goal":goal}), revision)?;
        crate::settlement::enqueue(tx, &goal, revision, now)?;
        result
    };
    // Historical accepted evidence is immutable and delivered independently of current working context.
    // It is not a fabricated Guild run, rank update, or benchmark qualification.
    let binding = |assignment: &Assignment, subject: &ReviewSubject| -> Result<Value> {
        let routing: Option<Value> = store::get(tx, "routingIntent", &assignment.id)?;
        let reservation_key = if let Some(entry) = routing {
            if entry["status"] != "prepared" || entry["goalId"] != json!(assignment.goal_id) {
                return Err(Error::conflict("Accepted outcome routing source changed"));
            }
            field(&entry, "reservationKey")?.to_owned()
        } else {
            assignment.idempotency_key.clone()
        };
        Ok(json!({
        "assignmentId":assignment.id,"executionId":subject.execution_id,"digest":subject.digest,
        "cardId":assignment.card_id,"instructionRevision":assignment.instruction_revision,
        "reservationKey":reservation_key,
        "reservation":assignment.reservation,"route":assignment.route,
        "actualModel":assignment.actual_model,"actualEffort":assignment.actual_effort,
        "identityVerified":assignment.identity_verified,"rank":assignment.rank,"role":assignment.role,
        }))
    };
    let mut accepted_subjects = Vec::new();
    for subject in &subjects {
        let source: Assignment = store::required(tx, "assignment", &subject.assignment_id)?;
        accepted_subjects.push(binding(&source, subject)?);
    }
    let accepted_reviewer = binding(&reviewer, &reviewer_receipt)?;
    let feedback_id = format!("outcome:{}:{revision}", goal.id);
    let feedback = Action {
        id: feedback_id.clone(),
        kind: "outcome.accepted".into(),
        assignment_id: None,
        thread_id: None,
        environment_id: None,
        payload: json!({"event":{
            "protocolVersion":1,"eventId":feedback_id,"provenance":"canonical-independent-review",
            "goalId":goal.id,"goalRevision":revision,"goalDigest":reviewer.review_goal_digest,
            "integrationOwner":integration_owner,"evidence":goal.evidence,
            "subjects":accepted_subjects,"reviewer":accepted_reviewer,
            "supersessions":supersessions,
        }}),
        status: "pending".into(),
        revision,
        created_at: now,
        pause_revision: pause_state(tx)?.revision,
        instruction_revision: None,
        grant_revision: None,
    };
    if let Some(target) = merge {
        let owner: Assignment = store::required(tx, "assignment", integration_owner)?;
        crate::merge::start(tx, &goal, &owner, target, feedback, revision)?;
    } else {
        store::put(tx, "action", &feedback.id, &feedback, revision)?;
    }
    let mut card_ids = Vec::new();
    for subject in subjects.iter().take(16) {
        let source: Assignment = store::required(tx, "assignment", &subject.assignment_id)?;
        card_ids.push(source.card_id);
    }
    card_ids.push(reviewer.card_id.clone());
    let decision = Decision {
        id: format!("goal-resolution:{}:{revision}", goal.id),
        summary: format!(
            "{} after independent review: {}. Historical superseded failures retain their original outcomes.",
            if goal.status == "merging" {
                "Accepted, merging"
            } else {
                "Completed"
            },
            goal.purpose.chars().take(800).collect::<String>()
        ),
        provenance: "canonical-independent-review".into(),
        card_ids,
        goal_ids: vec![goal.id.clone()],
        expires_at: None,
        revision,
    };
    store::put(tx, "decision", &decision.id, &decision, revision)?;
    Ok(result)
}

pub(crate) fn block_goal(tx: &Transaction<'_>, parameters: &Value, revision: u64) -> Result<Value> {
    let mut goal: Goal = store::required(tx, "goal", field(parameters, "id")?)?;
    if parameters
        .get("expectedGoalRevision")
        .and_then(Value::as_u64)
        != Some(goal.revision)
    {
        return Err(Error::conflict("Goal changed during review"));
    }
    if !["active", "blocked"].contains(&goal.status.as_str()) {
        return Err(Error::conflict("Goal is already terminal"));
    }
    if let Some(sources) = parameters.get("repairSources") {
        if parameters["hostVerifiedRejection"] != true {
            return Err(Error::forbidden(
                "Negative review must be verified by the host",
            ));
        }
        let subjects: Vec<ReviewSubject> =
            serde_json::from_value(sources.clone()).map_err(Error::internal)?;
        let reviewer: Assignment =
            store::required(tx, "assignment", field(parameters, "reviewerAssignmentId")?)?;
        if reviewer.goal_id.as_deref() != Some(goal.id.as_str())
            || reviewer.role != "reviewer"
            || reviewer.status != "completed"
            || reviewer.receipt.is_none()
            || subjects.is_empty()
            || subjects != reviewer.review_subjects
        {
            return Err(Error::conflict(
                "Rejected subjects differ from canonical reviewer source bindings",
            ));
        }
        crate::repairs::reject_sources(
            tx,
            &goal.id,
            &subjects
                .into_iter()
                .map(|subject| subject.assignment_id)
                .collect::<Vec<_>>(),
            revision,
        )?;
    }
    goal.status = "blocked".into();
    goal.verified = false;
    goal.revision = revision;
    store::put(tx, "goal", &goal.id, &goal, revision)?;
    Ok(json!({"goal":goal}))
}

pub(crate) fn supersession_approved(
    tx: &Transaction<'_>,
    goal: &Goal,
    assignment_id: &str,
) -> Result<bool> {
    let Some(proof) = store::get::<Value>(tx, "goalResolution", &goal.id)? else {
        return Ok(false);
    };
    if proof["purpose"] != json!(goal.purpose)
        || proof["criteria"] != json!(goal.acceptance_criteria)
        || proof["scope"] != json!(goal.authorized_scope)
        || proof["dependencies"] != json!(goal.dependencies)
    {
        return Ok(false);
    }
    let reviewer: Assignment =
        store::required(tx, "assignment", field(&proof, "reviewerAssignmentId")?)?;
    if reviewer.status != "verified" || reviewer.goal_id.as_deref() != Some(goal.id.as_str()) {
        return Ok(false);
    }
    let bindings: Vec<Supersession> = decode(&proof, "supersessions")?;
    let source: Assignment = store::required(tx, "assignment", assignment_id)?;
    Ok(bindings.iter().any(|binding| {
        binding.assignment_id == assignment_id && binding.source_revision == source.revision
    }) && ["completed", "failed", "cancelled"].contains(&source.status.as_str()))
}
