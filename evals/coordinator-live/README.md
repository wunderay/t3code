# Coordinator live

Runs the Coordinator against a real T3 Code server, from the owner's request to the board, and grades what the host recorded. Where [coordinator-fleet](../coordinator-fleet/) scripts the host, this one scripts nothing of it: the server, its store, its rules, its wakes and its tools are the real ones.

Each case starts one isolated server (`serve --base-dir` in its own folder under `--out`) on a fresh toy repository, a small Node library with tests, and switches the Coordinator on. The Coordinator's own thread runs on a puppet provider (`puppet.mjs`, an ACP CLI with no model), so the player is its model: it gets each turn's text exactly as the host sent it, which holds the role's rules, and the tools exactly as the host's MCP endpoint lists them, and its tool calls run against the host with the thread's own credential. A simulated owner scopes goals, gives folders in a message of its own once a goal is planned (the whole project, or in the control case the whole project except docs), merges what is held for them (main is checked out in their working copy) and answers approvals, as each case says. The server is stopped by its PID at the end of each case, also on failure, at the time limit and on Ctrl-C.

Checks read only the boards the host pushed during the run and the toy repository at the end, never the model's words.

## Run

```sh
vp i                                   # at the repo root
(cd apps/server && node scripts/cli.ts build)  # the server, web client and supervisor, about a minute
cd evals
pnpm coordinator-live --out runs/live --model scripted
pnpm coordinator-live --out runs/live --model claude-sonnet-5-5 --case request-to-merge
pnpm coordinator-live --out runs/live --model qwen3-coder --base-url http://localhost:8000/v1 --api-key-env LOCAL_KEY
```

- `--model`: `scripted` plays the known-good path with no model, free and offline. Any other id is a model behind an OpenAI-compatible chat API, as in coordinator-fleet: by default the `vibeproxy` provider in `~/.codex/config.toml`, or `--base-url` with the key in the variable `--api-key-env` names.
- `--threads scripted` (default): delegated authors and reviewers run on the puppet too, played by a fixed script (the author commits a real change in its worktree, the reviewer reports a pass), so only the Coordinator's model is paid. `--threads real`: they run on the installed Claude provider, which must be signed in.
- `--case <id>` (repeatable), `--max-steps` (30 model calls a turn), `--time-limit` (minutes a case, 5 scripted, 45 real), `--server <bin.mjs>` (another build of the server).

A run writes `results.json` and `summary.md` to `--out`: per case passed or failed, the failed checks, turns, model and tool calls, tokens, seconds and how it ended. Each case's folder keeps the server's state and log, the toy repository, the transcript and the facts it was graded on.

## Cases

`cases.ts` holds them: the owner's message, what the owner does, the thread modes the scenario can be produced in, and the checks.

| Case                            | Threads        | Checks                                                                                                                                                        |
| ------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `request-to-merge`              | scripted, real | The whole project granted from the owner's words, a reviewer passed the change, its merge merged, the change on main, tests pass, nothing waits on the owner. |
| `approvals-in-grant-and-danger` | real           | An unparsed approval inside the grant answered by the Coordinator; one on the danger list waits on the owner, unanswered.                                     |
| `unread-approval-to-owner`      | scripted       | An approval the host could not read goes through the Coordinator to the owner, and the work goes on after their answer.                                       |
| `whole-project-ruled-out`       | scripted, real | Control: words that limit the whole project leave no such grant in force, only a proposal to the owner.                                                       |

The puppet speaks ACP, which states no operation in its approvals, so the host answers them by kind alone: none is unparsed and none matches the danger list. That is why the in-grant and danger approvals run only with real threads, and `unread-approval-to-owner` is what the scripted threads produce in their place. With real threads, whether a thread asks for something outside its worktree is up to that thread; the owner's message asks for it.

To add a case, add an entry to `CASES` with its source, and a test in `run.test.ts` that its checks fail on the bad outcome. Run it with `--model scripted` first; the scripted player in `scripted.ts` may need the new path.

## Cost

With `--model scripted --threads scripted` a run is free: about a minute for all cases. With a model, a case is 3 to 10 turns of a few calls each, on the Coordinator's context of about 10,000 tokens and growing. `--threads real` adds the Claude threads' own turns, minutes and dollars a case. Start with one case.

## Not covered

Cloud runs, a pull-request host (the toy has no remote, so every merge is the owner's by hand), compaction of the Coordinator's context, a Codex or Claude provider holding the Coordinator's own thread, and questions from threads (ACP asks them as user input, which the scripted threads do not play).
