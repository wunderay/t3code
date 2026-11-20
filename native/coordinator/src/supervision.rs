use crate::{
    Error, Result, config, decode, events, field, identifier, model::*, pause_state, policy,
    policy_revision, registry, snapshot, store, text, user,
};
use rusqlite::{OptionalExtension, Transaction, params};
use serde_json::{Value, json};

pub(crate) fn live(status: &str) -> bool {
    !["completed", "verified", "cancelled", "failed"].contains(&status)
}

fn for_each_assignment(
    tx: &Transaction<'_>,
    mut visit: impl FnMut(Assignment) -> Result<()>,
) -> Result<()> {
    let mut after = String::new();
    loop {
        let assignments = store::list::<Assignment>(tx, "assignment", "1", &after, 100)?;
        if assignments.is_empty() {
            return Ok(());
        }
        for assignment in assignments {
            after.clone_from(&assignment.id);
            visit(assignment)?;
        }
    }
}

fn action(
    tx: &Transaction<'_>,
    assignment: &Assignment,
    kind: &str,
    revision: u64,
    now: u64,
) -> Result<Action> {
    let card: Card = store::required(tx, "card", &assignment.card_id)?;
    let pause = pause_state(tx)?;
    // The result is checked against the goal's touches as they were at dispatch.
    let touches = match (&assignment.goal_id, kind) {
        (Some(goal), "dispatch") => store::get::<Goal>(tx, "goal", goal)?.map(|goal| goal.touches),
        _ => None,
    };
    let action = Action {
        id: format!("{kind}:{}:{revision}", assignment.id),
        kind: kind.into(),
        assignment_id: Some(assignment.id.clone()),
        thread_id: Some(card.thread_id.clone()),
        environment_id: Some(card.environment_id.clone()),
        payload: json!({"assignment":assignment,"card":card,"touches":touches}),
        status: "pending".into(),
        revision,
        created_at: now,
        pause_revision: pause.revision,
        instruction_revision: Some(assignment.instruction_revision),
        grant_revision: Some(policy_revision(tx)?),
    };
    store::put(tx, "action", &action.id, &action, revision)?;
    Ok(action)
}

fn dispatch_gate(tx: &Transaction<'_>, assignment: &Assignment, now: u64) -> Result<Card> {
    let configuration = config(tx)?;
    if !configuration.enabled || configuration.coordinator_paused {
        return Err(Error::forbidden("Coordinator is disabled or paused"));
    }
    let pause = pause_state(tx)?;
    if pause.active || assignment.pause_revision != pause.revision {
        return Err(Error::conflict(
            "Group dispatch gate is paused or its revision changed",
        ));
    }
    let card: Card = store::required(tx, "card", &assignment.card_id)?;
    if card.settled || card.archived || card.stale {
        return Err(Error::conflict(
            "Thread card is settled, archived, or stale; revalidate before dispatch",
        ));
    }
    if assignment.instruction_revision != card.instruction_revision {
        return Err(Error::conflict("Direct user instructions changed"));
    }
    if assignment.grant_revision != policy_revision(tx)? {
        return Err(Error::conflict("Thread permission policy changed"));
    }
    if !assignment.reservation.shared_capacity || assignment.reservation.expires_at <= now {
        return Err(Error::conflict(
            "A current shared Guild/T3 capacity reservation is required",
        ));
    }
    policy::validate_selection(tx, assignment, &card)?;
    let destination = assignment
        .route
        .destination
        .as_deref()
        .ok_or_else(|| Error::invalid("Route requires an exact destination"))?;
    match configuration.placement {
        Placement::LocalOnly if destination != "local" => {
            return Err(Error::forbidden(
                "Local only requires the coordinator machine",
            ));
        }
        Placement::CloudOnly if !destination.starts_with("cloud:") => {
            return Err(Error::forbidden(
                "Cloud only requires a supported native cloud destination",
            ));
        }
        _ => {}
    }
    let provider = assignment
        .route
        .provider
        .as_deref()
        .ok_or_else(|| Error::invalid("Route requires an exact provider"))?;
    let model = assignment
        .route
        .model
        .as_deref()
        .ok_or_else(|| Error::invalid("Route requires an exact model"))?;
    let sql = "SELECT body FROM documents WHERE kind='catalog' AND json_extract(body,'$.provider')=?1 AND json_extract(body,'$.model')=?2 AND json_extract(body,'$.destination')=?3 AND COALESCE(json_extract(body,'$.account'),'')=?4 LIMIT 2";
    let mut statement = tx.prepare(sql).map_err(Error::internal)?;
    let records = statement
        .query_map(
            params![
                provider,
                model,
                destination,
                assignment.route.account.as_deref().unwrap_or("")
            ],
            |row| row.get::<_, String>(0),
        )
        .map_err(Error::internal)?
        .map(|row| {
            serde_json::from_str::<CatalogModel>(&row.map_err(Error::internal)?)
                .map_err(Error::internal)
        })
        .collect::<Result<Vec<_>>>()?;
    if records.len() != 1 {
        return Err(Error::conflict(
            "Exact route catalog binding is missing or ambiguous",
        ));
    }
    let binding = &records[0];
    if binding.stale
        || !binding.compatible
        || !binding.accessible
        || !binding.policy_allowed
        || ["retired", "quarantined"].contains(&binding.state.as_str())
    {
        return Err(Error::forbidden(
            "Pinned route is unavailable or violates current catalog policy; no substitution was made",
        ));
    }
    if let Some(effort) = &assignment.route.effort
        && !binding.efforts.contains(effort)
    {
        return Err(Error::forbidden(
            "Exact reasoning effort is not advertised by the selected destination",
        ));
    }
    let (pin, overrides) = policy::resolved(
        tx,
        &json!({"assignmentId":assignment.id,"threadId":card.thread_id,"projectId":card.project_id,"environmentId":card.environment_id}),
    )?;
    let provider_selected_cloud = destination.starts_with("cloud:")
        && model == "provider-selected"
        && configuration.allow_unverified_cloud_models;
    if destination.starts_with("cloud:")
        && (pin
            .model
            .as_deref()
            .is_some_and(|model| model != "provider-selected")
            || pin.effort.is_some())
    {
        return Err(Error::forbidden(
            "Native cloud adapter cannot enforce an exact manual model or effort",
        ));
    }
    if overrides.is_empty() && binding.state != "eligible" && !provider_selected_cloud {
        return Err(Error::forbidden(
            "Automatic routing requires qualified catalog eligibility",
        ));
    }
    if let Some(goal_id) = &assignment.goal_id {
        let goal: Goal = store::required(tx, "goal", goal_id)?;
        if !["active", "blocked"].contains(&goal.status.as_str()) {
            return Err(Error::conflict("Goal is not active"));
        }
        for dependency in &goal.dependencies {
            let dependency: Goal = store::required(tx, "goal", dependency)?;
            if dependency.status != "completed" {
                return Err(Error::conflict("Goal dependency is not complete"));
            }
        }
        if let Some(reason) = crate::repairs::reason(
            tx,
            &goal,
            &assignment.id,
            &assignment.role,
            &assignment.supersedes,
        )? {
            return Err(Error::forbidden(reason));
        }
    }
    Ok(card)
}

