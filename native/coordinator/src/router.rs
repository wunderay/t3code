//! Ported from the Guild's router.py, without its roles. Cost has two dimensions (the owner): what a
//! goal uses to reach merged and done, and how long that takes. Neither is converted into the other.
use crate::{Error, Result, decode, identifier, model::*, store, user};
use rusqlite::{Transaction, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;

// No constant here caps work: candidates and bench entries are as many as the owner's providers
// offer (a request is bounded only by the store's 1 MiB input). These weigh routes, and each says
// why it has its value.

// The Guild's task classes and the efforts providers offer: names, not limits.
const RANKS: &str = "FEDCBAS";
const RANK_SCORES: [(char, f64); 6] = [
    ('S', 60.0),
    ('A', 54.0),
    ('B', 48.0),
    ('C', 40.0),
    ('D', 30.0),
    ('E', 0.0),
];
const EFFORTS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];
// A route's skill follows its model as providers update it: its newest results per rank count,
// enough that one bad run does not decide it.
const RECENT: u32 = 20;
// A pass rate from a handful of runs is uncertain by about this much; within it the faster route wins.
const NEAR_TIE: f64 = 0.10;
// Tasks one class apart differ in difficulty, so their results count half.
const NEAR_WEIGHT: f64 = 0.5;
// Four pseudo-runs: one lucky pass moves a 0.5 prior to 0.6, and twenty results outweigh it five to one.
const PRIOR_RUNS: f64 = 4.0;
// A bench score maps to a prior pass rate: even at a class's bar, near-certain only well above it
// (span in bench points); outcomes replace the prior as they come.
const PRIOR_AT_BAR: f64 = 0.5;
const PRIOR_MAX: f64 = 0.9;
const PRIOR_SPAN: f64 = 15.0;
// Keeps a route that never passed finite in cost per pass, and last; it is never a cap.
const MIN_PASS_RATE: f64 = 0.05;
// Reviews cost 0.41 of the author's run in the Guild's audit; an outcome's spend includes them.
const REVIEW_SHARE: f64 = 0.4;
// Priors for a model with no bench entry, so one added later is routable at once (the plan); its
// own outcomes outweigh them after PRIOR_RUNS runs.
const DEFAULT_SUCCESS: f64 = 0.6;
const DEFAULT_COST_MICROS: f64 = 1_000_000.0;
const DEFAULT_SECONDS: f64 = 1800.0;
const DEFAULT_RANK: char = 'B';
const DEFAULT_TIER: u8 = 1;
// Allowance delegated work leaves for the owner's own threads, which are never refused; in the last
// day of a weekly window what is left would expire unused, so it is spent.
const RESERVE_PCT: f64 = 15.0;
const WEEKLY_FLOOR_OFF_HOURS: f64 = 24.0;
// Drain is measured over the readings of the last hours: recent enough to follow the pace now,
// long enough to span several readings.
const BURN_WINDOW_HOURS: f64 = 6.0;
const HOUR_MS: f64 = 3_600_000.0;
// The providers' usage windows: weekly, and the five-hour session window.
const LONG_PERIOD_HOURS: f64 = 168.0;
const SHORT_PERIOD_HOURS: f64 = 5.0;
// The pacing curve in allowance points: readings start at 99 after a reset (they round down),
// scarcity grows over SPAN points behind pace and falls over AHEAD points ahead, TOLERANCE and
// NEW_WORK absorb a reading's rounding and one task's draw, and the last hour before a reset spends
// freely. These weigh logins; none holds work, which only the provider's own limit does.
const PACE_START: f64 = 99.0;
const PACE_SPAN: f64 = 20.0;
const PACE_MIN_SCARCITY: f64 = 0.25;
const PACE_AHEAD: f64 = 10.0;
const PACE_TOLERANCE: f64 = 2.0;
const PACE_NEW_WORK: f64 = 1.0;
const PACE_BURN_HOURS: f64 = 1.0;
const WEIGHTS: &str = "routerWeights";

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Dimensions {
    /// Micro-dollars per merged goal, times how scarce the plan's allowance is.
    r#use: f64,
    /// Seconds per merged goal.
    time: f64,
}

impl Default for Dimensions {
    fn default() -> Self {
        Self {
            r#use: 1.0,
            time: 1.0,
        }
    }
}

