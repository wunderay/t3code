# Coordinator coordination

Coordinator is an optional coordinator for research, implementation and review across
other threads. It has its own page in Settings, under Agents, named as you name the
Coordinator (Conductor by default). Enable it there after choosing a project and any
provider instance and model. The coordinator receives your goals and delegates
implementation to ordinary T3 threads. You can still open those threads and change
their instructions, models or approvals yourself.

By default, each goal allows three corrective repair attempts after its initial work. Initial
work, reviews, capacity waits and the first integration of a successful cloud result
do not use that allowance. After the allowance is exhausted, Coordinator asks before
another repair. **Allow 3 more repairs** extends the same goal's allowance without
resetting previous attempts.

Cost has two parts, never mixed: what a goal uses and the time it takes until it is
merged. Every review and repair adds to its goal's cost, and a revert counts the cost
twice. Time spent waiting on you is left out. A goal can have a use cap and a time
cap, and a project a daily cap of each; at a cap nothing new starts for it and the
Coordinator tells you once.

No fixed number bounds how much runs. Each login runs as much as its allowance
allows: work is spread across the logins that offer a model by how much allowance
each has left and how much it already runs, and a login the provider limits takes no
new work until its window resets or a fresh reading shows allowance again; with every
login held, work waits and says until when. This machine runs one local thread per
logical CPU and starts none while less memory is available than the largest running
provider thread holds; cloud runs do not count against it. You can set a limit on work in flight, per login or on this
machine; a review is never held by it. Work waiting on your answer to an approval or
a question is parked after 30 minutes, a setting in Settings: it no longer counts
against any of these, is never answered for you, and carries on when you answer. Only you set caps and limits; the Coordinator
cannot change them.

Threads you start yourself are never routed, limited or capped, whether the
Coordinator is on or off. They count as running work on their login when the
Coordinator spreads its own assignments. Each provider instance in Settings is one
login; to spread work, add another instance of the provider signed in to another
account.

Use **Custom prompt and Memory** on the coordinator or in its settings to save
Markdown guidance for that Coordinator thread. Save applies changes; clearing the
fields and saving removes the guidance. Each coordinator thread keeps its own
guidance across restarts. The editor shows the combined limit and retains drafts
that are too long. Saved guidance cannot grant permissions or replace an exact
model selection.

## Its own thread

The Coordinator is a thread of its own: you talk to it there, and it plans,
delegates and answers with its tools. Its playbook, one of those tools, sets how:
it asks you questions until a request is clear, each with its recommendation; cuts
the work into goals of one whole feature and one pull request each; gives every
thread a brief with its done-criteria, folders, tests and what not to touch;
leaves the choice of model to the router; has each change reviewed by a model
other than its author's before it merges; and brings you only what it may not
decide, while other work goes on. Any provider instance and model can hold
the thread; choosing another in Settings moves it there for its next turn. A
Claude, Codex or ACP instance (Kiro, Grok and the like) is given the role's rules
with its instructions; on Cursor, OpenCode and Pi it has only its tools and the
playbook. Its
first turn must ask for its status: until it does, Settings
shows the instance as not proved, and an instance that gave it no T3 tools as
not working, with the reason. The thread is pinned and named in Settings.
It changes no files and runs no commands: it runs only with approval required,
on a provider that can ask first, and the host declines every command, edit
and permission it asks for. Disabling the Coordinator takes its tools
away; the thread stays.