pub(crate) fn prepare(
    tx: &Transaction<'_>,
    parameters: &Value,
    revision: u64,
    now: u64,
) -> Result<Value> {
    let mut assignment: Assignment = decode(parameters, "assignment")?;
    for id in [
        &assignment.id,
        &assignment.idempotency_key,
        &assignment.card_id,
        &assignment.reservation.id,
        &assignment.reservation.owner,
    ] {
        identifier(id)?;
    }
    text(&assignment.brief, 16000, "delegation brief")?;
    if let Some(title) = &assignment.title {
        crate::plain_label(title)?;
    }
    text(&assignment.return_route, 512, "return route")?;
    let previous: Option<String> = tx.query_row("SELECT body FROM documents WHERE kind='assignment' AND json_extract(body,'$.idempotencyKey')=?1",[&assignment.idempotency_key],|row| row.get(0)).optional().map_err(Error::internal)?;
    if let Some(previous) = previous {
        let previous: Assignment = serde_json::from_str(&previous).map_err(Error::internal)?;
        if previous.id != assignment.id
            || previous.route != assignment.route
            || previous.goal_id != assignment.goal_id
            || previous.brief != assignment.brief
            || previous.return_route != assignment.return_route
            || previous.rank != assignment.rank
            || previous.role != assignment.role
            || previous.skills != assignment.skills
            || previous.review_subjects != assignment.review_subjects
            || previous.review_goal_digest != assignment.review_goal_digest
            || previous.supersedes != assignment.supersedes
            || previous.review_supersessions != assignment.review_supersessions
        {
            return Err(Error::conflict(
                "Idempotency key was already bound to another assignment intent",
            ));
        }
        let actions = store::list::<Action>(
            tx,
            "action",
            "json_extract(body,'$.kind')='dispatch'",
            "",
            4096,
        )?;
        let action = actions
            .into_iter()
            .find(|action| action.assignment_id.as_deref() == Some(&previous.id));
        return Ok(json!({"assignment":previous,"action":action,"deduplicated":true}));
    }
    if store::get::<Assignment>(tx, "assignment", &assignment.id)?.is_some() {
        return Err(Error::conflict("Assignment id already exists"));
    }
    if let Some(goal_id) = &assignment.goal_id {
        let goal: Goal = store::required(tx, "goal", goal_id)?;
        if let Some(reason) = crate::repairs::reason(
            tx,
            &goal,
            &assignment.id,
            &assignment.role,
            &assignment.supersedes,
        )? {
            crate::repairs::block(tx, &goal, &reason, revision)?;
            return Ok(json!({"blocked":true,"reason":reason}));
        }
    }
    if let Some(reason) = crate::board::refuse(tx, &assignment, revision, now)? {
        return Ok(json!({"blocked":true,"capped":true,"reason":reason}));
    }
    crate::board::admit(tx, &assignment, now)?;
    if !["F", "E", "D", "C", "B", "A", "S"].contains(&assignment.rank.as_str())
        || ![
            "adventurer",
            "reviewer",
            "questwright",
            "archmage",
            "priestess",
            "petitioner",
            "swordsaint",
        ]
        .contains(&assignment.role.as_str())
    {
        return Err(Error::invalid("Unsupported Guild task rank or role"));
    }
    crate::strings(&assignment.skills, 16, 100)?;
    if assignment.review_subjects.len() > 16
        || (!assignment.review_subjects.is_empty() && assignment.role != "reviewer")
    {
        return Err(Error::invalid(
            "Review subjects require a bounded reviewer assignment",
        ));
    }
    if !assignment.review_subjects.is_empty()
        && assignment
            .review_goal_digest
            .as_ref()
            .is_none_or(|digest| digest.len() != 64)
    {
        return Err(Error::invalid(
            "Review requires a canonical user goal digest",
        ));
    }
    crate::strings(&assignment.supersedes, 16, 256)?;
    for id in &assignment.supersedes {
        let old: Assignment = store::required(tx, "assignment", id)?;
        if old.id == assignment.id
            || old.goal_id != assignment.goal_id
            || !["completed", "failed", "cancelled"].contains(&old.status.as_str())
            || (old.role == "reviewer") != (assignment.role == "reviewer")
        {
            return Err(Error::conflict(
                "Supersession requires a terminal same-goal attempt of the same work role",
            ));
        }
    }
    if assignment.review_supersessions.len() > 32
        || (!assignment.review_supersessions.is_empty() && assignment.role != "reviewer")
    {
        return Err(Error::invalid(
            "Supersession review must be bounded and independent",
        ));
    }
    let mut reviewed_ids = std::collections::BTreeSet::new();
    for subject in &assignment.review_subjects {
        if !reviewed_ids.insert(subject.assignment_id.clone()) {
            return Err(Error::invalid("Duplicate review subject"));
        }
        let source: Assignment = store::required(tx, "assignment", &subject.assignment_id)?;
        if source.route.model.is_some() && source.route.model == assignment.route.model {
            return Err(Error::forbidden(
                "A reviewer never runs on the model of the work it reviews",
            ));
        }
        if source.id == assignment.id
            || source.goal_id != assignment.goal_id
            || !["completed", "verified"].contains(&source.status.as_str())
            || source.receipt.is_none()
            || subject.digest.len() != 64
            || source
                .receipt
                .as_ref()
                .and_then(|r| r.get("latestRunId"))
                .and_then(Value::as_str)
                .or(source.execution_id.as_deref())
                != Some(subject.execution_id.as_str())
        {
            return Err(Error::conflict(
                "Review must bind completed canonical source execution",
            ));
        }
    }
    assignment.status = "queued".into();
    assignment.receipt = None;
    assignment.execution_id = None;
    assignment.actual_model = None;
    assignment.actual_effort = None;
    assignment.identity_verified = false;
    assignment.group_pause_revision = None;
    assignment.pause_status = None;
    assignment.independently_paused = false;
    assignment.attempts = 1;
    assignment.revision = revision;
    dispatch_gate(tx, &assignment, now)?;
    events::put_assignment(tx, &assignment, revision, parameters, now)?;
    crate::repairs::reserve(tx, &assignment, revision)?;
    if let Some(goal_id) = &assignment.goal_id {
        let mut goal: Goal = store::required(tx, "goal", goal_id)?;
        if !goal.assignment_ids.contains(&assignment.id) {
            goal.assignment_ids.push(assignment.id.clone());
        }
        if goal.assignment_ids.len() > 100 {
            return Err(Error::conflict("Goal assignment limit reached"));
        }
        goal.revision = revision;
        store::put(tx, "goal", goal_id, &goal, revision)?;
    }
    let action = action(tx, &assignment, "dispatch", revision, now)?;
    Ok(json!({"assignment":assignment,"action":action}))
}

