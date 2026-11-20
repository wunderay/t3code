use serde_json::{Value, json};
use std::path::Path;
use t3_coordinator::Supervisor;

const NOW: u64 = 1_800_000_000_000;
const HOUR: u64 = 3_600_000;

fn call(supervisor: &mut Supervisor, method: &str, params: Value, now: u64) -> Value {
    supervisor
        .call_at(method, params, now)
        .unwrap_or_else(|error| panic!("{method}: {error}"))
}

fn open() -> Supervisor {
    Supervisor::open(Path::new(":memory:")).unwrap()
}

fn candidate(profile: &str, model: &str, family: &str) -> Value {
    json!({"profileId":profile,"instance":"claude","provider":"claude","model":model,"family":family,"effort":"high","destination":"cloud:claude","account":profile})
}

/// (model, score, dollars per attempt) at effort high.
fn bench(supervisor: &mut Supervisor, entries: &[(&str, f64, f64)]) {
    let entries: Vec<Value> = entries
        .iter()
        .map(|(model, score, usd)| json!({"model":model,"effort":"high","score":score,"costMicros":(usd * 1e6) as u64}))
        .collect();
    call(
        supervisor,
        "bench.set",
        json!({ "actor": "user", "bench": entries }),
        NOW,
    );
}

/// A round of goal `goal` on `model`: `used` micro-dollars over `seconds`, ending in `finish`.
fn round(
    supervisor: &mut Supervisor,
    (assignment, goal): (&str, &str),
    (model, rank): (&str, &str),
    (used, seconds): (u64, u64),
    finish: Value,
) -> Value {
    call(
        supervisor,
        "outcomes.record",
        json!({"round":{"assignmentId":assignment,"goalId":goal,"instance":"claude","model":model,"effort":"high","rank":rank,
               "usedMicros":used,"startedAt":NOW - seconds * 1000,"endedAt":NOW,"finish":finish}}),
        NOW,
    )["outcome"]
        .clone()
}

fn outcome(supervisor: &mut Supervisor, id: &str, model: &str, rank: &str, merged: bool) {
    let finish = if merged { "merged" } else { "failed" };
    round(
        supervisor,
        (id, id),
        (model, rank),
        (100_000, 1800),
        json!(finish),
    );
}

fn weigh(supervisor: &mut Supervisor, weights: Value) {
    call(
        supervisor,
        "router.weights.set",
        json!({ "actor": "user", "weights": weights }),
        NOW,
    );
}

fn route(supervisor: &mut Supervisor, request: Value) -> Value {
    call(
        supervisor,
        "router.score",
        json!({ "request": request }),
        NOW,
    )
}

fn scored<'a>(result: &'a Value, profile: &str) -> &'a Value {
    result["scores"]
        .as_array()
        .unwrap()
        .iter()
        .find(|score| score["profileId"] == profile)
        .unwrap()
}

fn reason(result: &Value, profile: &str) -> String {
    scored(result, profile)["reason"]
        .as_str()
        .unwrap_or_default()
        .into()
}

fn allowance(supervisor: &mut Supervisor, allowance: Value, now: u64) {
    call(
        supervisor,
        "allowance.record",
        json!({ "allowance": allowance }),
        now,
    );
}

#[test]
fn use_is_counted_per_merge_not_per_run() {
    let mut supervisor = open();
    bench(
        &mut supervisor,
        &[("cheap", 30.0, 0.1), ("steady", 45.0, 0.15)],
    );
    weigh(&mut supervisor, json!({"use":1,"time":0}));
    let result = route(
        &mut supervisor,
        json!({"rank":"D","candidates":[candidate("cheap","cheap","a"),candidate("steady","steady","a")]}),
    );
    // 0.14/0.5 per pass against 0.21/0.9, reviews included.
    assert_eq!(result["pick"]["profileId"], "steady");
    assert!(
        scored(&result, "cheap")["cost"]["use"].as_f64()
            > scored(&result, "steady")["cost"]["use"].as_f64()
    );
}