impl Dimensions {
    fn zip(self, other: Self, f: impl Fn(f64, f64) -> f64) -> Self {
        Self {
            r#use: f(self.r#use, other.r#use),
            time: f(self.time, other.time),
        }
    }
    fn values(self) -> [f64; 2] {
        [self.r#use, self.time]
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Candidate {
    profile_id: String,
    instance: String,
    /// The login limit counts running work by provider, which an instance need not be named after.
    provider: String,
    model: String,
    family: String,
    effort: String,
    destination: String,
    /// The login; its allowance, hold and work in flight are its own.
    #[serde(default)]
    account: Option<String>,
    /// A limit the owner set per login; none unless set.
    #[serde(default)]
    login_max_parallel: Option<u32>,
    /// The owner's own threads running on this login, which the store does not see.
    #[serde(default)]
    owner_running: u32,
    #[serde(default)]
    skills: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Route {
    model: String,
    effort: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Author {
    model: String,
    effort: String,
    family: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    rank: String,
    candidates: Vec<Candidate>,
    #[serde(default)]
    skills: Vec<String>,
    #[serde(default)]
    max_effort: Option<String>,
    #[serde(default)]
    exclude_model: Option<String>,
    #[serde(default)]
    exclude_family: Option<String>,
    #[serde(default)]
    min_tier: u8,
    #[serde(default)]
    min_score: Option<f64>,
    /// Profiles that already worked on this task, at any effort.
    #[serde(default)]
    tried: Vec<String>,
    #[serde(default)]
    failed: Vec<Route>,
    #[serde(default)]
    /// Every author of the work under review: the reviewer may share none of their models.
    review_of: Vec<Author>,
    /// How many local threads this machine can run now, as the host measured it; none is no bound.
    #[serde(default)]
    local_slots: Option<u32>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Score {
    profile_id: String,
    instance: String,
    model: String,
    family: String,
    effort: String,
    destination: String,
    bench: Option<f64>,
    rank: char,
    tier: u8,
    prior: f64,
    observed_passes: f64,
    observed_runs: f64,
    pass_rate: f64,
    seconds_per_run: f64,
    scarcity: f64,
    cost: Dimensions,
    ratio: Dimensions,
    combined: f64,
    reason: Option<String>,
}

impl Score {
    fn eligible(&self) -> bool {
        self.reason.is_none()
    }
}

fn rank_index(rank: &str) -> Result<usize> {
    let mut chars = rank.chars();
    match (chars.next(), chars.next()) {
        (Some(c), None) => RANKS
            .find(c)
            .ok_or_else(|| Error::invalid(format!("Unknown rank: {rank}"))),
        _ => Err(Error::invalid(format!("Unknown rank: {rank}"))),
    }
}

fn bar(rank: char) -> f64 {
    RANK_SCORES
        .iter()
        .find(|(r, _)| *r == rank)
        .map_or(0.0, |(_, s)| *s)
}

fn score_rank(score: f64) -> char {
    RANK_SCORES
        .iter()
        .find(|(_, bar)| score >= *bar)
        .map_or('F', |(r, _)| *r)
}

fn score_tier(score: f64) -> u8 {
    if score >= 57.0 {
        3
    } else if score >= 48.0 {
        2
    } else {
        1
    }
}

fn bench_prior(score: f64, rank: char) -> f64 {
    let margin = (score - bar(rank)).clamp(0.0, PRIOR_SPAN);
    PRIOR_AT_BAR + (PRIOR_MAX - PRIOR_AT_BAR) * margin / PRIOR_SPAN
}

fn bench_of(tx: &Transaction<'_>, model: &str, effort: &str) -> Result<Option<Bench>> {
    store::get(tx, "bench", &format!("{model}/{effort}"))
}

/// What one attempt on a route is expected to use: its bench cost, or the default prior.
pub(crate) fn estimate(tx: &Transaction<'_>, route: &RouteSelection) -> Result<u64> {
    let (Some(model), effort) = (&route.model, route.effort.as_deref().unwrap_or("default")) else {
        return Ok(DEFAULT_COST_MICROS as u64);
    };
    Ok(bench_of(tx, model, effort)?.map_or(DEFAULT_COST_MICROS as u64, |bench| bench.cost_micros))
}

fn effort_index(effort: &str) -> Option<usize> {
    EFFORTS.iter().position(|e| *e == effort)
}

#[derive(Default)]
struct Observed {
    passes: f64,
    runs: f64,
    spend: f64,
    seconds: f64,
}

/// The newest counted results per rank at the task's rank and next to it, weighted by distance.
/// A result whose use was not reported costs `prior`, the bench's estimate, never nothing.
fn observed(
    tx: &Transaction<'_>,
    model: &str,
    effort: &str,
    need: usize,
    prior: f64,
) -> Result<Observed> {
    let near = |step: isize| {
        RANKS
            .chars()
            .nth(need.saturating_add_signed(step).min(RANKS.len() - 1))
            .map(String::from)
    };
    let mut statement = tx
        .prepare(
            "SELECT body FROM (SELECT body, ROW_NUMBER() OVER (PARTITION BY json_extract(body,'$.rank') ORDER BY json_extract(body,'$.endedAt') DESC, id DESC) AS n
             FROM documents WHERE kind='outcome' AND json_extract(body,'$.model')=?1 AND json_extract(body,'$.effort')=?2
             AND json_extract(body,'$.rank') IN (?3,?4,?5) AND json_extract(body,'$.counted')) WHERE n<=?6",
        )
        .map_err(Error::internal)?;
    let rows = statement
        .query_map(
            params![model, effort, near(-1), near(0), near(1), RECENT],
            |row| row.get::<_, String>(0),
        )
        .map_err(Error::internal)?;
    let mut seen = Observed::default();
    for row in rows {
        let outcome: Outcome =
            serde_json::from_str(&row.map_err(Error::internal)?).map_err(Error::internal)?;
        let weight = if rank_index(&outcome.rank)? == need {
            1.0
        } else {
            NEAR_WEIGHT
        };
        if outcome.finish.is_none() {
            continue;
        }
        if outcome.finish == Some(Finish::Merged) {
            seen.passes += weight;
        }
        let factor = revert_factor(outcome.finish);
        let seconds = worked_seconds(&outcome);
        seen.runs += weight;
        seen.spend += weight * counted_use(&outcome, prior);
        seen.seconds += weight * factor * seconds as f64;
    }
    Ok(seen)
}

/// A revert spent the whole cost to get back to the start: it counts double, and as no pass.
pub(crate) fn revert_factor(finish: Option<Finish>) -> f64 {
    if finish == Some(Finish::Reverted) {
        2.0
    } else {
        1.0
    }
}

/// What a run that reported no use is taken to have used: its route's bench cost, or the default,
/// with the review its change will need. Routing and the board price it with this one function.
pub(crate) fn unreported_use(bench: Option<&Bench>) -> f64 {
    bench.map_or(DEFAULT_COST_MICROS, |bench| bench.cost_micros as f64) * (1.0 + REVIEW_SHARE)
}

/// An outcome's use as routing counts it: what it reported, or `prior` (the bench's estimate)
/// when it reported none, doubled by a revert.
pub(crate) fn counted_use(outcome: &Outcome, prior: f64) -> f64 {
    revert_factor(outcome.finish) * outcome.used_micros.map_or(prior, |used| used as f64)
}

/// An outcome's time: from its first round's start to its last round's end, less the time it
/// waited on the owner or on a provider outage.
pub(crate) fn worked_seconds(outcome: &Outcome) -> u64 {
    ((outcome.ended_at - outcome.started_at) / 1000).saturating_sub(outcome.blocked_seconds)
}

struct Limit {
    scarcity: f64,
    reason: Option<String>,
    pacing: bool,
}

impl Limit {
    fn free(scarcity: f64) -> Self {
        Self {
            scarcity,
            reason: None,
            pacing: false,
        }
    }
}

fn hours_until(at: u64, now: u64) -> f64 {
    (at as f64 - now as f64) / HOUR_MS
}

/// The reserve, except for a weekly window near its reset: what is left then is spent, not kept.
fn floor_for(long: bool, resets_at: Option<u64>, now: u64) -> f64 {
    if long && resets_at.is_some_and(|at| hours_until(at, now) <= WEEKLY_FLOOR_OFF_HOURS) {
        0.0
    } else {
        RESERVE_PCT
    }
}

/// Measured drain in points per hour; only readings of the current period count, so a reset is not a drain.
fn burn_per_hour(
    tx: &Transaction<'_>,
    plan: &str,
    long: bool,
    resets_at: Option<u64>,
    now: u64,
) -> Result<f64> {
    let since = now.saturating_sub((BURN_WINDOW_HOURS * HOUR_MS) as u64);
    let mut statement = tx
        .prepare(
            "SELECT body FROM documents WHERE kind='allowanceReading' AND json_extract(body,'$.account')=?1
             AND json_extract(body,'$.long')=?2 AND json_extract(body,'$.recordedAt')>?3 ORDER BY json_extract(body,'$.recordedAt')",
        )
        .map_err(Error::internal)?;
    let rows = statement
        .query_map(params![plan, long, since], |row| row.get::<_, String>(0))
        .map_err(Error::internal)?;
    let mut readings = Vec::new();
    for row in rows {
        let reading: AllowanceReading =
            serde_json::from_str(&row.map_err(Error::internal)?).map_err(Error::internal)?;
        let same_period = match (reading.resets_at, resets_at) {
            (None, None) => true,
            (Some(a), Some(b)) => a.abs_diff(b) < 120_000,
            _ => false,
        };
        if same_period {
            readings.push(reading);
        }
    }
    let (Some(first), Some(last)) = (readings.first(), readings.last()) else {
        return Ok(0.0);
    };
    let hours = (last.recorded_at - first.recorded_at) as f64 / HOUR_MS;
    if readings.len() < 2 || hours < 0.25 {
        return Ok(0.0);
    }
    Ok((first.remaining - last.remaining).max(0.0) / hours)
}

/// Steady pacing: the paced window should drain evenly from PACE_START after its reset to empty at the next.
fn steady(long: bool, remaining: f64, resets_at: u64, now: u64) -> Limit {
    let left = hours_until(resets_at, now);
    // An only window resetting more than 5 hours out is a weekly one: pace it over 7 days, not the time left.
    let period = if long || left > SHORT_PERIOD_HOURS {
        LONG_PERIOD_HOURS
    } else {
        SHORT_PERIOD_HOURS
    }
    .max(left.ceil());
    let target = (PACE_START * left.max(0.0) / period).clamp(0.0, PACE_START);
    let spare = remaining - target;
    if remaining - PACE_NEW_WORK < target - PACE_TOLERANCE {
        let label = if long { "weekly window" } else { "window" };
        return Limit {
            scarcity: 1.0 + (-spare).max(0.0) / PACE_AHEAD,
            reason: Some(format!(
                "pacing hold: {label} {remaining:.0}% left, target {target:.0}%, ahead {:.0}%",
                -spare
            )),
            pacing: true,
        };
    }
    Limit::free(if spare >= 0.0 {
        (1.0 - spare / PACE_SPAN).max(PACE_MIN_SCARCITY)
    } else {
        1.0 - spare / PACE_AHEAD
    })
}

/// 0 at a window's floor; 1 when the plan resets before running out at the measured pace; higher as
/// that pace heads into the floor first. Two windows gate together and the weekly one paces.
fn scarcity(tx: &Transaction<'_>, plan: Option<&str>, now: u64) -> Result<Limit> {
    let Some(plan) = plan else {
        return Ok(Limit::free(1.0));
    };
    if let Some(hold) = store::get::<AccountHold>(tx, "accountHold", plan)?
        && hold.until.is_none_or(|until| until > now)
    {
        return Ok(Limit {
            scarcity: 0.0,
            reason: Some(match hold.until {
                Some(until) => format!("{plan} held until {until}: {}", hold.reason),
                None => format!(
                    "{plan} held until a fresh allowance reading: {}",
                    hold.reason
                ),
            }),
            pacing: false,
        });
    }
    let Some(allowance) = store::get::<Allowance>(tx, "allowance", plan)? else {
        return Ok(Limit::free(1.0));
    };
    let mut windows = vec![(false, allowance.remaining, allowance.resets_at)];
    if let Some(long) = allowance.long_remaining {
        windows.push((true, long, allowance.long_resets_at));
    }
    for &(long, remaining, resets_at) in &windows {
        let floor = floor_for(long, resets_at, now);
        if remaining <= floor {
            let label = match (long, windows.len()) {
                (true, _) => "weekly window",
                (false, 2) => "5-hour window",
                _ => "window",
            };
            return Ok(Limit {
                scarcity: 0.0,
                reason: Some(format!(
                    "{plan} {label} at {remaining:.0}% (floor {floor:.0}%)"
                )),
                pacing: false,
            });
        }
    }
    let (long, remaining, resets_at) = windows[windows.len() - 1];
    let Some(resets_at) = resets_at else {
        return Ok(Limit::free(1.0));
    };
    if allowance.steady {
        if hours_until(resets_at, now) <= PACE_BURN_HOURS {
            return Ok(Limit::free(PACE_MIN_SCARCITY));
        }
        return Ok(steady(long, remaining, resets_at, now));
    }
    let spare = remaining - floor_for(long, Some(resets_at), now);
    let projected =
        burn_per_hour(tx, plan, long, Some(resets_at), now)? * hours_until(resets_at, now).max(0.0);
    Ok(Limit::free(
        1.0 + (projected - spare).max(0.0) / spare.max(1.0),
    ))
}

#[derive(Default)]
struct InFlight {
    logins: HashMap<(String, String), u32>,
    local: u32,
}

/// Work running on a candidate's login: the store's assignments and the owner's own threads.
fn login_busy(busy: &InFlight, candidate: &Candidate) -> u32 {
    candidate.owner_running
        + candidate.account.as_ref().map_or(0, |account| {
            busy.logins
                .get(&(candidate.provider.clone(), account.clone()))
                .copied()
                .unwrap_or(0)
        })
}

/// Logins of one provider are separate candidates for one model, whose outcomes are pooled. Work
/// spreads among them: each costs more the more of its allowance is spent and the more it runs.
fn load(tx: &Transaction<'_>, busy: &InFlight, candidate: &Candidate) -> Result<f64> {
    let remaining = match &candidate.account {
        Some(account) => store::get::<Allowance>(tx, "allowance", account)?.map_or(100.0, |a| {
            a.long_remaining
                .map_or(a.remaining, |long| long.min(a.remaining))
        }),
        None => 100.0,
    };
    Ok(f64::from(1 + login_busy(busy, candidate)) * 100.0 / remaining.max(1.0))
}

fn in_flight(tx: &Transaction<'_>, now: u64) -> Result<InFlight> {
    let mut statement = tx
        .prepare(&format!(
            "SELECT json_extract(body,'$.route.provider'),json_extract(body,'$.route.account'),json_extract(body,'$.route.destination')
             FROM documents WHERE kind='assignment' AND ({})",
            crate::board::holding(tx, now)?
        ))
        .map_err(Error::internal)?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, Option<String>>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })
        .map_err(Error::internal)?;
    let mut busy = InFlight::default();
    for row in rows {
        let (provider, account, destination) = row.map_err(Error::internal)?;
        if let (Some(provider), Some(account)) = (provider, account) {
            *busy.logins.entry((provider, account)).or_default() += 1;
        }
        if destination.as_deref() == Some("local") {
            busy.local += 1;
        }
    }
    Ok(busy)
}

fn validate(request: &Request) -> Result<usize> {
    let need = rank_index(&request.rank)?;
    for candidate in &request.candidates {
        for id in [
            &candidate.profile_id,
            &candidate.instance,
            &candidate.provider,
            &candidate.model,
            &candidate.family,
            &candidate.effort,
            &candidate.destination,
        ] {
            identifier(id)?;
        }
    }
    Ok(need)
}

/// The first reason, in the Guild's order, that a candidate may not take the task; None if it may.
fn reason(
    request: &Request,
    candidate: &Candidate,
    score: &Score,
    limit: Limit,
    (need, min_tier): (usize, u8),
    busy: &InFlight,
) -> Option<String> {
    let reviewer = !request.review_of.is_empty();
    let cap = request.max_effort.as_deref().and_then(effort_index);
    let over_cap = |effort: &str| cap.zip(effort_index(effort)).is_some_and(|(c, e)| e > c);
    let missing: Vec<&String> = request
        .skills
        .iter()
        .filter(|skill| !candidate.skills.contains(skill))
        .collect();
    if RANKS.find(score.rank).unwrap_or(0) < need {
        return Some(match score.bench {
            Some(bench) => format!("score {bench} qualifies {}", score.rank),
            None => format!("max rank {}", score.rank),
        });
    }
    if over_cap(&candidate.effort)
        && request
            .candidates
            .iter()
            .any(|other| other.profile_id == candidate.profile_id && !over_cap(&other.effort))
    {
        return Some(format!(
            "effort {} is above the cap {}",
            candidate.effort,
            request.max_effort.as_deref().unwrap_or_default()
        ));
    }
    if !missing.is_empty() {
        return Some(format!("missing skills {missing:?}"));
    }
    if request.exclude_family.as_deref() == Some(candidate.family.as_str()) {
        return Some("excluded model family".into());
    }
    if request
        .review_of
        .iter()
        .any(|author| author.model == candidate.model)
    {
        return Some("same model as the author".into());
    }
    if request.exclude_model.as_deref() == Some(candidate.model.as_str()) {
        return Some("excluded model".into());
    }
    if let (Some(floor), Some(bench)) = (request.min_score, score.bench)
        && bench < floor
    {
        return Some(format!("score {bench}, needs {floor}"));
    }
    if score.tier < min_tier {
        return Some(format!("tier {}, needs {min_tier}", score.tier));
    }
    if request.tried.contains(&candidate.profile_id) {
        return Some("already tried this task".into());
    }
    if request
        .failed
        .iter()
        .any(|route| route.model == candidate.model && route.effort == candidate.effort)
    {
        return Some(format!("already failed this task at {}", candidate.effort));
    }
    // Pacing paces work; a review is short and is what lets finished work land.
    if let Some(reason) = limit.reason
        && !(reviewer && limit.pacing)
    {
        return Some(reason);
    }
    // The owner's limit bounds authors; a review is what lets finished work land.
    if let (Some(account), Some(max)) = (&candidate.account, candidate.login_max_parallel)
        && !reviewer
        && login_busy(busy, candidate) >= max
    {
        return Some(format!("login {account} at the limit you set"));
    }
    if candidate.destination == "local"
        && request.local_slots.is_some_and(|slots| busy.local >= slots)
    {
        return Some("this machine has no room for another local thread".into());
    }
    None
}

/// Every candidate scored, eligible first in the order to take them, and the pick: the fastest of
/// those within NEAR_TIE of the best. A reviewer never shares the author's model, is of its tier or
/// above, and comes from another family when one is eligible.
pub(crate) fn score(tx: &Transaction<'_>, parameters: &Value, now: u64) -> Result<Value> {
    let request: Request = decode(parameters, "request")?;
    let need = validate(&request)?;
    let rank = RANKS.chars().nth(need).unwrap_or(DEFAULT_RANK);
    let mut author_tier = 0;
    for author in &request.review_of {
        author_tier = author_tier.max(
            bench_of(tx, &author.model, &author.effort)?
                .map_or(DEFAULT_TIER, |bench| score_tier(bench.score)),
        );
    }
    let min_tier = request.min_tier.max(author_tier);
    let busy = in_flight(tx, now)?;
    let mut scores = Vec::with_capacity(request.candidates.len());
    for candidate in &request.candidates {
        let bench = bench_of(tx, &candidate.model, &candidate.effort)?;
        let prior = bench
            .as_ref()
            .map_or(DEFAULT_SUCCESS, |bench| bench_prior(bench.score, rank));
        let base = unreported_use(bench.as_ref());
        let seen = observed(tx, &candidate.model, &candidate.effort, need, base)?;
        let pass_rate =
            ((PRIOR_RUNS * prior + seen.passes) / (PRIOR_RUNS + seen.runs)).max(MIN_PASS_RATE);
        let run_cost = (PRIOR_RUNS * base + seen.spend) / (PRIOR_RUNS + seen.runs);
        let seconds_per_run =
            (PRIOR_RUNS * DEFAULT_SECONDS + seen.seconds) / (PRIOR_RUNS + seen.runs);
        let limit = scarcity(tx, candidate.account.as_deref(), now)?;
        let load = load(tx, &busy, candidate)?;
        let mut score = Score {
            profile_id: candidate.profile_id.clone(),
            instance: candidate.instance.clone(),
            model: candidate.model.clone(),
            family: candidate.family.clone(),
            effort: candidate.effort.clone(),
            destination: candidate.destination.clone(),
            bench: bench.as_ref().map(|bench| bench.score),
            rank: bench
                .as_ref()
                .map_or(DEFAULT_RANK, |bench| score_rank(bench.score)),
            tier: bench
                .as_ref()
                .map_or(DEFAULT_TIER, |bench| score_tier(bench.score)),
            prior,
            observed_passes: seen.passes,
            observed_runs: seen.runs,
            pass_rate,
            seconds_per_run,
            scarcity: limit.scarcity,
            cost: Dimensions {
                r#use: run_cost / pass_rate * limit.scarcity.max(PACE_MIN_SCARCITY) * load,
                time: seconds_per_run / pass_rate,
            },
            ratio: Dimensions::default(),
            combined: 0.0,
            reason: None,
        };
        score.reason = reason(&request, candidate, &score, limit, (need, min_tier), &busy);
        scores.push(score);
    }
    let eligible = scores.iter().any(Score::eligible);
    let best = scores
        .iter()
        .filter(|score| score.eligible() || !eligible)
        .fold(
            Dimensions {
                r#use: f64::INFINITY,
                time: f64::INFINITY,
            },
            |best, score| best.zip(score.cost, f64::min),
        );
    let weights: Dimensions = store::get(tx, "system", WEIGHTS)?.unwrap_or_default();
    let total: f64 = weights.values().iter().sum();
    for score in &mut scores {
        score.ratio = score.cost.zip(best, |value, best| value / best);
        score.combined = score
            .ratio
            .zip(weights, |ratio, weight| ratio * weight)
            .values()
            .iter()
            .sum::<f64>()
            / total;
    }
    let same_family = |score: &Score| {
        request
            .review_of
            .iter()
            .any(|author| author.family == score.family)
    };
    scores.sort_by(|a, b| {
        (!a.eligible(), same_family(a))
            .cmp(&(!b.eligible(), same_family(b)))
            .then(a.combined.total_cmp(&b.combined))
            .then(a.seconds_per_run.total_cmp(&b.seconds_per_run))
    });
    // Never trade another family for speed.
    let pick = scores
        .first()
        .filter(|best| best.eligible())
        .and_then(|best| {
            scores
                .iter()
                .filter(|score| {
                    score.eligible()
                        && same_family(score) == same_family(best)
                        && score.combined <= best.combined * (1.0 + NEAR_TIE)
                })
                .min_by(|a, b| a.seconds_per_run.total_cmp(&b.seconds_per_run))
        });
    Ok(json!({"pick":pick,"scores":scores}))
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Round {
    assignment_id: String,
    goal_id: String,
    /// The route that wrote the work, whichever model reviewed or repaired it.
    instance: String,
    model: String,
    effort: String,
    rank: String,
    /// None when the destination reported no use, as cloud runs do.
    #[serde(default)]
    used_micros: Option<u64>,
    started_at: u64,
    ended_at: u64,
    #[serde(default)]
    blocked_seconds: u64,
    #[serde(default)]
    finish: Option<Finish>,
    #[serde(default = "yes")]
    counted: bool,
}

fn yes() -> bool {
    true
}

fn outcome_id(round: &Round) -> String {
    format!(
        "{}:{}:{}:{}",
        round.goal_id, round.instance, round.model, round.effort
    )
}

fn first_outcome(round: &Round) -> Outcome {
    Outcome {
        goal_id: round.goal_id.clone(),
        instance: round.instance.clone(),
        model: round.model.clone(),
        effort: round.effort.clone(),
        rank: round.rank.clone(),
        rounds: Vec::new(),
        used_micros: Some(0),
        started_at: round.started_at,
        ended_at: round.started_at,
        blocked_seconds: 0,
        finish: None,
        counted: true,
    }
}

/// Sums one round into its outcome; false when the round was already in it.
fn add_round(outcome: &mut Outcome, round: Round) -> bool {
    if outcome.rounds.contains(&round.assignment_id) {
        return false;
    }
    outcome.rounds.push(round.assignment_id);
    // One round of unknown use makes the outcome's use unknown: a partial sum would undercount it.
    outcome.used_micros = outcome
        .used_micros
        .zip(round.used_micros)
        .map(|(a, b)| a + b);
    // Time runs from assignment to merge, rework after a failure included; a revert after the
    // merge is the doubling, not more time.
    if !matches!(outcome.finish, Some(Finish::Merged | Finish::Reverted)) {
        outcome.started_at = outcome.started_at.min(round.started_at);
        outcome.ended_at = outcome.ended_at.max(round.ended_at);
        outcome.blocked_seconds += round.blocked_seconds;
    }
    // A revert is final: a merged round recorded late does not undo it.
    if outcome.finish != Some(Finish::Reverted) {
        outcome.finish = round.finish.or(outcome.finish);
    }
    outcome.counted &= round.counted;
    true
}

/// The goals whose cost the owner sees: those still open, and any whose merge was reverted, so a
/// revert's doubled cost shows after the goal itself is done.
pub(crate) const COSTED_GOALS: &str = "json_extract(body,'$.status') IN ('active','blocked','merging') OR id IN (SELECT json_extract(body,'$.goalId') FROM documents WHERE kind='outcome' AND json_extract(body,'$.finish')='reverted')";

/// Each costed goal's time as routing counts it: its outcomes with the rounds still running added
/// as if they ended now, each less its blocked time and doubled by a revert. Also the reverts.
pub(crate) fn goal_times(tx: &Transaction<'_>, running: &Value) -> Result<Vec<Value>> {
    let running: Vec<Round> = match running {
        Value::Null => Vec::new(),
        value => serde_json::from_value(value.clone())
            .map_err(|error| Error::invalid(error.to_string()))?,
    };
    let open = format!("({COSTED_GOALS})");
    let goals: Vec<Goal> = store::list(tx, "goal", &open, "", i64::MAX as usize)?;
    let mut outcomes: HashMap<String, HashMap<String, Outcome>> = HashMap::new();
    for outcome in store::list::<Outcome>(
        tx,
        "outcome",
        &format!(
            "json_extract(body,'$.goalId') IN (SELECT id FROM documents WHERE kind='goal' AND {open})"
        ),
        "",
        i64::MAX as usize,
    )? {
        let id = format!(
            "{}:{}:{}:{}",
            outcome.goal_id, outcome.instance, outcome.model, outcome.effort
        );
        outcomes
            .entry(outcome.goal_id.clone())
            .or_default()
            .insert(id, outcome);
    }
    for mut round in running {
        // A running round's use so far is what it has reported, as the budget counts it.
        if round.used_micros.is_none() {
            round.used_micros = tx
                .query_row(
                    "SELECT SUM(json_extract(body,'$.micros')) FROM documents WHERE kind='spend' AND json_extract(body,'$.assignmentId')=?1",
                    [&round.assignment_id],
                    |row| row.get::<_, Option<u64>>(0),
                )
                .map_err(Error::internal)?;
        }
        let entry = outcomes
            .entry(round.goal_id.clone())
            .or_default()
            .entry(outcome_id(&round))
            .or_insert_with(|| first_outcome(&round));
        add_round(entry, round);
    }
    let mut times = Vec::with_capacity(goals.len());
    for goal in goals {
        let outcomes = outcomes.remove(&goal.id).unwrap_or_default();
        let seconds: f64 = outcomes
            .values()
            .map(|outcome| worked_seconds(outcome) as f64 * revert_factor(outcome.finish))
            .sum();
        let mut used = 0.0;
        for outcome in outcomes.values() {
            let prior = unreported_use(bench_of(tx, &outcome.model, &outcome.effort)?.as_ref());
            used += counted_use(outcome, prior);
        }
        let reverts = outcomes
            .values()
            .filter(|outcome| outcome.finish == Some(Finish::Reverted))
            .count();
        let known = !outcomes.is_empty();
        times.push(json!({"goalId": goal.id, "seconds": known.then_some(seconds), "useMicros": known.then_some(used.round()), "reverts": reverts}));
    }
    Ok(times)
}

/// Adds one assignment of a goal, author, review or repair, to the goal's outcome on its route.
pub(crate) fn record_outcome(
    tx: &Transaction<'_>,
    parameters: &Value,
    revision: u64,
) -> Result<Value> {
    let round: Round = decode(parameters, "round")?;
    for id in [
        &round.assignment_id,
        &round.goal_id,
        &round.instance,
        &round.model,
        &round.effort,
    ] {
        identifier(id)?;
    }
    rank_index(&round.rank)?;
    if round.ended_at < round.started_at {
        return Err(Error::invalid("A round ends after it starts"));
    }
    let id = outcome_id(&round);
    let mut outcome = store::get(tx, "outcome", &id)?.unwrap_or_else(|| first_outcome(&round));
    if !add_round(&mut outcome, round) {
        return Ok(json!({ "outcome": outcome }));
    }
    store::put(tx, "outcome", &id, &outcome, revision)?;
    Ok(json!({ "outcome": outcome }))
}

pub(crate) fn weights(tx: &Transaction<'_>) -> Result<Value> {
    let weights: Dimensions = store::get(tx, "system", WEIGHTS)?.unwrap_or_default();
    Ok(json!(weights))
}

/// Only the owner weighs use against time.
pub(crate) fn set_weights(
    tx: &Transaction<'_>,
    parameters: &Value,
    revision: u64,
) -> Result<Value> {
    user(parameters)?;
    let weights: Dimensions = decode(parameters, "weights")?;
    let values = weights.values();
    if values.iter().any(|w| !w.is_finite() || *w < 0.0) || values.iter().sum::<f64>() <= 0.0 {
        return Err(Error::invalid(
            "Weights must be finite, nonnegative and not all zero",
        ));
    }
    store::put(tx, "system", WEIGHTS, &weights, revision)?;
    Ok(json!({ "weights": weights }))
}

pub(crate) fn record_allowance(
    tx: &Transaction<'_>,
    parameters: &Value,
    revision: u64,
    now: u64,
) -> Result<Value> {
    let allowance: Allowance = decode(parameters, "allowance")?;
    identifier(&allowance.id)?;
    let mut windows = vec![(false, allowance.remaining, allowance.resets_at)];
    if let Some(long) = allowance.long_remaining {
        windows.push((true, long, allowance.long_resets_at));
    }
    if windows
        .iter()
        .any(|(_, remaining, _)| !(0.0..=100.0).contains(remaining))
    {
        return Err(Error::invalid(
            "Allowance must be between 0 and 100 percent",
        ));
    }
    store::put(tx, "allowance", &allowance.id, &allowance, revision)?;
    // A hold with no reset time ends on a reading taken after it that shows the login above its
    // floor. One with a reset time lasts until then: the windows read may not be the quota the
    // provider refused.
    if let Some(hold) = store::get::<AccountHold>(tx, "accountHold", &allowance.id)?
        && hold.until.is_none()
        && allowance.checked_at.is_some_and(|at| at > hold.since)
        && windows
            .iter()
            .all(|&(long, remaining, resets_at)| remaining > floor_for(long, resets_at, now))
    {
        store::remove(tx, "accountHold", &allowance.id, revision)?;
    }
    // Only the last BURN_WINDOW_HOURS of readings are ever read.
    tx.execute(
        "DELETE FROM documents WHERE kind='allowanceReading' AND json_extract(body,'$.account')=?1 AND json_extract(body,'$.recordedAt')<=?2",
        params![
            allowance.id,
            now.saturating_sub((BURN_WINDOW_HOURS * HOUR_MS) as u64)
        ],
    )
    .map_err(Error::internal)?;
    for (long, remaining, resets_at) in windows {
        let reading = AllowanceReading {
            account: allowance.id.clone(),
            long,
            remaining,
            resets_at,
            recorded_at: now,
        };
        let id = format!(
            "{}:{}:{now}",
            allowance.id,
            if long { "long" } else { "short" }
        );
        store::put(tx, "allowanceReading", &id, &reading, revision)?;
    }
    Ok(json!({"allowance":allowance}))
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AccountHold {
    account: String,
    reason: String,
    /// When the provider said its window resets; none holds until a fresh allowance reading.
    #[serde(default)]
    until: Option<u64>,
    #[serde(default)]
    since: u64,
}

/// The host holds a login the provider rate-limited or whose allowance ran out; work moves to its
/// other logins until the window resets or a reading taken after the hold shows allowance again.
pub(crate) fn hold_account(
    tx: &Transaction<'_>,
    parameters: &Value,
    revision: u64,
    now: u64,
) -> Result<Value> {
    let mut hold: AccountHold = decode(parameters, "hold")?;
    identifier(&hold.account)?;
    crate::text(&hold.reason, 500, "hold reason")?;
    // With no reset time, only a later reading can end a hold; a login that reports none would
    // be held for good, so it is not held and the failure stays a failed round.
    if hold.until.is_none()
        && store::get::<Allowance>(tx, "allowance", &hold.account)?
            .is_none_or(|allowance| allowance.checked_at.is_none())
    {
        return Ok(json!({ "hold": null }));
    }
    hold.since = now;
    store::put(tx, "accountHold", &hold.account, &hold, revision)?;
    Ok(json!({ "hold": hold }))
}

/// Replaces the whole bench, as an import of the bench file does.
pub(crate) fn set_bench(tx: &Transaction<'_>, parameters: &Value, revision: u64) -> Result<Value> {
    user(parameters)?;
    let entries: Vec<Bench> = decode(parameters, "bench")?;
    for entry in &entries {
        identifier(&entry.model)?;
        identifier(&entry.effort)?;
        // A free attempt would make every other candidate infinitely dearer.
        if !(0.0..=100.0).contains(&entry.score) || entry.cost_micros == 0 {
            return Err(Error::invalid(
                "Bench scores are 0 to 100 and an attempt costs more than nothing",
            ));
        }
    }
    tx.execute("DELETE FROM documents WHERE kind='bench'", [])
        .map_err(Error::internal)?;
    for entry in &entries {
        store::put(
            tx,
            "bench",
            &format!("{}/{}", entry.model, entry.effort),
            entry,
            revision,
        )?;
    }
    Ok(json!({"bench":entries.len()}))
}