pub(crate) fn update(
    tx: &Transaction<'_>,
    parameters: &Value,
    revision: u64,
    now: u64,
) -> Result<Value> {
    let mut assignment: Assignment = store::required(tx, "assignment", field(parameters, "id")?)?;
    let board = apply_update(tx, &mut assignment, parameters, revision, now)?;
    let mut result = json!({"assignment":assignment});
    if let Some(board) = board {
        result["board"] = board;
    }
    Ok(result)
}

pub(crate) fn revalidate(
    tx: &Transaction<'_>,
    parameters: &Value,
    revision: u64,
    now: u64,
) -> Result<Value> {
    let mut assignment: Assignment = store::required(tx, "assignment", field(parameters, "id")?)?;
    if assignment.status != "queued" && assignment.status != "paused" {
        return Err(Error::conflict(
            "Only queued or confirmed paused work may be revalidated",
        ));
    }
    let card: Card = store::required(tx, "card", &assignment.card_id)?;
    if parameters
        .get("instructionRevision")
        .and_then(Value::as_u64)
        != Some(card.instruction_revision)
    {
        return Err(Error::conflict(
            "Revalidation must acknowledge the current direct user instruction revision",
        ));
    }
    if assignment.instruction_revision != card.instruction_revision {
        let brief = field(parameters, "brief")?;
        text(brief, 16000, "revised delegation brief")?;
        assignment.brief = brief.into();
    }
    assignment.reservation = decode(parameters, "reservation")?;
    assignment.instruction_revision = card.instruction_revision;
    assignment.grant_revision = policy_revision(tx)?;
    assignment.pause_revision = pause_state(tx)?.revision;
    assignment.revision = revision;
    dispatch_gate(tx, &assignment, now)?;
    if assignment.status == "queued" {
        assignment.group_pause_revision = None;
        assignment.pause_status = None;
    }
    events::put_assignment(tx, &assignment, revision, parameters, now)?;
    Ok(json!({"assignment":assignment}))
}