The host wakes it with one message, never by interrupting a turn and never
behind one: a wake is written when its thread is free, so it says what is true
when it is read. It holds a
count of what is new in its inbox (work that ended or is blocked, with what
blocked work waits for, questions and
approvals waiting in the threads it manages) and one line for every unsettled
thread, with its state (a question or an approval waiting in it is named as
such), its last activity and its commits since the last such
message. A thread silent for a whole check-in interval is flagged. Nothing new
wakes nothing, its own actions never wake it, and until a wake's turn has ended
no other is queued. What a wake carried counts as told only when its turn
completed; otherwise the next wake says it again, and a check-in counts what is
still unread. Besides those wakes it hears of every unsettled thread at
least every 15 minutes, a setting in Settings. Settled means done: a change
settles when it is merged, a review when its result is taken, cancelled or
replaced work at once, and none of them is reported again. A cloud run shows
only what is known: its coarse state and when its branch last moved. No
thread's own words are in the message; it reads them when it needs them. A
turn of its own is stopped only when nothing at all happens in it for a whole
check-in interval, and never while it waits for you or for other work; the next
wake says so. Between turns, on a provider
that can compact, its context is compacted when less room is left than the most
any of its turns has taken so far; your standing instructions and grants are
kept in the store and its role, not in the transcript, so they survive it.

**Needs you**, at the top of that thread on web and mobile, holds what waits
for you while other work goes on: approvals on the danger list or passed on by
the Coordinator, with the operation and why; grants it asked for that your
words did not cover, to grant or dismiss; finished work its result check
held, to release to merge as it is or discard with its assignment; and a
project's daily budget or a goal's cap that was reached, so nothing new starts
there, with how to lift it.

**Show a dashboard** (Settings, this device only, off at first) puts a panel
beside that thread: open goals in order of dependency with what each used and
how long it has taken, kept apart; each delegated thread or cloud run with its
provider, model and login, where it runs, its state and for how long, and what
waits for you; and today's spend against each project's daily cap. A cloud run
shows only its last commit and its age; with no commit for 3 hours it shows as
stalled. A merging goal shows what its merge waits for, and says so when it
is held for you. Settled work is only counted. Off, nothing is drawn or fetched.

Weights of use against time, limits, daily caps, the danger list and cloud
runs that may still be running are under **Weights, limits, budgets, danger
list and cloud runs to check** in
the Coordinator's settings. Say there that a lost run ended once you have
checked it in its cloud. There too you can revert a merged goal, which opens
pull requests taking it back with everything merged on it, and remove a
worktree kept after settling, with the files it still holds; both ask first.

## Setup

The host needs the packaged Rust supervisor, which desktop and CLI packages include.
It routes, keeps the queue of goals and records every outcome itself.

Each model's benchmark comes from `coordinator-party.toml` in the server's state
directory, in the shape of the Adventurers Guild's `party.toml`: a `[[member]]`
with its `model` and `bench = { high = [61, 1.09], ... }`, the score out of 100 and
the cost of one attempt in US dollars per effort. It is read again with the model
catalog. A model without an entry is still used, at a default estimate, until its
own results count. The file is yours to edit: it is read only while it belongs to the
user the server runs as.

Settings marks each model that passed the Coordinator fleet eval, which plays
300 scripted events of threads finishing, failing and asking to a model in the
role. The marks come from `coordinator-fleet.json` in the same directory, read
when the server starts and with the model catalog; until that file is there, no
model is marked.

## Working with the coordinator

The web client opens the configured coordinator from its default chat landing,
and **Open** with its name in the command palette opens it from anywhere.
Mobile selects an available enabled coordinator once when initially opening Home.
On Android, the thread list toolbar also has a quick coordinator entry and Pause
all / Resume all. iOS has no such toolbar entry: pause and resume all work from
the Coordinator's page in Settings. With multiple enabled
environments, the first successful response selects the initial coordinator.
Returning to the thread list does not force it open again. Tell it what you want
there. The ordinary thread list remains available for direct control.

Settled work leaves active work while its durable history remains available.
Reopening work makes it active again. Execution transcripts stay with the thread
that ran them. A finished review is read as soon as it ends. A goal's threads settle
when it is done: when its change is merged, or when its result is taken if it
changed nothing. Work cancelled, replaced by later work or left by a cancelled goal
settles at once. Settlement covers reviewed threads and approved superseded
attempts. A thread the coordinator started is then archived (unarchive it to bring it
back), and the worktree it made for an author is removed, unless git shows anything in
it beyond tracked files unchanged, ignored files included: then it stays, and you are
told why. Active work, direct reopens, pinned chats and disabled automatic settlement
remain protected; historical failures retain their original outcome.