#[test]
fn the_rank_bar_an_excluded_family_and_the_allowance_floor_exclude() {
    let mut supervisor = open();
    bench(&mut supervisor, &[("small", 40.0, 0.1)]);
    let request = json!({"rank":"B","excludeFamily":"b","candidates":[candidate("small","small","a"),candidate("big","big","b"),candidate("other","other","a")]});
    let result = route(&mut supervisor, request.clone());
    assert_eq!(reason(&result, "small"), "score 40 qualifies C");
    assert_eq!(reason(&result, "big"), "excluded model family");
    assert_eq!(scored(&result, "other")["reason"], Value::Null);
    allowance(
        &mut supervisor,
        json!({"id":"other","remaining":5,"resetsAt":NOW + HOUR}),
        NOW,
    );
    let result = route(&mut supervisor, request);
    assert!(reason(&result, "other").contains("floor"));
    assert_eq!(result["pick"], Value::Null);
}

#[test]
fn history_outweighs_the_prior_and_only_the_newest_twenty_count() {
    let mut supervisor = open();
    bench(&mut supervisor, &[("x", 45.0, 0.1), ("y", 45.0, 0.3)]);
    for index in 0..25 {
        outcome(&mut supervisor, &format!("x{index}"), "x", "D", false);
    }
    let result = route(
        &mut supervisor,
        json!({"rank":"D","candidates":[candidate("x","x","a"),candidate("y","y","a")]}),
    );
    assert_eq!(scored(&result, "x")["observedRuns"], 20.0);
    assert_eq!(result["pick"]["profileId"], "y");
}

#[test]
fn a_weekly_window_at_its_floor_excludes() {
    let mut supervisor = open();
    allowance(
        &mut supervisor,
        json!({"id":"x","remaining":60,"resetsAt":NOW + HOUR,"longRemaining":10,"longResetsAt":NOW + 120 * HOUR}),
        NOW,
    );
    let result = route(
        &mut supervisor,
        json!({"rank":"B","candidates":[candidate("x","x","a")]}),
    );
    assert!(reason(&result, "x").contains("weekly window"));
}

#[test]
fn measured_burn_drives_scarcity() {
    let mut supervisor = open();
    let reset = NOW + 50 * HOUR;
    // 30 points in 3 hours with 50 to go: 500 projected against 45 above the floor.
    for (at, left) in [(NOW - 3 * HOUR, 90), (NOW, 60)] {
        allowance(
            &mut supervisor,
            json!({"id":"x","remaining":80,"resetsAt":NOW + HOUR,"longRemaining":left,"longResetsAt":reset}),
            at,
        );
    }
    let result = route(
        &mut supervisor,
        json!({"rank":"B","candidates":[candidate("x","x","a")]}),
    );
    assert!(scored(&result, "x")["scarcity"].as_f64().unwrap() > 5.0);
}

#[test]
fn the_weekly_floor_lifts_near_the_weekly_reset() {
    let mut supervisor = open();
    let request = json!({"rank":"B","candidates":[candidate("x","x","a")]});
    allowance(
        &mut supervisor,
        json!({"id":"x","remaining":60,"resetsAt":NOW + HOUR,"longRemaining":8,"longResetsAt":NOW + 10 * HOUR}),
        NOW,
    );
    let result = route(&mut supervisor, request.clone());
    assert_eq!(scored(&result, "x")["reason"], Value::Null);
    assert!(scored(&result, "x")["scarcity"].as_f64().unwrap() >= 1.0);
    allowance(
        &mut supervisor,
        json!({"id":"x","remaining":60,"resetsAt":NOW + HOUR,"longRemaining":8,"longResetsAt":NOW + 72 * HOUR}),
        NOW,
    );
    assert!(reason(&route(&mut supervisor, request), "x").contains("floor"));
}

#[test]
fn steady_pacing_holds_new_work_but_not_a_review() {
    let mut supervisor = open();
    allowance(
        &mut supervisor,
        json!({"id":"x","remaining":90,"resetsAt":NOW + 2 * HOUR,"longRemaining":60,"longResetsAt":NOW + 150 * HOUR,"steady":true}),
        NOW,
    );
    let candidates = json!([candidate("x", "x", "a")]);
    let work = route(&mut supervisor, json!({"rank":"B","candidates":candidates}));
    assert!(reason(&work, "x").starts_with("pacing hold: weekly window 60% left"));
    let review = route(
        &mut supervisor,
        json!({"rank":"B","candidates":candidates,"reviewOf":[{"model":"author","effort":"high","family":"b"}]}),
    );
    assert_eq!(review["pick"]["profileId"], "x");
}

