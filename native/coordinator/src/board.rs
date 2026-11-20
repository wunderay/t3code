use crate::{
    Error, Result, config, decode, field, identifier, model::*, pause_state, policy::all_matching,
    store, supervision::live, user,
};
use rusqlite::{Transaction, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

pub const P0: u8 = 0;
pub const P1: u8 = 1;
pub const P2: u8 = 2;
/// A second try may go to a route scoring at most this much below the one that failed.
pub const SIMILAR_SCORE: f64 = 5.0;
const AGING_MS: u64 = 6 * 3_600_000;
const DAY_MS: u64 = 86_400_000;

/// Limits only the owner sets; none is set unless they choose one.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct Limits {
    pub in_flight: Option<usize>,
    pub per_login: Option<usize>,
    pub local_slots: Option<usize>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capacity {
    pub limits: Limits,
    pub in_flight: usize,
    pub local: usize,
    pub logins: BTreeMap<String, usize>,
}

impl Capacity {
    fn add(&mut self, route: &RouteSelection) {
        self.in_flight += 1;
        self.local += usize::from(route.destination.as_deref() == Some("local"));
        *self.logins.entry(login(route)).or_default() += 1;
    }

    /// Why `route` cannot take one more assignment now under the owner's limits, if it cannot.
    pub fn admits(&self, route: &RouteSelection, reviewer: bool) -> Option<&'static str> {
        // The owner's limits bound authors; a review is what lets finished work land.
        if reviewer {
            return None;
        }
        let over = |limit: Option<usize>, count: usize| limit.is_some_and(|limit| count >= limit);
        if over(self.limits.in_flight, self.in_flight) {
            return Some("at the in-flight limit you set");
        }
        if over(
            self.limits.per_login,
            self.logins.get(&login(route)).copied().unwrap_or(0),
        ) {
            return Some("login at the limit you set");
        }
        if route.destination.as_deref() == Some("local")
            && over(self.limits.local_slots, self.local)
        {
            return Some("at the local limit you set");
        }
        None
    }
}