fn apply_update(
    tx: &Transaction<'_>,
    assignment: &mut Assignment,
    parameters: &Value,
    revision: u64,
    now: u64,
) -> Result<Option<Value>> {
    let mut binding_changed = false;
    let status = parameters
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or(&assignment.status)
        .to_owned();
    if ![
        "queued",
        "dispatching",
        "submitted",
        "running",
        "blocked",
        "completed",
        "verified",
        "failed",
        "cancelled",
        "paused",
        "pausing",
        "uncertain",
    ]
    .contains(&status.as_str())
    {
        return Err(Error::invalid("Unsupported assignment status"));
    }
    if !live(&assignment.status)
        && assignment.status != status
        && !(assignment.status == "completed" && status == "verified")
    {
        return Err(Error::conflict("Terminal assignment cannot be restarted"));
    }
    if let Some(card_id) = parameters.get("cardId").and_then(Value::as_str) {
        let card: Card = store::required(tx, "card", card_id)?;
        let old: Card = store::required(tx, "card", &assignment.card_id)?;
        if old.environment_id != card.environment_id
            && (assignment.execution_id.is_some()
                || assignment.receipt.is_some()
                || (assignment.route.destination.as_deref()
                    != Some(format!("remote:{}", card.environment_id).as_str())
                    && !(card.environment_id.starts_with("cloud:")
                        && assignment.route.destination.as_deref()
                            == Some(card.environment_id.as_str()))))
        {
            return Err(Error::conflict(
                "Destination migration requires a new assignment",
            ));
        }
        binding_changed = assignment.card_id != card_id;
        assignment.card_id = card_id.into();
        assignment.instruction_revision = card.instruction_revision;
    }
    if let Some(receipt) = parameters.get("receipt") {
        if serde_json::to_string(receipt)
            .map_err(Error::internal)?
            .len()
            > 8192
        {
            return Err(Error::invalid(
                "Receipt metadata exceeds budget; retain transcript at destination",
            ));
        }
        assignment.receipt = Some(receipt.clone());
    }
    if let Some(execution_id) = parameters.get("executionId").and_then(Value::as_str) {
        identifier(execution_id)?;
        if assignment
            .execution_id
            .as_deref()
            .is_some_and(|previous| previous != execution_id)
        {
            return Err(Error::conflict(
                "Execution identity cannot change during reconciliation",
            ));
        }
        assignment.execution_id = Some(execution_id.into());
    }
    if ["submitted", "running", "completed", "verified"].contains(&status.as_str())
        && (assignment.receipt.is_none() || assignment.execution_id.is_none())
    {
        return Err(Error::conflict(
            "Submission and execution require a durable destination receipt and execution id",
        ));
    }
    if let Some(model) = parameters.get("actualModel").and_then(Value::as_str) {
        text(model, 256, "actual model")?;
        assignment.actual_model = Some(model.into());
    }
    if let Some(effort) = parameters.get("actualEffort").and_then(Value::as_str) {
        text(effort, 80, "actual effort")?;
        assignment.actual_effort = Some(effort.into());
    }
    if parameters.get("identityVerified").and_then(Value::as_bool) == Some(true) {
        let provider_selected_cloud = assignment.route.model.as_deref()
            == Some("provider-selected")
            && assignment
                .route
                .destination
                .as_deref()
                .is_some_and(|destination| destination.starts_with("cloud:"));
        if (!provider_selected_cloud && assignment.actual_model != assignment.route.model)
            || (assignment.route.effort.is_some()
                && assignment.actual_effort != assignment.route.effort)
            || assignment.actual_model.is_none()
        {
            return Err(Error::conflict(
                "Observed model or effort does not match the exact route binding",
            ));
        }
        assignment.identity_verified = true;
    }
    if status == "verified"
        && (parameters.get("verified").and_then(Value::as_bool) != Some(true)
            || parameters
                .get("evidence")
                .and_then(Value::as_array)
                .is_none_or(Vec::is_empty))
    {
        return Err(Error::forbidden(
            "Verified outcome requires explicit acceptance evidence",
        ));
    }
    if status == "running" && assignment.status != "running" {
        assignment.progress_at = Some(now);
        assignment.progress_deadline = Some(
            parameters
                .get("progressDeadline")
                .and_then(Value::as_u64)
                .unwrap_or(now.saturating_add(15 * 60 * 1000)),
        );
    }
    if parameters
        .get("meaningfulProgress")
        .and_then(Value::as_bool)
        == Some(true)
    {
        assignment.progress_at = Some(now);
        assignment.progress_deadline = Some(
            parameters
                .get("progressDeadline")
                .and_then(Value::as_u64)
                .unwrap_or(now.saturating_add(15 * 60 * 1000)),
        );
        assignment.check_ins = 0;
    }
    if parameters.get("contactConfirmed").and_then(Value::as_bool) == Some(true) {
        assignment.last_contact_at = Some(now);
    }
    if let Some(supported) = parameters.get("resumeSupported").and_then(Value::as_bool) {
        assignment.resume_supported = supported;
    }
    if parameters
        .get("independentlyPaused")
        .and_then(Value::as_bool)
        == Some(true)
    {
        assignment.independently_paused = true;
        assignment.group_pause_revision = None;
    }
    if parameters.get("directUserResume").and_then(Value::as_bool) == Some(true) {
        user(parameters)?;
        assignment.independently_paused = false;
        assignment.group_pause_revision = None;
        assignment.pause_status = Some("user-resumed exception".into());
    }
    let ending = live(&assignment.status) && !live(&status);
    assignment.status = status;
    assignment.revision = revision;
    crate::repairs::failed(tx, assignment, revision)?;
    crate::board::record_spend(tx, assignment, parameters, revision, now)?;
    let pause = pause_state(tx)?;
    if pause.active
        && ["submitted", "running", "dispatching"].contains(&assignment.status.as_str())
        && parameters.get("directUserResume").and_then(Value::as_bool) != Some(true)
    {
        let needs_pause =
            assignment.group_pause_revision != Some(pause.revision) || binding_changed;
        // A report under a pause already requested keeps that pause's acknowledged status.
        if needs_pause {
            assignment.group_pause_revision = Some(pause.revision);
            assignment.pause_status = Some("pausing".into());
        }
        events::put_assignment(tx, assignment, revision, parameters, now)?;
        if needs_pause && assignment.execution_id.is_some() {
            action(tx, assignment, "pause", revision, now)?;
        }
    } else {
        events::put_assignment(tx, assignment, revision, parameters, now)?;
    }
    if !ending {
        return Ok(None);
    }
    crate::routing::due(tx, revision, now)?;
    crate::board::after_end(tx, parameters, revision, now).map(Some)
}