/// One running assignment of profile `rev` on provider `replay`, under `account`.
fn running(supervisor: &mut Supervisor, account: Value) {
    call(
        supervisor,
        "configure",
        json!({"actor":"user","enabled":true,"coordinatorProvider":"replay","coordinatorModel":"replay"}),
        NOW,
    );
    call(
        supervisor,
        "cards.sync",
        json!({"cards":[{"id":"parent","threadId":"parent","environmentId":"env","projectId":"project","purpose":"Purpose","status":"running","instructionRevision":1}]}),
        NOW,
    );
    call(
        supervisor,
        "catalog.sync",
        json!({"sourceId":"provider","models":[{"id":"catalog:local:rev","sourceId":"provider","provider":"replay","model":"rev","destination":"local","account":account,"efforts":["high"],"compatible":true,"accessible":true,"policyAllowed":true,"qualificationVerified":true,"identityVerified":true,"evidence":["qualification:exact-model-and-options"]}]}),
        NOW,
    );
    call(
        supervisor,
        "assignments.prepare",
        json!({"assignment":{"id":"work","idempotencyKey":"request:work","cardId":"parent","goalId":null,"route":{"profileId":"rev","provider":"replay","model":"rev","effort":"high","destination":"local","account":account},"instructionRevision":1,"pauseRevision":0,"grantRevision":0,"reservation":{"id":"reservation:work","owner":"t3:local","expiresAt":NOW + HOUR,"policyRevision":"policy-v1","sharedCapacity":true},"brief":"Build the bounded result.","returnRoute":"coordinator:coordinator"}}),
        NOW,
    );
}

#[test]
fn an_owner_login_limit_never_holds_a_reviewer_but_the_machine_bounds_everyone() {
    let mut supervisor = open();
    running(&mut supervisor, json!("acct"));
    let mut limited = candidate("rev", "rev", "a");
    limited["provider"] = json!("replay");
    limited["account"] = json!("acct");
    limited["loginMaxParallel"] = json!(1);
    let review_of = json!([{"model":"author","effort":"high","family":"b"}]);
    let work = route(&mut supervisor, json!({"rank":"B","candidates":[limited]}));
    assert_eq!(reason(&work, "rev"), "login acct at the limit you set");
    let review = route(
        &mut supervisor,
        json!({"rank":"B","candidates":[limited],"reviewOf":review_of}),
    );
    assert_eq!(review["pick"]["profileId"], "rev");
    // Without a limit set, nothing but the machine bounds local work.
    let mut local = candidate("rev", "rev", "a");
    local["destination"] = json!("local");
    let free = route(&mut supervisor, json!({"rank":"B","candidates":[local]}));
    assert_eq!(free["pick"]["profileId"], "rev");
    let full = route(
        &mut supervisor,
        json!({"rank":"B","candidates":[local],"reviewOf":review_of,"localSlots":1}),
    );
    assert_eq!(
        reason(&full, "rev"),
        "this machine has no room for another local thread"
    );
}

#[test]
fn a_reviewer_may_share_the_family_but_never_the_model() {
    let mut supervisor = open();
    let result = route(
        &mut supervisor,
        json!({"rank":"B","candidates":[candidate("same","opus","anthropic"),candidate("other","sonnet","anthropic")],"reviewOf":[{"model":"opus","effort":"high","family":"anthropic"}]}),
    );
    assert_eq!(reason(&result, "same"), "same model as the author");
    assert_eq!(result["pick"]["profileId"], "other");
}

#[test]
fn a_reviewer_is_of_the_authors_tier_or_above_and_from_another_family_first() {
    let mut supervisor = open();
    bench(
        &mut supervisor,
        &[
            ("author", 57.0, 1.0),
            ("low", 50.0, 0.1),
            ("kin", 58.0, 0.1),
            ("stranger", 58.0, 1.0),
        ],
    );
    let result = route(
        &mut supervisor,
        json!({"rank":"B","candidates":[candidate("low","low","b"),candidate("kin","kin","a"),candidate("stranger","stranger","b")],"reviewOf":[{"model":"author","effort":"high","family":"a"}]}),
    );
    assert_eq!(reason(&result, "low"), "tier 2, needs 3");
    assert_eq!(scored(&result, "kin")["reason"], Value::Null);
    assert_eq!(result["pick"]["profileId"], "stranger");
}