fn login(route: &RouteSelection) -> String {
    format!(
        "{}:{}",
        route.provider.as_deref().unwrap_or(""),
        route.account.as_deref().unwrap_or("")
    )
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Score {
    pub provider: String,
    pub model: String,
    #[serde(default)]
    pub effort: Option<String>,
    pub score: f64,
    #[serde(default)]
    pub tier: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteKey {
    pub provider: String,
    pub model: String,
    /// None: every effort of the model.
    pub effort: Option<String>,
}

impl RouteKey {
    fn of(route: &RouteSelection, with_effort: bool) -> Self {
        Self {
            provider: route.provider.clone().unwrap_or_default(),
            model: route.model.clone().unwrap_or_default(),
            effort: route.effort.clone().filter(|_| with_effort),
        }
    }

    fn matches(&self, route: &RouteSelection) -> bool {
        route.provider.as_deref() == Some(self.provider.as_str())
            && route.model.as_deref() == Some(self.model.as_str())
            && self
                .effort
                .as_ref()
                .is_none_or(|effort| route.effort.as_ref() == Some(effort))
    }
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileKey {
    pub profile_id: String,
    pub effort: Option<String>,
}

/// What the next route of a goal must satisfy after its failures of skill, oldest first.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ladder {
    pub exclude: Vec<RouteKey>,
    pub exclude_profiles: Vec<ProfileKey>,
    pub min_score: Option<f64>,
    pub min_tier: Option<u32>,
}

impl Ladder {
    pub fn allows(&self, route: &RouteSelection, score: Option<f64>, tier: Option<u32>) -> bool {
        !self.exclude.iter().any(|key| key.matches(route))
            && !self.exclude_profiles.iter().any(|key| {
                route.profile_id.as_ref() == Some(&key.profile_id) && route.effort == key.effort
            })
            && self
                .min_score
                .is_none_or(|min| score.is_some_and(|score| score >= min))
            && self
                .min_tier
                .is_none_or(|min| tier.is_some_and(|tier| tier >= min))
    }
}

pub fn ladder(failed: &[RouteSelection], scores: &[Score]) -> Ladder {
    let known: Vec<&Score> = failed
        .iter()
        .filter_map(|route| {
            scores.iter().find(|score| {
                route.provider.as_deref() == Some(score.provider.as_str())
                    && route.model.as_deref() == Some(score.model.as_str())
                    && route.effort == score.effort
            })
        })
        .collect();
    let best = known.iter().map(|score| score.score).reduce(f64::max);
    match failed {
        [] => Ladder::default(),
        [only] => Ladder {
            exclude: vec![RouteKey::of(only, false)],
            min_score: best.map(|score| score - SIMILAR_SCORE),
            ..Ladder::default()
        },
        _ => {
            let mut exclude: Vec<RouteKey> = failed
                .iter()
                .map(|route| RouteKey::of(route, true))
                .collect();
            exclude.sort();
            exclude.dedup();
            let mut exclude_profiles: Vec<ProfileKey> = failed
                .iter()
                .filter_map(|route| {
                    Some(ProfileKey {
                        profile_id: route.profile_id.clone()?,
                        effort: route.effort.clone(),
                    })
                })
                .collect();
            exclude_profiles.sort();
            exclude_profiles.dedup();
            Ladder {
                exclude,
                exclude_profiles,
                min_score: best,
                min_tier: known.iter().filter_map(|score| score.tier).max(),
            }
        }
    }
}

/// Equal paths, or one a folder of the other.
pub fn overlaps(a: &[String], b: &[String]) -> bool {
    let within = |x: &str, y: &str| x.starts_with(&format!("{}/", y.trim_end_matches('/')));
    a.iter()
        .any(|x| b.iter().any(|y| x == y || within(x, y) || within(y, x)))
}

fn finished(goal: &Goal) -> bool {
    ["completed", "cancelled"].contains(&goal.status.as_str())
}

/// P0 when finishing a goal completes an open dependent's last dependency, P1 when other open work
/// depends on it, else P2.
pub fn classes(goals: &[Goal]) -> BTreeMap<&str, u8> {
    let by_id: BTreeMap<&str, &Goal> = goals.iter().map(|goal| (goal.id.as_str(), goal)).collect();
    let mut dependents: BTreeMap<&str, Vec<&Goal>> = BTreeMap::new();
    for goal in goals.iter().filter(|goal| !finished(goal)) {
        for dependency in &goal.dependencies {
            dependents.entry(dependency).or_default().push(goal);
        }
    }
    goals
        .iter()
        .map(|goal| {
            let open = dependents
                .get(goal.id.as_str())
                .map_or(&[][..], Vec::as_slice);
            let unblocks = open.iter().any(|dependent| {
                dependent.dependencies.iter().all(|id| {
                    *id == goal.id
                        || by_id
                            .get(id.as_str())
                            .is_some_and(|d| d.status == "completed")
                })
            });
            let class = if unblocks {
                P0
            } else if open.is_empty() {
                P2
            } else {
                P1
            };
            (goal.id.as_str(), class)
        })
        .collect()
}

pub fn ready(goal: &Goal, goals: &[Goal]) -> bool {
    goal.status == "active"
        && goal.dependencies.iter().all(|id| {
            goals
                .iter()
                .any(|dependency| dependency.id == *id && dependency.status == "completed")
        })
}

/// The queued goals by class, raised one step per six hours waited, then first queued first.
pub fn order(goals: &[Goal], queued: &BTreeMap<String, u64>, now: u64) -> Vec<(String, u8)> {
    let classes = classes(goals);
    let mut items: Vec<(u8, u64, String)> = queued
        .iter()
        .map(|(id, at)| {
            let class = classes.get(id.as_str()).copied().unwrap_or(P2);
            let steps = u8::try_from(now.saturating_sub(*at) / AGING_MS).unwrap_or(u8::MAX);
            (class.saturating_sub(steps), *at, id.clone())
        })
        .collect();
    items.sort();
    items
        .into_iter()
        .map(|(class, _, id)| (id, class))
        .collect()
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Cap {
    #[serde(default)]
    pub micros: Option<u64>,
    #[serde(default)]
    pub seconds: Option<u64>,
}

/// Far below where a sum of reported totals could overflow.
const MAX_SPEND: u64 = 1_000_000_000_000_000;
const LIVE: &str =
    "json_extract(body,'$.status') NOT IN ('completed','verified','cancelled','failed')";
/// Two check-ins at their default: the Coordinator has reported the wait twice before it frees
/// the slot.
const PARK_MINUTES: u32 = 30;

/// Live work that holds a slot and a login: work waiting on the owner longer than the park time
/// is parked and holds neither, and still waits for the owner's answer.
pub(crate) fn holding(tx: &Transaction<'_>, now: u64) -> Result<String> {
    let since = parked_since(tx, now)?;
    Ok(format!(
        "{LIVE} AND NOT (json_extract(body,'$.status')='blocked' AND COALESCE(json_extract(body,'$.receipt.blockedSince')<={since},0))"
    ))
}

fn parked_since(tx: &Transaction<'_>, now: u64) -> Result<u64> {
    let minutes = config(tx)?.park_minutes.unwrap_or(PARK_MINUTES);
    Ok(now.saturating_sub(u64::from(minutes) * 60_000))
}

/// The owner's answer resumes parked work only once it has room again; it then holds its slot and
/// login at once, its wait so far added to the time it waited on the owner.
pub(crate) fn unpark(tx: &Transaction<'_>, assignment: &mut Assignment, now: u64) -> Result<bool> {
    let since = parked_since(tx, now)?;
    let blocked = assignment
        .receipt
        .as_ref()
        .and_then(|receipt| receipt["blockedSince"].as_u64());
    let Some(blocked) =
        blocked.filter(|blocked| assignment.status == "blocked" && *blocked <= since)
    else {
        return Ok(true);
    };
    if admit(tx, assignment, now).is_err() {
        return Ok(false);
    }
    if let Some(receipt) = assignment.receipt.as_mut().and_then(Value::as_object_mut) {
        receipt.remove("blockedSince");
        let waited = receipt
            .get("blockedSeconds")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        receipt.insert(
            "blockedSeconds".into(),
            json!(waited.saturating_add(now.saturating_sub(blocked) / 1000)),
        );
    }
    Ok(true)
}

fn spent(tx: &Transaction<'_>, key: &str, value: &str, day: Option<u64>) -> Result<(u64, u64)> {
    let mut statement = tx
        .prepare("SELECT json_extract(body,'$.micros'),json_extract(body,'$.seconds') FROM documents WHERE kind='spend' AND json_extract(body,?1)=?2 AND (?3 IS NULL OR json_extract(body,'$.day')=?3)")
        .map_err(Error::internal)?;
    let rows = statement
        .query_map(params![format!("$.{key}"), value, day], |row| {
            Ok((row.get::<_, u64>(0)?, row.get::<_, u64>(1)?))
        })
        .map_err(Error::internal)?;
    rows.map(|row| row.map_err(Error::internal))
        .try_fold((0u64, 0u64), |(micros, seconds), row| {
            let (more_micros, more_seconds) = row?;
            Ok((
                micros.saturating_add(more_micros),
                seconds.saturating_add(more_seconds),
            ))
        })
}

fn over(cap: &Cap, (micros, seconds): (u64, u64)) -> Option<String> {
    if let Some(limit) = cap.micros.filter(|limit| micros >= *limit) {
        return Some(format!("{micros} of {limit} micros used"));
    }
    cap.seconds
        .filter(|limit| seconds >= *limit)
        .map(|limit| format!("{seconds} of {limit} seconds worked"))
}

/// The cap a goal or its project has reached, reported to the owner once per cap and reason.
fn capped(
    tx: &Transaction<'_>,
    goal: Option<&Goal>,
    project: Option<&str>,
    revision: u64,
    now: u64,
) -> Result<Option<String>> {
    let day = now / DAY_MS;
    let mut found = None;
    if let Some(goal) = goal {
        let cap = Cap {
            micros: goal.budget_micros,
            seconds: goal.budget_seconds,
        };
        if let Some(used) = over(&cap, spent(tx, "goalId", &goal.id, None)?) {
            found = Some((
                format!("budget:{}", goal.id),
                format!("Goal {} reached its cap: {used}", goal.id),
                vec![goal.id.clone()],
                None,
            ));
        }
    }
    if found.is_none()
        && let Some(project) = project
        && let Some(cap) = store::get::<Cap>(tx, "budget", project)?
        && let Some(used) = over(&cap, spent(tx, "projectId", project, Some(day))?)
    {
        found = Some((
            format!("budget:{project}:{day}"),
            format!("Project {project} reached its daily cap: {used}"),
            vec![],
            Some((day + 1) * DAY_MS),
        ));
    }
    let Some((id, summary, goal_ids, expires_at)) = found else {
        return Ok(None);
    };
    if store::get::<Decision>(tx, "decision", &id)?.is_none_or(|old| old.summary != summary) {
        let decision = Decision {
            id: id.clone(),
            summary: summary.clone(),
            provenance: "coordinator-budget".into(),
            card_ids: vec![],
            goal_ids,
            expires_at,
            revision,
        };
        store::put(tx, "decision", &id, &decision, revision)?;
    }
    Ok(Some(summary))
}

/// Every cap reached now, under which nothing new starts: what the owner sees under Needs you.
pub(crate) fn with_reached(tx: &Transaction<'_>, mut snapshot: Value, now: u64) -> Result<Value> {
    if !config(tx)?.enabled {
        return Ok(snapshot);
    }
    let day = now / DAY_MS;
    let mut reached = Vec::new();
    let budgets = tx
        .prepare("SELECT id, body FROM documents WHERE kind='budget' ORDER BY id")
        .and_then(|mut statement| {
            statement
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()
        })
        .map_err(Error::internal)?;
    for (project, body) in budgets {
        let cap: Cap = serde_json::from_str(&body).map_err(Error::internal)?;
        let used = spent(tx, "projectId", &project, Some(day))?;
        if over(&cap, used).is_some() {
            reached.push(json!({"projectId":project,"cap":cap,"micros":used.0,"seconds":used.1}));
        }
    }
    for goal in store::every::<Goal>(
        tx,
        "goal",
        "json_extract(body,'$.status') IN ('active','blocked','merging') AND COALESCE(json_extract(body,'$.budgetMicros'),json_extract(body,'$.budgetSeconds')) IS NOT NULL",
    )? {
        let cap = Cap {
            micros: goal.budget_micros,
            seconds: goal.budget_seconds,
        };
        let used = spent(tx, "goalId", &goal.id, None)?;
        if over(&cap, used).is_some() {
            reached.push(json!({"goalId":goal.id,"cap":cap,"micros":used.0,"seconds":used.1}));
        }
    }
    snapshot["budgetsReached"] = json!(reached);
    Ok(snapshot)
}

fn goal_of(tx: &Transaction<'_>, assignment: &Assignment) -> Result<Option<Goal>> {
    assignment
        .goal_id
        .as_ref()
        .map(|id| store::required(tx, "goal", id))
        .transpose()
}

/// The board reads a goal's project, so work for a goal counts against that project too.
fn project_of(
    tx: &Transaction<'_>,
    assignment: &Assignment,
    goal: Option<&Goal>,
) -> Result<Option<String>> {
    match goal {
        Some(goal) => Ok(goal.project_id.clone()),
        None => Ok(Some(
            store::required::<Card>(tx, "card", &assignment.card_id)?.project_id,
        )),
    }
}

/// Why an assignment may not start: its goal or project is at a cap.
pub(crate) fn refuse(
    tx: &Transaction<'_>,
    assignment: &Assignment,
    revision: u64,
    now: u64,
) -> Result<Option<String>> {
    // A review is what lets work already paid for land.
    if assignment.role == "reviewer" {
        return Ok(None);
    }
    let goal = goal_of(tx, assignment)?;
    let project = project_of(tx, assignment, goal.as_ref())?;
    capped(tx, goal.as_ref(), project.as_deref(), revision, now)
}

// Limits are the owner's, so no request a model can shape carries them.
pub(crate) fn set_limits(tx: &Transaction<'_>, parameters: &Value, revision: u64) -> Result<Value> {
    user(parameters)?;
    let limits: Limits = decode(parameters, "limits")?;
    store::put(tx, "system", "boardLimits", &limits, revision)?;
    Ok(json!({"limits":limits}))
}

fn capacity(tx: &Transaction<'_>, now: u64) -> Result<Capacity> {
    let mut capacity = Capacity {
        limits: store::get(tx, "system", "boardLimits")?.unwrap_or_default(),
        ..Capacity::default()
    };
    for assignment in all_matching::<Assignment>(tx, "assignment", &holding(tx, now)?)? {
        capacity.add(&assignment.route);
    }
    Ok(capacity)
}

/// Refuses an assignment its route has no room for.
pub(crate) fn admit(tx: &Transaction<'_>, assignment: &Assignment, now: u64) -> Result<()> {
    let capacity = capacity(tx, now)?;
    match capacity.admits(&assignment.route, assignment.role == "reviewer") {
        Some(reason) => Err(Error::conflict(format!("Capacity: {reason}"))),
        None => Ok(()),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Spend {
    /// None when the destination reports no use: the route's bench estimate counts instead.
    #[serde(default)]
    micros: Option<u64>,
    #[serde(default)]
    seconds: u64,
}

/// An assignment reports its running totals; what each report adds counts on the day it arrives.
pub(crate) fn record_spend(
    tx: &Transaction<'_>,
    assignment: &Assignment,
    parameters: &Value,
    revision: u64,
    now: u64,
) -> Result<()> {
    let Some(spend) = optional::<Option<Spend>>(parameters, "spend")? else {
        return Ok(());
    };
    let spend_micros = match spend.micros {
        Some(micros) => micros,
        None => crate::router::estimate(tx, &assignment.route)?,
    };
    if spend_micros > MAX_SPEND || spend.seconds > MAX_SPEND {
        return Err(Error::invalid(format!(
            "Spend totals must be at most {MAX_SPEND}"
        )));
    }
    let goal = goal_of(tx, assignment)?;
    let project = project_of(tx, assignment, goal.as_ref())?;
    let (micros, seconds) = spent(tx, "assignmentId", &assignment.id, None)?;
    let day = now / DAY_MS;
    let id = format!("{}:{day}", assignment.id);
    let today = store::get::<Value>(tx, "spend", &id)?.unwrap_or_else(|| json!({}));
    let row = json!({"assignmentId":assignment.id,"goalId":assignment.goal_id,"projectId":project,"day":day,
        "micros":today["micros"].as_u64().unwrap_or(0) + spend_micros.saturating_sub(micros),
        "seconds":today["seconds"].as_u64().unwrap_or(0) + spend.seconds.saturating_sub(seconds)});
    store::put(tx, "spend", &id, &row, revision)
}

/// Goals keep the caps the owner set with board.budget.
pub(crate) fn keep_budget(tx: &Transaction<'_>, goal: &mut Goal) -> Result<()> {
    let budget = store::get::<Goal>(tx, "goal", &goal.id)?
        .map(|previous| (previous.budget_micros, previous.budget_seconds))
        .unwrap_or_default();
    if (goal.budget_micros.is_some() || goal.budget_seconds.is_some())
        && (goal.budget_micros, goal.budget_seconds) != budget
    {
        return Err(Error::forbidden(
            "Only the owner sets a goal's caps, with board.budget",
        ));
    }
    (goal.budget_micros, goal.budget_seconds) = budget;
    Ok(())
}

pub(crate) fn set_budget(tx: &Transaction<'_>, parameters: &Value, revision: u64) -> Result<Value> {
    user(parameters)?;
    let cap: Cap = decode(parameters, "cap")?;
    if parameters.get("goalId").is_some() {
        let mut goal: Goal = store::required(tx, "goal", field(parameters, "goalId")?)?;
        goal.budget_micros = cap.micros;
        goal.budget_seconds = cap.seconds;
        goal.revision = revision;
        store::put(tx, "goal", &goal.id, &goal, revision)?;
        return Ok(json!({"goal":goal}));
    }
    let project = field(parameters, "projectId")?;
    identifier(project)?;
    if cap == Cap::default() {
        store::remove(tx, "budget", project, revision)?;
    } else {
        store::put(tx, "budget", project, &cap, revision)?;
    }
    Ok(json!({"projectId":project,"cap":cap}))
}

fn optional<T: serde::de::DeserializeOwned + Default>(parameters: &Value, key: &str) -> Result<T> {
    match parameters.get(key) {
        None | Some(Value::Null) => Ok(T::default()),
        Some(_) => decode(parameters, key),
    }
}

/// The roles whose work is the goal's change; other roles' finished work leaves it waiting.
fn author(role: &str) -> bool {
    ["adventurer", "swordsaint"].contains(&role)
}

/// The board after an assignment ends; a board that cannot be computed never undoes the end.
pub(crate) fn after_end(
    tx: &Transaction<'_>,
    parameters: &Value,
    revision: u64,
    now: u64,
) -> Result<Value> {
    tx.execute_batch("SAVEPOINT board")
        .map_err(Error::internal)?;
    let board = next(tx, parameters, revision, now);
    if board.is_err() {
        tx.execute_batch("ROLLBACK TO board")
            .map_err(Error::internal)?;
    }
    tx.execute_batch("RELEASE board").map_err(Error::internal)?;
    Ok(board.unwrap_or_else(|error| json!({"error":error})))
}

/// The goals that may start now, in order, each with the ladder its next route must satisfy.
pub(crate) fn next(
    tx: &Transaction<'_>,
    parameters: &Value,
    revision: u64,
    now: u64,
) -> Result<Value> {
    let capacity = capacity(tx, now)?;
    let scores: Vec<Score> = optional(parameters, "scores")?;
    let mut goals: Vec<Goal> = all_matching(
        tx,
        "goal",
        "json_extract(body,'$.status') IN ('active','blocked')",
    )?;
    let open = goals.len();
    let finished: BTreeSet<String> = goals
        .iter()
        .flat_map(|goal| goal.dependencies.iter().cloned())
        .filter(|id| !goals.iter().any(|goal| goal.id == *id))
        .collect();
    for id in finished {
        goals.extend(store::get::<Goal>(tx, "goal", &id)?);
    }
    let mut running: Vec<&Goal> = Vec::new();
    let mut queued = BTreeMap::new();
    let mut failures: BTreeMap<&str, Vec<RouteSelection>> = BTreeMap::new();
    for goal in &goals[..open] {
        let mut busy = false;
        let mut awaiting_review = false;
        let sources: Vec<String> = store::get::<Value>(tx, "goalRepairs", &goal.id)?
            .and_then(|state| serde_json::from_value(state["sources"].clone()).ok())
            .unwrap_or_default();
        for id in &goal.assignment_ids {
            let assignment: Assignment = store::required(tx, "assignment", id)?;
            let rejected = sources.contains(id);
            if live(&assignment.status) {
                busy = true;
            } else if author(&assignment.role)
                && ["completed", "verified"].contains(&assignment.status.as_str())
                && !rejected
            {
                awaiting_review = true;
            }
            // A review's verdict is feedback on the change, not a failure of skill.
            if rejected && assignment.status == "failed" {
                failures.entry(&goal.id).or_default().push(assignment.route);
            }
        }
        if busy {
            running.push(goal);
        }
        let stamp = store::get::<u64>(tx, "boardQueue", &goal.id)?;
        if ready(goal, &goals) && !busy && !awaiting_review {
            let at = stamp.unwrap_or(now);
            if stamp.is_none() {
                store::put(tx, "boardQueue", &goal.id, &at, revision)?;
            }
            queued.insert(goal.id.clone(), at);
        } else if stamp.is_some() {
            store::remove(tx, "boardQueue", &goal.id, revision)?;
        }
    }
    let configuration = config(tx)?;
    let paused =
        !configuration.enabled || configuration.coordinator_paused || pause_state(tx)?.active;
    let mut free = capacity
        .limits
        .in_flight
        .map(|limit| limit.saturating_sub(capacity.in_flight));
    let mut chosen: Vec<&Goal> = Vec::new();
    let mut next = Vec::new();
    let mut waiting = Vec::new();
    for (id, class) in order(&goals, &queued, now) {
        let Some(goal) = goals.iter().find(|goal| goal.id == id) else {
            continue;
        };
        let reason = if paused {
            Some("paused".into())
        } else if let Some(reason) =
            capped(tx, Some(goal), goal.project_id.as_deref(), revision, now)?
        {
            Some(reason)
        } else if let Some(other) = running.iter().chain(&chosen).find(|other| {
            other.project_id == goal.project_id && overlaps(&goal.touches, &other.touches)
        }) {
            Some(format!("touches overlap goal {}", other.id))
        } else if free == Some(0) {
            Some("at the in-flight limit you set".into())
        } else {
            None
        };
        if let Some(reason) = reason {
            waiting.push(json!({"goalId":id,"reason":reason}));
            continue;
        }
        free = free.map(|left| left - 1);
        chosen.push(goal);
        let failed = failures.get(id.as_str()).map_or(&[][..], Vec::as_slice);
        next.push(json!({"goalId":id,"class":class,"queuedAt":queued[&id],"ladder":ladder(failed, &scores)}));
    }
    Ok(json!({"next":next,"waiting":waiting,"capacity":capacity}))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn goal(id: &str, status: &str, dependencies: &[&str]) -> Goal {
        serde_json::from_value(
            json!({"id":id,"purpose":id,"status":status,"dependencies":dependencies}),
        )
        .unwrap()
    }

    fn route(model: &str, effort: &str) -> RouteSelection {
        RouteSelection {
            provider: Some("codex".into()),
            model: Some(model.into()),
            effort: Some(effort.into()),
            destination: Some("local".into()),
            ..RouteSelection::default()
        }
    }

    fn paths(items: &[&str]) -> Vec<String> {
        items.iter().map(|&item| item.into()).collect()
    }

    #[test]
    fn touches_overlap_when_equal_or_one_is_a_folder_of_the_other() {
        assert!(overlaps(&paths(&["src/x.rs"]), &paths(&["src/x.rs"])));
        assert!(overlaps(&paths(&["tests"]), &paths(&["tests/map.json"])));
        assert!(overlaps(&paths(&["src/pkg/mod.rs"]), &paths(&["src/pkg/"])));
        assert!(!overlaps(&paths(&["src/a"]), &paths(&["src/ab"])));
        assert!(!overlaps(
            &paths(&["docs/a.md"]),
            &paths(&["x.rs", "docs/b.md"])
        ));
        assert!(!overlaps(&[], &paths(&["src"])));
    }

    #[test]
    fn a_goal_is_ready_only_when_every_dependency_is_completed() {
        let goals = vec![
            goal("a", "completed", &[]),
            goal("b", "active", &[]),
            goal("c", "blocked", &[]),
            goal("d", "active", &["a", "b", "c"]),
            goal("e", "active", &["a"]),
            goal("f", "blocked", &["a"]),
        ];
        let ready: Vec<&str> = goals
            .iter()
            .filter(|goal| ready(goal, &goals))
            .map(|goal| goal.id.as_str())
            .collect();
        assert_eq!(ready, ["b", "e"]);
    }

    #[test]
    fn promotion_classes_follow_open_transitive_dependents() {
        let goals = vec![
            goal("done", "completed", &[]),
            goal("root", "active", &[]),
            goal("mid", "active", &["root", "other"]),
            goal("other", "active", &[]),
            goal("leaf", "active", &["mid"]),
            goal("solo", "active", &[]),
            goal("gone", "cancelled", &["solo"]),
        ];
        let classes = classes(&goals);
        // mid also waits on the other one.
        assert_eq!((classes["root"], classes["other"]), (P1, P1));
        assert_eq!(classes["mid"], P0);
        // A cancelled dependent needs nothing.
        assert_eq!(classes["solo"], P2);
    }

    fn queue(items: &[(&str, u64)]) -> BTreeMap<String, u64> {
        items.iter().map(|&(id, at)| (id.into(), at)).collect()
    }

    fn ids(order: Vec<(String, u8)>) -> Vec<String> {
        order.into_iter().map(|(id, _)| id).collect()
    }

    #[test]
    fn a_goal_that_unblocks_another_starts_first_then_the_first_queued() {
        let goals = vec![
            goal("a", "active", &[]),
            goal("b", "active", &[]),
            goal("c", "active", &["b"]),
            goal("d", "active", &[]),
        ];
        let order = order(&goals, &queue(&[("a", 10), ("d", 11), ("b", 12)]), 100);
        assert_eq!(ids(order), ["b", "a", "d"]);
    }

    #[test]
    fn aging_raises_a_waiting_goal_one_class_per_six_hours() {
        let goals = vec![
            goal("old", "active", &[]),
            goal("x", "active", &[]),
            goal("z", "active", &[]),
            goal("y", "active", &["x", "z"]),
            goal("new", "active", &[]),
        ];
        let now = AGING_MS + 60_000;
        let queued = queue(&[("old", 0), ("x", now), ("z", now), ("new", now)]);
        let aged = order(&goals, &queued, now);
        assert_eq!(aged[0], ("old".into(), P1));
        assert_eq!(ids(aged), ["old", "x", "z", "new"]);
        let fresh = order(&goals, &queue(&[("old", now - 60), ("x", now)]), now);
        assert_eq!(fresh, [("x".into(), P1), ("old".into(), P2)]);
    }

    #[test]
    fn a_queue_time_in_the_future_never_drops_a_class() {
        let goals = vec![
            goal("solo", "active", &[]),
            goal("root", "active", &[]),
            goal("mid", "active", &["root", "other"]),
            goal("other", "active", &[]),
            goal("leaf", "active", &["mid"]),
        ];
        let now = 2_000_000_000;
        let order = order(
            &goals,
            &queue(&[("solo", now - 60), ("root", now + 1)]),
            now,
        );
        assert_eq!(ids(order), ["root", "solo"]);
    }

    fn scored(model: &str, effort: &str, score: f64) -> Score {
        Score {
            provider: "codex".into(),
            model: model.into(),
            effort: Some(effort.into()),
            score,
            tier: Some(3),
        }
    }

    #[test]
    fn the_ladder_escalates_by_score() {
        let candidates = [
            ("soni", "low", 45.0),
            ("soni", "medium", 50.0),
            ("soni", "xhigh", 52.0),
            ("lyria", "high", 49.0),
            ("weak", "medium", 48.0),
            ("vivi", "medium", 50.0),
            ("vivi", "high", 57.0),
        ];
        let scores: Vec<Score> = candidates
            .iter()
            .map(|&(model, effort, score)| scored(model, effort, score))
            .collect();
        let eligible = |ladder: &Ladder| -> Vec<String> {
            candidates
                .iter()
                .filter(|&&(model, effort, score)| {
                    ladder.allows(&route(model, effort), Some(score), Some(3))
                })
                .map(|(model, effort, _)| format!("{model}/{effort}"))
                .collect()
        };
        assert_eq!(ladder(&[], &scores), Ladder::default());
        let mut failed = vec![route("weak", "medium")];
        // Second try: another model at a similar score (at least 48 - 5).
        let second = ladder(&failed, &scores);
        assert_eq!(second.min_score, Some(43.0));
        assert!(
            !eligible(&second)
                .iter()
                .any(|label| label.starts_with("weak/"))
        );
        assert!(eligible(&second).contains(&"soni/low".into()));
        failed.push(route("soni", "medium"));
        // Third: at least the best failed score (50), never a failed pair; a model may climb an effort.
        let third = eligible(&ladder(&failed, &scores));
        assert_eq!(third, ["soni/xhigh", "vivi/medium", "vivi/high"]);
        failed.push(route("soni", "xhigh"));
        assert_eq!(eligible(&ladder(&failed, &scores)), ["vivi/high"]);
    }

    #[test]
    fn two_failures_of_one_route_raise_score_and_tier_to_it() {
        let mut writer = route("writer", "medium");
        writer.profile_id = Some("writer-profile".into());
        let failed = [writer.clone(), writer.clone()];
        let ladder = ladder(&failed, &[scored("writer", "medium", 70.0)]);
        assert_eq!(
            ladder,
            Ladder {
                exclude: vec![RouteKey {
                    provider: "codex".into(),
                    model: "writer".into(),
                    effort: Some("medium".into())
                }],
                exclude_profiles: vec![ProfileKey {
                    profile_id: "writer-profile".into(),
                    effort: Some("medium".into())
                }],
                min_score: Some(70.0),
                min_tier: Some(3),
            }
        );
        assert!(!ladder.allows(&route("strong", "high"), Some(80.0), Some(2)));
        assert!(ladder.allows(&route("strong", "high"), Some(80.0), Some(3)));
        // The same capability profile under another model name is the route that failed.
        let renamed = RouteSelection {
            model: Some("writer-2".into()),
            ..writer
        };
        assert!(!ladder.allows(&renamed, Some(80.0), Some(3)));
        // Without scores for the failed routes there is no floor, only the exclusion.
        assert_eq!(super::ladder(&failed, &[]).min_score, None);
    }

    #[test]
    fn the_ladder_never_allows_a_route_that_failed() {
        let routes = [
            route("a", "low"),
            route("a", "high"),
            route("b", "medium"),
            route("c", "high"),
        ];
        for length in 1..=routes.len() {
            for start in 0..routes.len() {
                let failed: Vec<RouteSelection> = (0..length)
                    .map(|n| routes[(start + n) % routes.len()].clone())
                    .collect();
                let ladder = ladder(&failed, &[]);
                for route in &failed {
                    assert!(!ladder.allows(route, Some(f64::MAX), Some(u32::MAX)));
                }
            }
        }
    }

    #[test]
    fn no_limit_holds_unless_the_owner_set_one_and_none_holds_a_reviewer() {
        let mut capacity = Capacity::default();
        let local = route("m", "high");
        for _ in 0..50 {
            capacity.add(&local);
        }
        assert_eq!(capacity.admits(&local, false), None);
        capacity.limits = Limits {
            in_flight: Some(60),
            per_login: Some(50),
            local_slots: None,
        };
        assert_eq!(
            capacity.admits(&local, false),
            Some("login at the limit you set")
        );
        assert_eq!(capacity.admits(&local, true), None);
        let mut other = local.clone();
        other.account = Some("second".into());
        assert_eq!(capacity.admits(&other, false), None);
        capacity.limits.in_flight = Some(50);
        assert_eq!(
            capacity.admits(&other, false),
            Some("at the in-flight limit you set")
        );
        assert_eq!(capacity.admits(&other, true), None);
    }
}