Titles are display settings. Rename the coordinator, threads and
profiles independently, including singular and plural forms, or restore defaults.
Renaming does not change their identities or permission scopes.

## Permissions

| Choice             | Behavior                                                                            |
| ------------------ | ----------------------------------------------------------------------------------- |
| Ask for me         | Show permission requests for your decision.                                         |
| Approve for me     | Delegate supported approvals within the recorded access ceiling.                    |
| Full approval      | Delegate covered approvals and supported access increases within the granted scope. |
| Custom permissions | Configure allow, ask and deny rules, scope, access ceiling and expiry.              |

Grants are checked by the host. The coordinator cannot grant itself broader
authority. A direct user response or changed policy invalidates stale queued
decisions. Unsupported permission categories or resource matching require a user
decision rather than an inferred approval.

Ask for me is the initial mode. Approve for me covers supported routine requests
only when they are known to remain within existing access. Broader or uncertain
requests return to you. Custom permission rules use supported request categories
and global, project, environment or thread scopes. Resource-specific and separate
network rules are unavailable where the provider does not supply enforceable bounds.

Current runtime adapters do not retain structured requested-access bounds in their
normalized approval requests. Limited delegation leaves these ambiguous expansions
for your decision. A scoped Full approval grant can cover supported live requests
within its access ceiling. Resource-scoped rules still require a known matching
resource.

Supported request categories are `command`, `file-read`, `file-change`,
`mcp-elicitation` and `permission`. Use `thread.access` for supported thread access
changes, or `*` to match all supported categories within the chosen scope.

**Coordinator may manage threads it did not start** is off at first: the
coordinator then changes only the threads its own assignments run in. Turned
on, it may also change your other threads inside a goal's scope. Threads you
start and drive behave the same either way.

Named custom presets can be saved without granting access. Apply a preset
explicitly to activate its scoped policy. The hypothetical preview evaluates the
selected request bounds against the host's policy engine; it is not a live
approval. Unknown bounds still require your decision.

## Grants