#[test]
fn the_effort_cap_missing_skills_and_earlier_attempts_exclude() {
    let mut supervisor = open();
    let mut low = candidate("p", "m", "a");
    low["effort"] = json!("low");
    low["skills"] = json!(["rust"]);
    let mut high = candidate("p", "m", "a");
    high["skills"] = json!(["rust"]);
    let mut failed = candidate("f", "n", "a");
    failed["skills"] = json!(["rust"]);
    let mut tried = candidate("t", "o", "a");
    tried["skills"] = json!(["rust"]);
    let result = route(
        &mut supervisor,
        json!({"rank":"B","maxEffort":"medium","skills":["rust"],"tried":["t"],"failed":[{"model":"n","effort":"high"}],
               "candidates":[high,low,failed,tried,candidate("s","s","a")]}),
    );
    let reasons: Vec<&str> = result["scores"]
        .as_array()
        .unwrap()
        .iter()
        .map(|score| score["reason"].as_str().unwrap_or("eligible"))
        .collect();
    assert_eq!(
        reasons,
        [
            "eligible",
            "effort high is above the cap medium",
            "already failed this task at high",
            "already tried this task",
            "missing skills [\"rust\"]",
        ]
    );
}

#[test]
fn a_model_with_no_bench_entry_is_chosen_when_it_is_the_only_one() {
    let mut supervisor = open();
    bench(&mut supervisor, &[("known", 60.0, 0.1)]);
    let result = route(
        &mut supervisor,
        json!({"rank":"B","candidates":[candidate("new","new","a")]}),
    );
    assert_eq!(result["pick"]["profileId"], "new");
    assert_eq!(result["pick"]["prior"], 0.6);
    assert_eq!(result["pick"]["bench"], Value::Null);
}

#[test]
fn use_and_time_trade_off_under_the_owners_weights_which_the_coordinator_cannot_set() {
    let mut supervisor = open();
    bench(&mut supervisor, &[("fast", 50.0, 2.0), ("slow", 50.0, 0.2)]);
    for (model, used, seconds) in [("fast", 2_800_000, 600), ("slow", 280_000, 7200)] {
        for index in 0..10 {
            let id = format!("{model}{index}");
            round(
                &mut supervisor,
                (&id, &id),
                (model, "B"),
                (used, seconds),
                json!("merged"),
            );
        }
    }
    let request = json!({"rank":"B","candidates":[candidate("fast", "fast", "a"),candidate("slow", "slow", "a")]});
    let pick = |supervisor: &mut Supervisor, weights: Value| {
        weigh(supervisor, weights);
        route(supervisor, request.clone())["pick"]["profileId"].clone()
    };
    assert_eq!(pick(&mut supervisor, json!({"use":1,"time":0})), "slow");
    assert_eq!(pick(&mut supervisor, json!({"use":0,"time":1})), "fast");
    let refused = supervisor
        .call_at(
            "router.weights.set",
            json!({"actor":"coordinator","weights":{"use":1,"time":0}}),
            NOW,
        )
        .unwrap_err();
    assert!(refused.to_string().contains("direct user instruction"));
    assert_eq!(route(&mut supervisor, request)["pick"]["profileId"], "fast");
}

