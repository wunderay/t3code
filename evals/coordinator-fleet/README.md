# Coordinator fleet

Plays a scripted fleet to a model holding the Coordinator role, and scores how it runs it. This is what "any model can hold the Coordinator" rests on: Settings marks a model only once it passed here.

The model gets T3's own text and tools from source: the role's rules, `coordinator_playbook`, the Coordinator's tools with `t3_thread_read` and `t3_pending_request`, and each wake as the host writes it. A scripted host answers the calls. Its threads stand in for Replay threads: they finish, fail, hit a merge conflict, ask a question and ask for approval, and their reviewed work waits to merge, is held for the owner, merges and now and then is reverted, in an order the seed fixes, so every model plays the same script. Its inbox works as the store's: read with no cursor, it goes on from what this turn and completed turns read, and a turn the host stops (at `--max-steps`) completed nothing.

## Run

```sh
cd evals
pnpm coordinator-fleet --out runs/fleet --model claude-sonnet-5-5 --model gpt-6.1-terra
pnpm coordinator-fleet --out runs/local --model qwen3-coder --base-url http://localhost:8000/v1 --api-key-env LOCAL_KEY
```

- Any model behind an OpenAI-compatible chat API: by default the `vibeproxy` CLIProxyAPI provider in `~/.codex/config.toml`, or `--base-url` with the key in the variable `--api-key-env` names.
- Flags: `--seed` (1), `--events` (300), `--fresh-every` (3: every third wake starts from an empty transcript, as after a compaction), `--max-steps` (12 model calls a turn), `--results <file>`.
- Cost: one run is about 150 wakes of a few calls each per model. Start with `--events 20`.

## Score

Each event is correct, wrong or missed; the turn its wake announced it must act on it.

- A finished author needs its review delegated: `role` `reviewer`, `reviewSubjects` naming it.
- A failure or conflict needs a repair of the same goal that supersedes the failed assignment and names the failing test or conflicting path.
- A question needs the option the owner's standing instructions settle, and no other.
- An approval inside the grant that the host could not read needs `allow`; one outside it `owner` or `deny`; one on the danger list nothing.
- A merge waiting on something the author can fix (a conflict, a failed check, uncommitted work) needs a message to its author's thread that says rebase, names the check, or says commit, as a plain instruction with nothing beside it that could condition or withdraw it, so extra context is graded wrong (one text sent for waits with different causes is wrong for each); one that only takes time, or waits on the author still working, needs nothing. The author's fixed work then comes back as finished and needs its review again; a missing re-review is missed.
- A revert needs the work planned again as a new goal that says it was reverted and what went wrong; it is answered once that goal is delegated, once.
- Verified work, a merge, a merge held for the owner (someone else's push past the reviewed commit among them) and a hand merge no review saw need nothing; a message or delegation for any of them is wrong. A delegation or a message no event asked for is wrong.

Refused calls (an unknown tool, arguments the schema rejects, what the host refuses) are counted apart. A model passes with no event missed and none wrong.

A run writes one result per model, `summary.md`, and `coordinator-fleet.json` (or `--results`): each run's model, seed, settings and counts, keeping earlier runs of other models or settings. Copy that file into the server's state directory, next to `coordinator-party.toml`. Settings marks a model when every run of it at least as hard as the default (300 events, a fresh context every 3 wakes, 12 steps a turn) missed nothing and answered nothing wrong; a smoke run such as `--events 20` marks nothing.

`fleet.test.ts` runs the harness offline with scripted models: one that follows the playbook scores perfectly through the fresh contexts, one that reads the inbox from cursor 0 acts twice, a silent one misses every event, and one that allows every approval is wrong on each outside the grant.