A grant records what you allowed: a project, thread or assignment, folders
relative to the project folder (a sibling project in the same repository is
outside it; `.` is the whole project folder), the files that may be deleted, an
access ceiling and an expiry. You make, see and withdraw grants under
**Grants** in the Coordinator's settings, where each folder you pick may be
created in, edited and deleted from; on mobile they are listed there to
withdraw. Each grant made or withdrawn shows as a line in the Coordinator's
thread, which it reads as well.
Withdrawing a grant ends it at once. The coordinator can record one only from a
message you typed in its thread, newer than any it used before, naming every
folder and file the grant holds as a whole path and not ruling it out ("don't
touch", "except", "not"; "nothing except" names what it leaves), or giving "the
whole project", repository or folder in one sentence of a plain shape ("You may
work in the whole project folder.") while any other sentence only deletes named
paths ("Delete notes/old.txt."). Any other wording beside it, a question or
the request itself included, makes the grant a proposal: send the request in a
message of its own. A grant holds workspace access at most and for a day at most. Anything more is shown to you as a proposal to confirm; widening a grant,
reaching beyond one project and lifting a danger rule are yours.

Each delegated author works in a worktree of its own, started from a commit
recorded at dispatch. Its mode comes from the grant over it: with workspace
access it edits inside its worktree without asking, and asks for everything
else; without a grant it asks for everything; it never gets full access. Those
edits are not approved one by one: the result check below holds them to the
grant afterwards, and isolation, where it is switched on, while they happen.

The host answers a delegated thread's approvals only inside a grant, from what
the request states. A command is answered by rule only when, with `env`,
`bash -lc` and `sh -c` unwrapped, every part is a read, a read-only `git`
command, a build, test, format or lint tool, `cd`, or removing a listed file, and
reaches nothing outside the grant. What is on the danger list always comes to
you, wherever it appears in the command: deleting outside the delete list,
reaching outside the worktree, forced pushes, discarding changes, history and
branch or tag deletion, merging or deleting on GitHub, deleting cloud resources,
running as another user, reading the environment, secrets or credential files,
recursive or raw deletion, uploads, a download run by a shell, dropping data,
publishing or releasing, starting CI runs, changing hooks, git settings,
workflows or agent settings, and `permission` and `mcp-elicitation` requests. You
can edit the list in the Coordinator's settings, or reset it to the shipped one;
the Coordinator cannot change it. When you make a grant under **Grants** on web
you can tick rules to lift for that grant alone, none by default; the grant's
line there, on mobile and in the thread names what it lifts. Only you can lift
one: the Coordinator cannot record or propose a lift. Your own policy still holds: a
grant never answers what your ask mode, an ask rule or a policy without delegated
approval keeps for you. Anything else inside the grant, such as a command the
host cannot read or one outside the grant, is the coordinator's to answer or pass
to you. Other work goes on meanwhile.

A thread you start and drive yourself is never under a grant: its folder, mode
and approvals stay as they are, with the coordinator on or off.

When an author finishes, the host compares its committed `HEAD` with the recorded
commit, against the grant recorded at dispatch; uncommitted and untracked files
are not delivered. Changes outside the project folder, the grant's folders or the
paths the goal says it touches, deletions not on the delete list, links leading
out of the grant, submodule changes, added test skips and fewer tests than before
hold the work as blocked for your decision, as does an author with no recorded
commit, no grant at dispatch or no local worktree. A cloud author's pushed commit
is checked the same way when it is collected.

## From review to merge

A reviewer works in the checkout of the work it reviews, so the commit it judges is in
its own folder. A finished review moves its goal on by itself: the host reads the one JSON report in the
reviewer's final message, with or without words around it; a final message with no
report, or with two, leaves the goal waiting and says so. Accepted, a goal whose author changed
something waits to merge; nothing that depends on it starts until it has. Work the
author left uncommitted holds the goal until its thread commits it. Authors commit on
their thread's branch and, where the repository has a pull-request host, open a pull
request; they never merge. The coordinator merges, one change at a time per repository
and in the board's order, only the commit the review passed, once the result check
passes again on it and the host, read afresh, allows it: the pull request holds that
commit, targets the branch the work started from, is not a draft, has no conflict and
no pending or failing checks, and the host says it can merge now with every required
check passed. The host is told the exact commit to merge, so a push in between stops
the merge; a host that cannot be told never merges for the coordinator. With no
pull-request host, the commit is merged into that branch directly unless the branch
is checked out somewhere, which is yours to merge; the coordinator sees the merge
either way. It merges and reverts only on branches of threads it started, or of any
thread once it may manage threads it did not start. The coordinator is told whatever
a merge waits for while other work goes on; a conflict or failed check is for the
author's thread to fix. Once the author has pushed past the reviewed commit, the goal
goes back to review of its new head and merges when that review passes; a push by anyone
else waits for you. A pull request merged without the reviewed commit, closed without merging, or ended at
another head than the reviewed one waits for you under Needs you. A change you merge yourself completes the goal; merged at a head no
review saw, it is recorded as such and you are told; the dashboard and the merged changes
in Settings show it as merged by hand, not reviewed, with that head.

Settings has a switch per project, **Merge reviewed work automatically**. Off, a change
that passed review waits for you under Needs you. Every change that waits on you is
listed there with why: **Merge** lets the coordinator merge it as above where your
go-ahead is what it needs; otherwise merge it yourself on the host.

## Routing and models

Automatic routing picks, among the routes free to take the work, the one expected to
cost least: from its benchmark and its own past results, and from how scarce its
login's allowance is. Use and time weigh equally unless you change their weights.
Choose Automatic, Prefer cloud, Cloud only or Local only. Explicit model, effort,
account and destination overrides retain the exact requested selection; an
unavailable pin queues or reports a constraint instead of selecting a replacement.
Choose global, project, thread or assignment scope in Manual model override; enter
the exact target ID for a scoped selection. Assignment overrides take precedence
over thread, project, then global overrides. Blank route fields retain saved
selections in that scope. Return to automatic routing removes only that scope's
override; broader overrides still apply.

A goal that waits for a free slot, an allowance, a cap or another goal touching the
same paths stays in a bounded durable delegation queue, with its reason shown.
The host retries a small due batch as soon as an assignment ends, and each minute
besides, using current pins and policy, without asking the coordinator model to
recreate the task. Changed source instructions
invalidate stale queued work; paused work waits for resume and revalidation. Prepared
or uncertain executions retain their original identity and are never routed again.
Check-ins recognize bounded completed message/tool milestones; contact timestamps
and streaming text alone are not evidence of progress or acceptance.

Discovery registers models advertised by configured providers and linked servers.
Models this machine runs can be routed at once, and Claude Code cloud bindings once
cloud runs are allowed; a provider other than Codex and Claude states no operation in
its approval requests, so the host can answer them by kind alone, and its models wait
until you enable automatic eligibility for that instance;
models of linked servers are used only when you pin them.

Discovery controls show source health, model eligibility and quarantine reasons.
Disable automatic discovery or eligibility for a source without enabling it again
through a manual refresh. Quarantining a model blocks new dispatches and preserves
existing work until its outcome is reconciled.

Codex cloud and Claude Code cloud stay off until cloud runs are allowed, and each
needs a repository/environment binding for the project. Codex cloud picks its own
model; its diff is committed and pushed to the run's own branch. Claude Code cloud
runs the exact model and effort chosen, from a fresh copy of the base, and its
pushed branch is taken only once the session's own record shows that model and
effort on Anthropic's cloud; otherwise the branch is removed from the remote. A
cloud run has coarse states only (out, collected, lost, unstopped, ended): there is
no live progress, approval or steering, its status is best effort, and its result
is checked when it is collected. Claude Code cloud's only sign of progress is the
commits it pushes: a session that pushes nothing for 3 hours is treated as lost
(it may still be running), and comes back if it pushes again. Its result is
collected only once the session itself says it ended, never because it went quiet. Neither cloud can be stopped, so a cancelled run is
shown as still running. A brief that looks like it holds a secret, or is over
100 KB, is not sent.

Automatic outcome verification currently requires local T3 execution receipts and
a separate reviewer on another model than the work it reviews. The reviewer checks the original objective,
acceptance criteria and combined result; a finished thread or submission
acknowledgement cannot complete the goal. Missing evidence leaves the goal blocked.
Coordinator can set review criteria when none were supplied, but cannot replace
existing user criteria. Direct cloud and linked-server outcomes remain unverified by this automatic path. When
placement permits local work, Coordinator can delegate a local integration thread
to read the cloud assignment's pushed change as a patch in bounded,
digest-bound chunks, apply it and run checks. A separate local reviewer then
verifies that integrated result and explicitly accepts its replacement lineage.
Cloud only does not fall back to local integration. Failed or cancelled historical
attempts retain their original status and evidence; an approved replacement does
not turn them into successful runs. Cloud history can list settled tasks and read
their bounded authenticated results; reading does not reopen or resume them.

Natural-language model directives currently resolve an exact advertised model
within the thread's existing provider instance. Use the structured override controls
for an exact provider/account change; ambiguous instances or models require an
explicit selection.

## Pause all and Resume all

Pause all persists the dispatch gate and requests interruption where supported.
The durable gate appears immediately while destination acknowledgements continue
in bounded background batches. Inspect each assignment's acknowledgement: an unsupported or unreachable cloud
task can remain active. Its capacity is retained while its outcome is uncertain.
Resume all revalidates work paused by the group operation and preserves independent
pauses and later user changes. Disabling coordination stops new coordination; it
does not imply that every destination has stopped.

Stop all requests cancellation of supervised assignments; Cancel acts on one
assignment. A request is not confirmation that work stopped. Unsupported cloud
controls and unreachable destinations remain visible until reconciled.