#[test]
fn every_round_of_a_goal_adds_its_use_and_time_and_a_revert_counts_double() {
    let mut supervisor = open();
    let author = ("m", "B");
    round(
        &mut supervisor,
        ("a1", "g"),
        author,
        (100, 600),
        Value::Null,
    );
    round(&mut supervisor, ("r1", "g"), author, (50, 300), Value::Null);
    // A round recorded twice counts once.
    round(&mut supervisor, ("r1", "g"), author, (50, 300), Value::Null);
    let repair = json!({"round":{"assignmentId":"p1","goalId":"g","instance":"claude","model":"m","effort":"high","rank":"B",
        "usedMicros":30,"startedAt":NOW,"endedAt":NOW + 900_000,"blockedSeconds":600,"finish":"merged"}});
    let merged = call(&mut supervisor, "outcomes.record", repair, NOW)["outcome"].clone();
    assert_eq!(merged["usedMicros"], 180);
    assert_eq!(merged["rounds"], json!(["a1", "r1", "p1"]));
    let request = json!({"rank":"B","candidates":[candidate("m","m","a")]});
    let run = |supervisor: &mut Supervisor| {
        let result = route(supervisor, request.clone());
        let score = scored(&result, "m");
        (
            score["observedPasses"].as_f64().unwrap(),
            score["secondsPerRun"].as_f64().unwrap(),
        )
    };
    // Ten minutes before the repair and fifteen of it, ten of those waiting on the owner.
    let expected = (4.0 * 1800.0 + 600.0 + 900.0 - 600.0) / 5.0;
    assert_eq!(run(&mut supervisor), (1.0, expected));
    let revert = round(
        &mut supervisor,
        ("v1", "g"),
        author,
        (20, 60),
        json!("reverted"),
    );
    assert_eq!(revert["usedMicros"], 200);
    let doubled = (4.0 * 1800.0 + 2.0 * 900.0) / 5.0;
    assert_eq!(run(&mut supervisor), (0.0, doubled));
    // A merged round recorded after the revert leaves it reverted.
    let late = round(
        &mut supervisor,
        ("late", "g"),
        author,
        (0, 0),
        json!("merged"),
    );
    assert_eq!(late["finish"], "reverted");
}

#[test]
fn a_near_rank_counts_half_and_an_unfinished_goal_not_at_all() {
    let mut supervisor = open();
    for index in 0..5 {
        outcome(&mut supervisor, &format!("m{index}"), "m", "B", true);
    }
    outcome(&mut supervisor, "near", "m", "A", true);
    round(
        &mut supervisor,
        ("open", "open"),
        ("m", "B"),
        (100, 60),
        Value::Null,
    );
    let result = route(
        &mut supervisor,
        json!({"rank":"B","candidates":[candidate("m","m","a")]}),
    );
    assert_eq!(scored(&result, "m")["observedRuns"], 5.5);
}

#[test]
fn the_login_limit_counts_running_work_by_provider_not_instance() {
    let mut supervisor = open();
    running(&mut supervisor, json!("acct"));
    let mut other = candidate("other", "other", "a");
    other["instance"] = json!("replay-work");
    other["provider"] = json!("replay");
    other["account"] = json!("acct");
    other["loginMaxParallel"] = json!(1);
    let result = route(&mut supervisor, json!({"rank":"B","candidates":[other]}));
    assert_eq!(reason(&result, "other"), "login acct at the limit you set");
}

fn close(actual: &Value, expected: f64) {
    let actual = actual.as_f64().unwrap();
    assert!(
        (actual - expected).abs() <= 1e-9 * expected.abs(),
        "{actual} != {expected}"
    );
}

#[test]
fn the_pass_rate_blends_four_prior_runs_and_cost_is_per_pass_with_reviews() {
    let mut supervisor = open();
    outcome(&mut supervisor, "p1", "m", "B", true);
    outcome(&mut supervisor, "p2", "m", "B", true);
    outcome(&mut supervisor, "f1", "m", "B", false);
    let result = route(
        &mut supervisor,
        json!({"rank":"B","candidates":[candidate("m","m","a")]}),
    );
    let score = scored(&result, "m");
    let pass_rate = (4.0 * 0.6 + 2.0) / (4.0 + 3.0);
    close(&score["passRate"], pass_rate);
    close(&score["secondsPerRun"], 1800.0);
    close(&score["cost"]["time"], 1800.0 / pass_rate);
    // The default attempt plus 0.4 of it for reviews, blended with three rounds of 0.1 dollars.
    let run_cost = (4.0 * 1_400_000.0 + 3.0 * 100_000.0) / 7.0;
    close(&score["cost"]["use"], run_cost / pass_rate);
}