pub(crate) fn pause(
    tx: &Transaction<'_>,
    parameters: &Value,
    revision: u64,
    now: u64,
) -> Result<Value> {
    user(parameters)?;
    let mut pause = pause_state(tx)?;
    if pause.active {
        return snapshot(tx, &json!({}));
    }
    pause.active = true;
    pause.revision = pause
        .revision
        .checked_add(1)
        .ok_or_else(|| Error::internal("Pause revision exhausted"))?;
    store::put(tx, "system", "pause", &pause, revision)?;
    for_each_assignment(tx, |mut assignment| {
        if !live(&assignment.status)
            || assignment.independently_paused
            || assignment.status == "paused"
        {
            return Ok(());
        }
        assignment.group_pause_revision = Some(pause.revision);
        assignment.pause_status = Some(
            if assignment.status == "queued" {
                "paused"
            } else {
                "pausing"
            }
            .into(),
        );
        assignment.revision = revision;
        events::put_assignment(tx, &assignment, revision, parameters, now)?;
        if assignment.status != "queued" && assignment.execution_id.is_some() {
            action(tx, &assignment, "pause", revision, now)?;
        }
        Ok(())
    })?;
    snapshot(tx, &json!({}))
}

pub(crate) fn resume(
    tx: &Transaction<'_>,
    parameters: &Value,
    revision: u64,
    now: u64,
) -> Result<Value> {
    user(parameters)?;
    let mut pause = pause_state(tx)?;
    if !pause.active {
        return snapshot(tx, &json!({}));
    }
    let group_revision = pause.revision;
    pause.active = false;
    pause.revision = pause
        .revision
        .checked_add(1)
        .ok_or_else(|| Error::internal("Pause revision exhausted"))?;
    store::put(tx, "system", "pause", &pause, revision)?;
    for_each_assignment(tx, |mut assignment| {
        if !live(&assignment.status)
            || assignment.independently_paused
            || assignment.group_pause_revision != Some(group_revision)
        {
            return Ok(());
        }
        let card: Card = store::required(tx, "card", &assignment.card_id)?;
        if card.settled
            || card.archived
            || card.stale
            || card.instruction_revision != assignment.instruction_revision
            || assignment.grant_revision != policy_revision(tx)?
        {
            assignment.pause_status = Some("revalidation required".into());
        } else if assignment.status == "queued" {
            assignment.pause_status = Some("capacity revalidation required".into());
        } else if assignment.pause_status.as_deref() == Some("paused")
            && assignment.resume_supported
        {
            assignment.pause_revision = pause.revision;
            action(tx, &assignment, "resume", revision, now)?;
            assignment.pause_status = Some("resuming".into());
        } else {
            assignment.pause_status = Some("resume unsupported or pause unconfirmed".into());
        }
        assignment.revision = revision;
        events::put_assignment(tx, &assignment, revision, parameters, now)?;
        Ok(())
    })?;
    snapshot(tx, &json!({}))
}

