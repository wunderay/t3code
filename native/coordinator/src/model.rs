use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: u32 = 1;
pub const MAX_PAGE: usize = 100;
pub const MAX_INPUT_BYTES: usize = 1_048_576;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Labels {
    pub coordinator_singular: String,
    pub coordinator_plural: String,
    pub thread_singular: String,
    pub thread_plural: String,
    pub profile_singular: String,
    pub profile_plural: String,
    /// "role" ("the Conductor") or "given" ("Claudia"); absent, as in stores made before it, a role.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub coordinator_name_kind: Option<String>,
}

// Matches DEFAULT_COORDINATOR_LABELS in packages/contracts/src/coordinator.ts.
impl Default for Labels {
    fn default() -> Self {
        Self {
            coordinator_singular: "Conductor".into(),
            coordinator_plural: "Conductors".into(),
            thread_singular: "thread".into(),
            thread_plural: "threads".into(),
            profile_singular: "profile".into(),
            profile_plural: "profiles".into(),
            coordinator_name_kind: None,
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PermissionMode {
    #[default]
    Ask,
    Approve,
    Full,
    Custom,
}

/// The highest mode of a thread the Coordinator may change. Full access is not one: a thread
/// that never asks would let the Coordinator act without the owner.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ManagedCeiling {
    ApprovalRequired,
    #[default]
    AutoAcceptEdits,
    Auto,
}

/// Whether the chosen instance and model gave the Coordinator's thread its tools: its first turn
/// must call `coordinator_status`.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThreadProof {
    pub provider: String,
    pub model: String,
    pub proved: bool,
    #[serde(default)]
    pub reason: Option<String>,
    pub at: u64,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Placement {
    #[default]
    Automatic,
    PreferCloud,
    CloudOnly,
    LocalOnly,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Configuration {
    pub enabled: bool,
    pub coordinator_paused: bool,
    pub labels: Labels,
    pub permission_mode: PermissionMode,
    pub placement: Placement,
    pub coordinator_title: Option<String>,
    pub coordinator_provider: Option<String>,
    pub coordinator_model: Option<String>,
    #[serde(default)]
    pub coordinator_project_id: Option<String>,
    #[serde(default)]
    pub coordinator_thread_id: Option<String>,
    #[serde(default)]
    pub guild_bindings: Vec<GuildBinding>,
    #[serde(default)]
    pub allow_unverified_cloud_models: bool,
    #[serde(default)]
    pub managed_ceiling: ManagedCeiling,
    #[serde(default)]
    pub manage_other_threads: bool,
    /// Projects whose reviewed changes wait for the owner to merge them.
    #[serde(default)]
    pub manual_merge_projects: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_proof: Option<ThreadProof>,
    /// The owner's setting, in minutes: how often at least the Coordinator hears of every
    /// unsettled thread. Unset, the host's default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub check_in_minutes: Option<u32>,
    /// The owner's setting, in minutes: how long work waits on the owner before it is parked,
    /// freeing its slot and its login. Unset, the host's default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub park_minutes: Option<u32>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GuildBinding {
    pub id: String,
    pub name: String,
    pub provider_instance_id: String,
    pub guild_provider: String,
    pub guild_account: Option<String>,
    #[serde(default)]
    pub guild_model: Option<String>,
    pub profile_id: Option<String>,
    pub environment_id: Option<String>,
    #[serde(default)]
    pub cloud: Option<CloudBinding>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudBinding {
    pub project_id: String,
    pub destination: String,
    pub guild_model: String,
    pub repository: String,
    pub environment: String,
    pub branch: String,
    pub head: String,
    pub base: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PauseState {
    pub active: bool,
    pub revision: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Card {
    pub id: String,
    pub thread_id: String,
    pub environment_id: String,
    pub project_id: String,
    pub purpose: String,
    pub status: String,
    pub instruction_revision: u64,
    #[serde(default)]
    pub profile_id: Option<String>,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub destination: Option<String>,
    #[serde(default)]
    pub assignment_id: Option<String>,
    #[serde(default)]
    pub blocker: Option<String>,
    #[serde(default)]
    pub next_step: Option<String>,
    #[serde(default)]
    pub dependencies: Vec<String>,
    #[serde(default)]
    pub acceptance_criteria: Vec<String>,
    #[serde(default)]
    pub evidence: Vec<String>,
    #[serde(default)]
    pub summary_updated_at: Option<u64>,
    #[serde(default)]
    pub settled: bool,
    #[serde(default)]
    pub archived: bool,
    #[serde(default)]
    pub stale: bool,
    #[serde(default)]
    pub verified: bool,
    #[serde(default)]
    pub revision: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Goal {
    pub id: String,
    pub purpose: String,
    #[serde(default = "active")]
    pub status: String,
    #[serde(default)]
    pub priority: i32,
    #[serde(default)]
    pub acceptance_criteria: Vec<String>,
    #[serde(default)]
    pub dependencies: Vec<String>,
    #[serde(default)]
    pub authorized_scope: Vec<String>,
    #[serde(default)]
    pub assignment_ids: Vec<String>,
    #[serde(default)]
    pub evidence: Vec<String>,
    #[serde(default)]
    pub integration_owner: Option<String>,
    #[serde(default)]
    pub max_attempts: Option<u32>,
    #[serde(default)]
    pub budget_micros: Option<u64>,
    #[serde(default)]
    pub budget_seconds: Option<u64>,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub touches: Vec<String>,
    #[serde(default)]
    pub verified: bool,
    #[serde(default)]
    pub revision: u64,
}

fn active() -> String {
    "active".into()
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Scope {
    pub kind: String,
    pub id: Option<String>,
}

impl Default for Scope {
    fn default() -> Self {
        Self {
            kind: "global".into(),
            id: None,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PermissionRule {
    pub category: String,
    pub effect: String,
    #[serde(default)]
    pub resource: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PermissionPolicy {
    pub id: String,
    pub mode: PermissionMode,
    #[serde(default)]
    pub scope: Scope,
    #[serde(default)]
    pub rules: Vec<PermissionRule>,
    #[serde(default)]
    pub max_access: u8,
    #[serde(default)]
    pub delegate_approval: bool,
    #[serde(default)]
    pub allow_access_increase: bool,
    #[serde(default)]
    pub expires_at: Option<u64>,
    #[serde(default)]
    pub revoked: bool,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub revision: u64,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RouteSelection {
    pub profile_id: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub account: Option<String>,
    pub destination: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelOverride {
    pub id: String,
    pub scope: Scope,
    pub selection: RouteSelection,
    #[serde(default)]
    pub source_goal_id: Option<String>,
    #[serde(default)]
    pub source_goal_revision: Option<u64>,
    #[serde(default)]
    pub provenance: Option<String>,
    #[serde(default)]
    pub revision: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CatalogModel {
    #[serde(default)]
    pub manually_quarantined: bool,
    pub id: String,
    pub source_id: String,
    pub provider: String,
    pub model: String,
    pub destination: String,
    pub account: Option<String>,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub efforts: Vec<String>,
    #[serde(default)]
    pub state: String,
    #[serde(default)]
    pub compatible: bool,
    #[serde(default)]
    pub accessible: bool,
    #[serde(default)]
    pub policy_allowed: bool,
    #[serde(default)]
    pub qualification_verified: bool,
    #[serde(default)]
    pub identity_verified: bool,
    #[serde(default)]
    pub context_tokens: Option<u64>,
    #[serde(default)]
    pub output_tokens: Option<u64>,
    #[serde(default)]
    pub price_micros: Option<u64>,
    #[serde(default)]
    pub pricing_provenance: Option<String>,
    #[serde(default)]
    pub evidence: Vec<String>,
    #[serde(default)]
    pub stale: bool,
    #[serde(default)]
    pub missing_refreshes: u8,
    #[serde(default)]
    pub discovered_at: u64,
    #[serde(default)]
    pub revision: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Reservation {
    pub id: String,
    pub owner: String,
    pub expires_at: u64,
    pub policy_revision: String,
    pub shared_capacity: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Assignment {
    pub id: String,
    pub idempotency_key: String,
    pub card_id: String,
    pub goal_id: Option<String>,
    pub route: RouteSelection,
    pub instruction_revision: u64,
    pub pause_revision: u64,
    #[serde(default)]
    pub grant_revision: u64,
    pub reservation: Reservation,
    #[serde(default = "queued")]
    pub status: String,
    #[serde(default)]
    pub brief: String,
    /// What its thread is called: the title its delegation gave.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default)]
    pub return_route: String,
    #[serde(default = "default_task_rank")]
    pub rank: String,
    #[serde(default = "default_work_role")]
    pub role: String,
    #[serde(default)]
    pub skills: Vec<String>,
    #[serde(default)]
    pub review_subjects: Vec<ReviewSubject>,
    #[serde(default)]
    pub review_goal_digest: Option<String>,
    #[serde(default)]
    pub supersedes: Vec<String>,
    #[serde(default)]
    pub review_supersessions: Vec<Supersession>,
    #[serde(default)]
    pub receipt: Option<Value>,
    #[serde(default)]
    pub execution_id: Option<String>,
    #[serde(default)]
    pub actual_model: Option<String>,
    #[serde(default)]
    pub actual_effort: Option<String>,
    #[serde(default)]
    pub identity_verified: bool,
    #[serde(default)]
    pub group_pause_revision: Option<u64>,
    #[serde(default)]
    pub pause_status: Option<String>,
    #[serde(default)]
    pub resume_supported: bool,
    #[serde(default)]
    pub independently_paused: bool,
    #[serde(default)]
    pub progress_at: Option<u64>,
    #[serde(default)]
    pub last_contact_at: Option<u64>,
    #[serde(default)]
    pub progress_deadline: Option<u64>,
    #[serde(default)]
    pub check_ins: u8,
    #[serde(default)]
    pub attempts: u32,
    #[serde(default)]
    pub revision: u64,
}

fn default_task_rank() -> String {
    "B".into()
}
fn default_work_role() -> String {
    "adventurer".into()
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewSubject {
    pub assignment_id: String,
    pub execution_id: String,
    pub digest: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Supersession {
    pub assignment_id: String,
    pub replacement_assignment_id: String,
    pub digest: String,
    pub source_revision: u64,
}

fn queued() -> String {
    "queued".into()
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Action {
    pub id: String,
    pub kind: String,
    pub assignment_id: Option<String>,
    pub thread_id: Option<String>,
    pub environment_id: Option<String>,
    pub payload: Value,
    pub status: String,
    pub revision: u64,
    pub created_at: u64,
    pub pause_revision: u64,
    pub instruction_revision: Option<u64>,
    pub grant_revision: Option<u64>,
}

/// One goal on one route, from assignment to merged and done. Every review and repair round of the
/// goal adds its use and its time here.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub goal_id: String,
    pub instance: String,
    pub model: String,
    pub effort: String,
    pub rank: String,
    /// The assignments summed in, so a round recorded twice counts once.
    pub rounds: Vec<String>,
    /// None once a round's use is unknown.
    pub used_micros: Option<u64>,
    pub started_at: u64,
    pub ended_at: u64,
    /// Waiting on the owner or on a provider outage, which time leaves out.
    pub blocked_seconds: u64,
    pub finish: Option<Finish>,
    /// False for a failure that says nothing of the route's skill.
    pub counted: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Finish {
    Merged,
    Failed,
    Reverted,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Allowance {
    pub id: String,
    pub remaining: f64,
    #[serde(default)]
    pub resets_at: Option<u64>,
    #[serde(default)]
    pub long_remaining: Option<f64>,
    #[serde(default)]
    pub long_resets_at: Option<u64>,
    #[serde(default)]
    pub steady: bool,
    /// When the provider reported it, so a reading older than a hold cannot end the hold.
    #[serde(default)]
    pub checked_at: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AllowanceReading {
    pub account: String,
    pub long: bool,
    pub remaining: f64,
    pub resets_at: Option<u64>,
    pub recorded_at: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Bench {
    pub model: String,
    pub effort: String,
    pub score: f64,
    pub cost_micros: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Decision {
    pub id: String,
    pub summary: String,
    pub provenance: String,
    #[serde(default)]
    pub card_ids: Vec<String>,
    #[serde(default)]
    pub goal_ids: Vec<String>,
    #[serde(default)]
    pub expires_at: Option<u64>,
    #[serde(default)]
    pub revision: u64,
}