#[test]
fn the_pass_rate_never_falls_below_its_floor() {
    let mut supervisor = open();
    bench(&mut supervisor, &[("m", 48.0, 0.1)]);
    for rank in ["A", "B", "C"] {
        for index in 0..20 {
            outcome(&mut supervisor, &format!("{rank}{index}"), "m", rank, false);
        }
    }
    let result = route(
        &mut supervisor,
        json!({"rank":"B","candidates":[candidate("m","m","a")]}),
    );
    // 2 / 44 unfloored.
    close(&scored(&result, "m")["passRate"], 0.05);
}

#[test]
fn the_fastest_within_ten_percent_is_picked_but_never_over_another_family() {
    let mut supervisor = open();
    bench(
        &mut supervisor,
        &[
            ("slow", 50.0, 1.0),
            ("quick", 50.0, 1.05),
            ("dear", 50.0, 1.2),
        ],
    );
    for (model, used, seconds) in [
        ("slow", 1_400_000, 3600),
        ("quick", 1_470_000, 600),
        ("dear", 1_680_000, 60),
    ] {
        for index in 0..10 {
            let id = format!("{model}{index}");
            round(
                &mut supervisor,
                (&id, &id),
                (model, "B"),
                (used, seconds),
                json!("merged"),
            );
        }
    }
    weigh(&mut supervisor, json!({"use":1,"time":0}));
    let work = route(
        &mut supervisor,
        json!({"rank":"B","candidates":[candidate("slow","slow","a"),candidate("quick","quick","a"),candidate("dear","dear","a")]}),
    );
    assert_eq!(work["pick"]["profileId"], "quick");
    let review = route(
        &mut supervisor,
        json!({"rank":"B","candidates":[candidate("quick","quick","a"),candidate("slow","slow","b")],"reviewOf":[{"model":"author","effort":"high","family":"a"}]}),
    );
    assert_eq!(review["pick"]["profileId"], "slow");
}

#[test]
fn a_steady_window_in_its_last_hour_is_spent_freely() {
    let mut supervisor = open();
    allowance(
        &mut supervisor,
        json!({"id":"x","remaining":20,"resetsAt":NOW + HOUR / 2,"steady":true}),
        NOW,
    );
    let result = route(
        &mut supervisor,
        json!({"rank":"B","candidates":[candidate("x","x","a")]}),
    );
    // Paced, 20% left against a 9.9% target would be 0.495.
    close(&scored(&result, "x")["scarcity"], 0.25);
}

#[test]
fn burn_counts_readings_of_one_period_allowing_for_jitter_in_its_reset() {
    let reset = NOW + 50 * HOUR;
    let scarcity = |earlier_reset: u64| {
        let mut supervisor = open();
        for (at, left, resets) in [(NOW - 3 * HOUR, 90, earlier_reset), (NOW, 60, reset)] {
            allowance(
                &mut supervisor,
                json!({"id":"x","remaining":80,"resetsAt":NOW + HOUR,"longRemaining":left,"longResetsAt":resets}),
                at,
            );
        }
        let result = route(
            &mut supervisor,
            json!({"rank":"B","candidates":[candidate("x","x","a")]}),
        );
        scored(&result, "x")["scarcity"].as_f64().unwrap()
    };
    // 10 points an hour for 50 hours against 45 above the floor.
    assert_eq!(scarcity(reset - 60_000), 1.0 + 455.0 / 45.0);
    assert_eq!(scarcity(reset - HOUR), 1.0);
}

#[test]
fn a_result_whose_use_went_unreported_costs_the_bench_estimate_not_nothing() {
    let mut supervisor = open();
    bench(
        &mut supervisor,
        &[("unreported", 50.0, 1.0), ("free", 50.0, 1.0)],
    );
    for model in ["unreported", "free"] {
        let id = format!("goal-{model}");
        let used = if model == "free" {
            json!(0)
        } else {
            Value::Null
        };
        call(
            &mut supervisor,
            "outcomes.record",
            json!({"round":{"assignmentId":id,"goalId":id,"instance":"claude","model":model,"effort":"high","rank":"B",
                   "usedMicros":used,"startedAt":NOW - 1_800_000,"endedAt":NOW,"finish":"merged"}}),
            NOW,
        );
    }
    let unknown = call(
        &mut supervisor,
        "outcomes.record",
        json!({"round":{"assignmentId":"later","goalId":"goal-unreported","instance":"claude","model":"unreported","effort":"high","rank":"B",
               "usedMicros":5,"startedAt":NOW,"endedAt":NOW}}),
        NOW,
    )["outcome"]
        .clone();
    // A known round after an unknown one leaves the outcome's use unknown.
    assert_eq!(unknown["usedMicros"], Value::Null);
    let result = route(
        &mut supervisor,
        json!({"rank":"B","candidates":[candidate("a","unreported","x"),candidate("b","free","y")]}),
    );
    let cost = |profile: &str| scored(&result, profile)["cost"]["use"].as_f64().unwrap();
    // Four prior runs at 1.4 USD and one result: at the estimate it stays there; at zero it falls.
    assert!(
        (cost("a") - cost("b") * 5.0 / 4.0).abs() < 1.0,
        "{} {}",
        cost("a"),
        cost("b")
    );
    assert!(cost("a") > cost("b"));
}