pub(crate) fn cancel(
    tx: &Transaction<'_>,
    parameters: &Value,
    revision: u64,
    now: u64,
) -> Result<Value> {
    let mut assignment: Assignment = store::required(tx, "assignment", field(parameters, "id")?)?;
    if !live(&assignment.status) {
        return Ok(json!({"assignment":assignment}));
    }
    if assignment.status == "queued" {
        assignment.status = "cancelled".into();
        assignment.revision = revision;
        events::put_assignment(tx, &assignment, revision, parameters, now)?;
        return Ok(json!({"assignment":assignment}));
    }
    if assignment.execution_id.is_none() {
        return Ok(json!({"assignment":assignment,"reconciliationRequired":true}));
    }
    let action = action(tx, &assignment, "cancel", revision, now)?;
    Ok(json!({"assignment":assignment,"action":action}))
}

pub(crate) fn stop(
    tx: &Transaction<'_>,
    parameters: &Value,
    revision: u64,
    now: u64,
) -> Result<Value> {
    user(parameters)?;
    pause(tx, parameters, revision, now)?;
    for_each_assignment(tx, |assignment| {
        if live(&assignment.status) {
            cancel(tx, &json!({"id":assignment.id}), revision, now)?;
        }
        Ok(())
    })?;
    snapshot(tx, &json!({}))
}

pub(crate) fn claim(
    tx: &Transaction<'_>,
    parameters: &Value,
    revision: u64,
    now: u64,
) -> Result<Value> {
    let mut action: Action = store::required(tx, "action", field(parameters, "id")?)?;
    if action.status != "pending"
        && !(["thread.settle", "outcome.accepted"].contains(&action.kind.as_str())
            && ["claimed", "uncertain"].contains(&action.status.as_str()))
    {
        return Err(Error::conflict(
            "Action was already claimed; inspect its stable receipt before retrying",
        ));
    }
    if action.kind == "thread.settle" {
        if !crate::settlement::claim(tx, &mut action, revision)? {
            return Ok(json!({"action":action,"claimed":false}));
        }
    } else if let Some(assignment_id) = &action.assignment_id {
        let mut assignment: Assignment = store::required(tx, "assignment", assignment_id)?;
        if !live(&assignment.status) {
            return Err(Error::conflict("Assignment has reached a terminal state"));
        }
        match action.kind.as_str() {
            "dispatch" => {
                if assignment.status != "queued" {
                    return Err(Error::conflict(
                        "Assignment already submitted or submission is uncertain",
                    ));
                }
                dispatch_gate(tx, &assignment, now)?;
                assignment.status = "dispatching".into();
                assignment.revision = revision;
                events::put_assignment(tx, &assignment, revision, parameters, now)?;
                let card: Card = store::required(tx, "card", &assignment.card_id)?;
                action.payload = json!({"assignment":assignment,"card":card});
                action.pause_revision = assignment.pause_revision;
                action.instruction_revision = Some(assignment.instruction_revision);
                action.grant_revision = Some(assignment.grant_revision);
            }
            "resume" => {
                if pause_state(tx)?.active
                    || assignment.independently_paused
                    || assignment.pause_status.as_deref() != Some("resuming")
                {
                    return Err(Error::conflict(
                        "Resume was invalidated by a newer pause or direct user intervention",
                    ));
                }
                dispatch_gate(tx, &assignment, now)?;
                if !assignment.resume_supported {
                    return Err(Error::forbidden(
                        "Destination does not support reliable resume",
                    ));
                }
            }
            "pause" => {
                let pause = pause_state(tx)?;
                let card: Card = store::required(tx, "card", &assignment.card_id)?;
                if !pause.active
                    || assignment.group_pause_revision != Some(action.pause_revision)
                    || action.thread_id.as_deref() != Some(card.thread_id.as_str())
                {
                    return Err(Error::conflict("Group pause action has been superseded"));
                }
            }
            "cancel" | "inspect" => {}
            _ => return Err(Error::invalid("Unsupported assignment action")),
        }
    } else if action.kind == "permission.respond" {
        let request: Value = store::required(
            tx,
            "permissionRequest",
            field(&action.payload, "requestId")?,
        )?;
        if request["status"] != "answering"
            || request["revision"] != action.payload["requestRevision"]
        {
            return Err(Error::conflict(
                "Permission request was already answered or changed",
            ));
        }
        let card: Card = store::required(tx, "card", field(&request, "cardId")?)?;
        if card.settled
            || card.archived
            || Some(card.instruction_revision) != action.instruction_revision
        {
            return Err(Error::conflict(
                "Thread instructions invalidated the permission response",
            ));
        }
        if action.payload["actor"] != "user" {
            if action.grant_revision != Some(policy_revision(tx)?) {
                return Err(Error::conflict(
                    "Permission policy changed before response execution",
                ));
            }
            let effective = policy::effective(tx, &request, now)?;
            // What the model was left to answer still asks; it is delivered while it is still its.
            if action.payload["actor"] == "coordinator-model" {
                policy::model_may(&effective, field(&action.payload, "decision")?)?;
            } else if effective["effect"] == "ask"
                || (action.payload["decision"] == "approve" && effective["effect"] != "allow")
            {
                return Err(Error::forbidden(
                    "Autonomous permission response is no longer authorized",
                ));
            }
        }
        if let Some(id) = request["assignmentId"].as_str()
            && let Some(mut assignment) = store::get::<Assignment>(tx, "assignment", id)?
        {
            let before = assignment.receipt.clone();
            // Left pending, it is claimed again on a later pass, once there is room.
            if !crate::board::unpark(tx, &mut assignment, now)? {
                return Ok(json!({"action":action,"claimed":false}));
            }
            if assignment.receipt != before {
                assignment.revision = revision;
                events::put_assignment(tx, &assignment, revision, parameters, now)?;
            }
        }
    } else if !["catalog.refresh", "outcome.accepted"].contains(&action.kind.as_str()) {
        return Err(Error::invalid("Unsupported action kind"));
    }
    action.status = "claimed".into();
    action.revision = revision;
    store::put(tx, "action", &action.id, &action, revision)?;
    Ok(json!({"action":action,"claimed":true}))
}