#[test]
fn an_owner_operation_that_names_no_actor_is_refused() {
    let mut supervisor = open();
    for (method, params) in [
        ("bench.set", json!({"bench":[]})),
        ("router.weights.set", json!({"weights":{"use":1,"time":1}})),
        ("board.limits", json!({"limits":{}})),
        ("configure", json!({"placement":"local-only"})),
    ] {
        let refused = supervisor.call_at(method, params, NOW).unwrap_err();
        assert_eq!(refused.code, -32003, "{method}");
    }
}

#[test]
fn a_review_of_several_authors_shares_none_of_their_models() {
    let mut supervisor = open();
    let result = route(
        &mut supervisor,
        json!({"rank":"B","candidates":[candidate("one","first","a"),candidate("two","second","b"),candidate("three","third","c")],
               "reviewOf":[{"model":"first","effort":"high","family":"a"},{"model":"second","effort":"high","family":"b"}]}),
    );
    assert_eq!(reason(&result, "one"), "same model as the author");
    assert_eq!(reason(&result, "two"), "same model as the author");
    assert_eq!(result["pick"]["profileId"], "three");
}

/// Two logins of one provider, both offering `model`: separate candidates, one pooled record.
fn logins(model: &str) -> Value {
    let login = |account: &str| json!({"profileId":account,"instance":account,"provider":"claude","model":model,"family":"a","effort":"high","destination":"cloud:claude","account":account});
    json!([login("first"), login("second")])
}

fn hold(supervisor: &mut Supervisor, account: &str, until: Option<u64>, now: u64) {
    call(
        supervisor,
        "account.hold",
        json!({"hold":{"account":account,"reason":"usage limit reached","until":until}}),
        now,
    );
}

#[test]
fn equal_logins_take_turns_and_a_busy_one_waits_for_the_other() {
    let mut supervisor = open();
    let first = route(
        &mut supervisor,
        json!({"rank":"B","candidates":logins("m")}),
    );
    let picked = first["pick"]["profileId"].as_str().unwrap().to_owned();
    // The login picked now runs one thread; the next pick is the other.
    let mut candidates = logins("m");
    for candidate in candidates.as_array_mut().unwrap() {
        if candidate["account"] == json!(picked) {
            candidate["ownerRunning"] = json!(1);
        }
    }
    let next = route(&mut supervisor, json!({"rank":"B","candidates":candidates}));
    assert_ne!(next["pick"]["profileId"], json!(picked));
}

#[test]
fn a_login_nearly_spent_leaves_the_work_to_the_other() {
    let mut supervisor = open();
    allowance(
        &mut supervisor,
        json!({"id":"first","remaining":20.0,"resetsAt":NOW + HOUR}),
        NOW,
    );
    allowance(
        &mut supervisor,
        json!({"id":"second","remaining":90.0,"resetsAt":NOW + HOUR}),
        NOW,
    );
    let result = route(
        &mut supervisor,
        json!({"rank":"B","candidates":logins("m")}),
    );
    assert_eq!(result["pick"]["profileId"], "second");
}

#[test]
fn a_held_login_takes_nothing_until_its_reset_whatever_the_readings_say() {
    let mut supervisor = open();
    hold(&mut supervisor, "first", Some(NOW + HOUR), NOW);
    let held = route(
        &mut supervisor,
        json!({"rank":"B","candidates":logins("m")}),
    );
    assert_eq!(held["pick"]["profileId"], "second");
    assert_eq!(
        reason(&held, "first"),
        format!("first held until {}: usage limit reached", NOW + HOUR)
    );
    // The windows read may not be the quota the provider refused: the reset time wins.
    allowance(
        &mut supervisor,
        json!({"id":"first","remaining":80.0,"resetsAt":NOW + 2 * HOUR,"checkedAt":NOW + 2}),
        NOW + 2,
    );
    let still = route(
        &mut supervisor,
        json!({"rank":"B","candidates":logins("m")}),
    );
    assert!(!reason(&still, "first").is_empty());
    let after = supervisor
        .call_at(
            "router.score",
            json!({"request":{"rank":"B","candidates":logins("m")}}),
            NOW + HOUR + 1,
        )
        .unwrap();
    assert_eq!(reason(&after, "first"), "");
}

#[test]
fn a_hold_with_no_reset_ends_on_a_reading_taken_after_it() {
    let mut supervisor = open();
    let reading =
        |at: u64| json!({"id":"first","remaining":80.0,"resetsAt":NOW + 2 * HOUR,"checkedAt":at});
    allowance(&mut supervisor, reading(NOW - 10), NOW - 10);
    hold(&mut supervisor, "first", None, NOW);
    allowance(&mut supervisor, reading(NOW - 1), NOW + 1);
    let still = route(
        &mut supervisor,
        json!({"rank":"B","candidates":logins("m")}),
    );
    assert!(!reason(&still, "first").is_empty());
    allowance(&mut supervisor, reading(NOW + 2), NOW + 2);
    let fresh = route(
        &mut supervisor,
        json!({"rank":"B","candidates":logins("m")}),
    );
    assert_eq!(reason(&fresh, "first"), "");
}

#[test]
fn every_login_held_leaves_the_work_waiting_with_the_reset() {
    let mut supervisor = open();
    hold(&mut supervisor, "first", Some(NOW + HOUR), NOW);
    hold(&mut supervisor, "second", Some(NOW + 2 * HOUR), NOW);
    let result = route(
        &mut supervisor,
        json!({"rank":"B","candidates":logins("m")}),
    );
    assert_eq!(result["pick"], Value::Null);
    assert_eq!(
        reason(&result, "first"),
        format!("first held until {}: usage limit reached", NOW + HOUR)
    );
}

#[test]
fn a_limit_with_no_reset_on_a_login_that_reports_no_readings_holds_nothing() {
    let mut supervisor = open();
    let unheld = call(
        &mut supervisor,
        "account.hold",
        json!({"hold":{"account":"first","reason":"usage limit reached"}}),
        NOW,
    );
    assert_eq!(unheld["hold"], Value::Null);
    let result = route(
        &mut supervisor,
        json!({"rank":"B","candidates":logins("m")}),
    );
    assert_eq!(reason(&result, "first"), "");
    // A login that reports readings can be held until a later one shows allowance again.
    allowance(
        &mut supervisor,
        json!({"id":"first","remaining":90.0,"resetsAt":NOW + HOUR,"checkedAt":NOW - 1}),
        NOW,
    );
    let held = call(
        &mut supervisor,
        "account.hold",
        json!({"hold":{"account":"first","reason":"usage limit reached"}}),
        NOW,
    );
    assert_eq!(held["hold"]["account"], "first");
}

#[test]
fn every_candidate_and_bench_entry_the_providers_offer_is_taken() {
    let mut supervisor = open();
    // No number caps them: as many routes as the owner's providers offer are scored.
    let entries: Vec<Value> = (0..1001)
        .map(|index| json!({"model":format!("m{index}"),"effort":"high","score":50,"costMicros":1000}))
        .collect();
    call(
        &mut supervisor,
        "bench.set",
        json!({"actor":"user","bench":entries}),
        NOW,
    );
    let candidates: Vec<Value> = (0..201)
        .map(|index| candidate(&format!("p{index}"), &format!("m{index}"), "family"))
        .collect();
    let scored = route(&mut supervisor, json!({"rank":"B","candidates":candidates}));
    assert_eq!(scored["scores"].as_array().unwrap().len(), 201);
}