pub(crate) fn ack(
    tx: &Transaction<'_>,
    parameters: &Value,
    revision: u64,
    now: u64,
) -> Result<Value> {
    let mut pending: Action = store::required(tx, "action", field(parameters, "id")?)?;
    let status = field(parameters, "status")?;
    if ![
        "completed",
        "unsupported",
        "unreachable",
        "failed",
        "uncertain",
    ]
    .contains(&status)
    {
        return Err(Error::invalid("Unsupported action acknowledgement"));
    }
    if pending.status == status {
        return Ok(json!({"action":pending,"deduplicated":true}));
    }
    if !["claimed", "uncertain"].contains(&pending.status.as_str()) {
        return Err(Error::conflict(
            "Action must be claimed before acknowledgement",
        ));
    }
    let result = parameters
        .get("result")
        .cloned()
        .unwrap_or_else(|| json!({}));
    if pending.kind == "outcome.accepted" {
        if status == "completed"
            && (result.get("eventId") != pending.payload["event"].get("eventId")
                || result
                    .get("digest")
                    .and_then(Value::as_str)
                    .is_none_or(|digest| {
                        digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit())
                    }))
        {
            return Err(Error::conflict(
                "Accepted outcome requires its exact durable destination receipt",
            ));
        }
    } else if pending.kind == "thread.settle" {
        crate::settlement::acknowledge(tx, &pending, status, &result, revision)?;
    } else if let Some(assignment_id) = &pending.assignment_id {
        let mut assignment: Assignment = store::required(tx, "assignment", assignment_id)?;
        match pending.kind.as_str() {
            "dispatch" => {
                let mut update = result.clone();
                if !update.is_object() {
                    return Err(Error::invalid("Action result must be an object"));
                }
                if status == "completed" {
                    if update.get("status").is_none() {
                        update["status"] = json!("submitted");
                    }
                    apply_update(tx, &mut assignment, &update, revision, now)?;
                } else {
                    assignment.status = if status == "failed" || status == "unsupported" {
                        "failed"
                    } else {
                        "uncertain"
                    }
                    .into();
                    assignment.revision = revision;
                    events::put_assignment(tx, &assignment, revision, parameters, now)?;
                }
            }
            "pause" => {
                let card: Card = store::required(tx, "card", &assignment.card_id)?;
                if live(&assignment.status)
                    && assignment.group_pause_revision == Some(pending.pause_revision)
                    && pending.thread_id.as_deref() == Some(card.thread_id.as_str())
                {
                    assignment.pause_status = Some(
                        match status {
                            "completed" => "paused",
                            "unsupported" => "pause unsupported",
                            "unreachable" | "uncertain" => "unreachable",
                            _ => "pausing",
                        }
                        .into(),
                    );
                    if status == "completed" {
                        assignment.status = "paused".into();
                        assignment.resume_supported = result
                            .get("resumeSupported")
                            .and_then(Value::as_bool)
                            .unwrap_or(false);
                        let current_pause = pause_state(tx)?;
                        if !current_pause.active && current_pause.revision > pending.pause_revision
                        {
                            if assignment.resume_supported
                                && !assignment.independently_paused
                                && !card.settled
                                && !card.archived
                                && !card.stale
                                && card.instruction_revision == assignment.instruction_revision
                                && assignment.grant_revision == policy_revision(tx)?
                                && assignment.reservation.expires_at > now
                            {
                                assignment.pause_revision = current_pause.revision;
                                action(tx, &assignment, "resume", revision, now)?;
                                assignment.pause_status = Some("resuming".into());
                            } else {
                                assignment.pause_status = Some(
                                    "pause confirmed after resume; revalidation required".into(),
                                );
                            }
                        }
                    }
                    assignment.revision = revision;
                    events::put_assignment(tx, &assignment, revision, parameters, now)?;
                }
            }
            "resume" => {
                if status == "completed" {
                    assignment.status = result
                        .get("status")
                        .and_then(Value::as_str)
                        .unwrap_or("running")
                        .into();
                    assignment.group_pause_revision = None;
                    assignment.pause_status = None;
                } else {
                    assignment.pause_status = Some(
                        if status == "unsupported" {
                            "resume unsupported"
                        } else {
                            "unreachable"
                        }
                        .into(),
                    );
                }
                assignment.revision = revision;
                events::put_assignment(tx, &assignment, revision, parameters, now)?;
                if pause_state(tx)?.active && status == "completed" {
                    apply_update(
                        tx,
                        &mut assignment,
                        &json!({"status":"running"}),
                        revision,
                        now,
                    )?;
                }
            }
            "cancel" => {
                if status == "completed" {
                    assignment.status = "cancelled".into();
                }
                assignment.revision = revision;
                events::put_assignment(tx, &assignment, revision, parameters, now)?;
            }
            "inspect" => {
                assignment.last_contact_at = (status == "completed")
                    .then_some(now)
                    .or(assignment.last_contact_at);
                if status == "completed"
                    && result.get("meaningfulProgress").and_then(Value::as_bool) == Some(true)
                {
                    apply_update(tx, &mut assignment, &result, revision, now)?;
                } else {
                    assignment.check_ins = assignment.check_ins.saturating_add(1);
                    assignment.progress_deadline = Some(now.saturating_add(15 * 60 * 1000));
                    if assignment.check_ins >= 2 {
                        assignment.status = "blocked".into();
                    }
                    assignment.revision = revision;
                    events::put_assignment(tx, &assignment, revision, parameters, now)?;
                }
            }
            _ => {}
        }
    } else if pending.kind == "permission.respond" {
        let request_id = field(&pending.payload, "requestId")?;
        let mut request: Value = store::required(tx, "permissionRequest", request_id)?;
        if request["revision"] == pending.payload["requestRevision"] {
            request["status"] = json!(if status == "completed" {
                "answered"
            } else if status == "failed" || status == "unsupported" {
                "pending"
            } else {
                "uncertain"
            });
            request["destinationAcknowledged"] = json!(status == "completed");
            request["revision"] = json!(revision);
            store::put(tx, "permissionRequest", request_id, &request, revision)?;
        }
    } else if pending.kind == "catalog.refresh" && status != "completed" {
        let source = field(&pending.payload, "sourceId")?;
        registry::sync_catalog(
            tx,
            &json!({"sourceId":source,"success":false}),
            revision,
            now,
        )?;
    }
    pending.status = status.into();
    pending.revision = revision;
    if !result.is_null() {
        pending.payload["acknowledgement"] = result;
    }
    store::put(tx, "action", &pending.id, &pending, revision)?;
    Ok(json!({"action":pending}))
}

pub(crate) fn tick(
    tx: &Transaction<'_>,
    _parameters: &Value,
    revision: u64,
    now: u64,
) -> Result<Value> {
    let mut due = Vec::new();
    if !pause_state(tx)?.active {
        for_each_assignment(tx, |assignment| {
            if assignment.status != "running"
                || assignment.independently_paused
                || assignment
                    .progress_deadline
                    .is_none_or(|deadline| deadline > now)
            {
                return Ok(());
            }
            let pending: u64 = tx.query_row("SELECT COUNT(*) FROM documents WHERE kind='action' AND json_extract(body,'$.assignmentId')=?1 AND json_extract(body,'$.kind')='inspect' AND json_extract(body,'$.status') IN ('pending','claimed','uncertain')",[&assignment.id],|row| row.get(0)).map_err(Error::internal)?;
            if pending == 0 {
                due.push(action(tx, &assignment, "inspect", revision, now)?);
            }
            Ok(())
        })?;
    }
    let mut after = String::new();
    loop {
        let sources = store::list::<Value>(tx, "catalogSource", "1", &after, 100)?;
        if sources.is_empty() {
            break;
        }
        for source in sources {
            after = field(&source, "id")?.into();
            if source["refreshing"] != true
                && source["automaticDiscovery"] != false
                && source["nextRefreshAt"].as_u64().unwrap_or(0) <= now
            {
                registry::refresh_catalog(
                    tx,
                    &json!({"sourceId":after,"automatic":true}),
                    revision,
                    now,
                )?;
            }
        }
    }
    Ok(json!({"due":due,"revision":store::revision(tx)?}))
}
