# WTAgent: developer-model + Windows executor self-upgrade architecture

## Decision

The model is the developer/planner: it reads the GitHub repository, writes reviewed code changes as PRs, and evaluates verification feedback. Local WTAgent is the executor/verifier: it runs commands, browser/desktop automation, checks, and machine-readable reports on Windows. GitHub stores the durable task and revision identity between the two. GitHub Issues are currently disabled in this repository, so the first persistent task backlog is docs/autonomy-tasks.json; Issues may be used if enabled later.

Never require the running Supervisor to rebuild or validate its own replacement binary. Local verification runs in a separate Node process, using an unprivileged OS account.

## Control plane and data plane

| Component | Owns | Must not own |
| --- | --- | --- |
| Developer model | Goal decomposition, patch, PR, tests, next patch | Claiming Windows commands ran without evidence |
| GitHub | Versioned task manifests, PR SHA, review, verification comments (Issues optional) | Secrets, browser profiles or raw device logs |
| PR watcher | Poll approved PRs, verify exact new SHA once, checkpoint, report | Merging, releasing, browser login or auto-upgrading |
| Local Supervisor | Worker lifetime, retries, tool orchestration, cancellation, checkpoints | Autonomous security exceptions or model decisions |
| Verifier | Syntax/unit/integration/Windows tests, package dry-run; approved live smoke | Auto-approving its own code |
| Operator | Authorization for first-time permissions, live account interactions, merge/release | Copy/pasting test logs every iteration |

**Trust boundary:** A Git worktree is NOT an OS sandbox. npm test executes code. PR watcher accepts only PRs authored by Demonf00, sourced from Demonf00/wtagent branches and targeting feat/self-extension, and only within the explicitly selected PR or label scope. Run it with a non-administrator account. A label explicitly marks a PR for unattended local verification.

## PR watcher (first closed-loop primitive)

Start a long-lived verifier independent from WTAgent Supervisor:

    node scripts/watch-prs.js --label wtagent-verify --post-comment

Or restrict to one trusted PR:

    node scripts/watch-prs.js --pr 9 --post-comment

To run only a single scan:

    node scripts/watch-prs.js --pr 9 --once

Requirements: Git CLI, Node/npm, authenticated gh CLI, and the opted-in WTAgent source checkout. Use gh auth status. --post-comment is opt-in; without it, results stay local.

For each candidate:
1. Query PR metadata. Reject forks, untrusted authors, changed base or closed/draft PRs.
2. Pin head.sha; a moved PR head must not be tested as the old candidate.
3. Check durable AppData/wtagent/pr-verifications/watch-state.json mapping {pr to verified SHA}. Identical SHAs are not retested on every poll or after restart.
4. Run existing verifyPullRequest in a disposable worktree. Stop on failing checks.
5. Save local logs/JSON, optionally post a sanitized GitHub PR comment. It starts with marker WT_VERIFY_V1, with the exact SHA and PASS or FAIL status.
6. On a failed test, do not repeat the same commit forever. Wait for the developer to push the next SHA.
7. Never auto-merge, auto-release, auto-install, clear ambiguous outbound checkpoints, or bypass a browser challenge.

The initial watcher polls at a minimum 15-second interval. Label scanning currently reads the newest 100 open PRs; add pagination before large-repository deployment. Full logs remain in local AppData; GitHub comments contain only test counts, status and SHA. If feedback posting fails, the local checkpoint records a feedback-failed status for explicit recovery; it does not repeatedly re-execute the same SHA.

## Optional local source sync after verified merge

The verifier does NOT pull a passing but unmerged PR into the development checkout. Once an authorized GitHub merge has happened, the watcher may use the optional `--sync-after-merge` flag to update a clean checked-out `feat/self-extension` branch by exact fast-forward. It verifies: the merged PR's head matches a locally passed SHA; author and repository are trusted; the GitHub merge commit is exactly the remote branch HEAD; the local branch is correct, clean and the merge commit directly follows local HEAD. Any mismatch halts without overwriting, rebasing or installing. This updates only local source files. Long-running Worker/Watcher processes still require a separately controlled restart to load new code. It does not authorize auto-merging PRs.

## Development state machine

The canonical initial task registry is docs/autonomy-tasks.json, rather than GitHub Issues (disabled in this repository). Its entries define ID, dependency graph, owner, risk and acceptance checks; no runtime consumes or updates it automatically yet.

- TODO: acceptance criteria written
- READY: approved scope and dependency order
- IN_PROGRESS: developer implements
- VERIFYING: PR pushed; SHA under Windows verification
- FAILED: evidence/comments require revision
- VERIFIED: automated checks pass (not necessarily browser smoke)
- ACCEPTED: human accepts risk, merges or releases
- BLOCKED: missing environment/credentials/ambiguous action

The next independent task may start after the previous one is VERIFIED, but must not silently ACCEPT, merge or deploy changes.

Each planner task must include observable outcome and artifacts, allowed workspace/tools, reproduction, acceptance checks including negative case, bounded budgets, dependencies, risk category and whether approval is required.

The verifier produces only observable facts: SHA, commands run, exit statuses, test pass/fail/skip counts, smoke run/not run, sanitized diagnostic code. A model cannot mark work done solely from explanations.

## Priority and acceptance gates

### P0 Runtime Reliability — prerequisite

Retain unique outbound IDs, exact target bindings, durable tool-call/result acknowledgements, and bounded retries. Classify transport disconnect, provider challenge, malformed XML, uncertain send and incomplete tool-result acknowledgement. Keep raw payloads local; redact credentials. An ambiguously submitted message/tool result must fail closed and never be replayed blindly.

Gate: deterministic tests for assistant/tool/result boundaries, lost IPC, restart-before-result, duplicate callbacks, cancel/pause and recovery; plus repeated native Windows browser runs.

### P1 Supervisor CLI — largely integrated

The CLI already delegates to Supervisor by default, with --legacy escape hatch. Keep isolated Worker/watchdog and prove pause/resume across crashes. Gate: no duplicate browser messages, no orphan Worker, no swallowed cause code, durable task states.

### P2 Planner + Checkpoints — next core capability

Planner outputs a task DAG with explicit acceptance criteria. Executor executes one child at a time; Verifier records actual evidence; only then advance. Store task state in durable JSON/SQLite with atomic compare-and-set, hashes for completed artifacts, and idempotency keys for side-effecting operations.

Gate: one high-level goal creates at least three dependent tasks; process restart continues from last committed checkpoint without redoing successful tasks or declaring failure to be success.

### P3 Context management + rotation

Track prompt size and model-turn cost estimates. Summarize only persisted task facts/artifacts, never replace canonical results. Rotate conversation only when pendingOutbound, pendingAssistantTurn, pendingAuxiliaryTurn and tool acknowledgements are clear. Pass concise context manifest with goal, current task, source SHA, accepted checkpoints, open hazards and next action.

Gate: multi-conversation execution of a project without losing a checked result or replaying a side effect.

### P4 Self-repair + durable service

Classify crash, run deterministic diagnostics, produce fix PR, verify Windows candidate, then request approval. Supervisor/Verifier stay on last-known-good installation; rollback by exact approved version. Add heartbeat, alerting and budget limits.

Gate: deliberately broken candidate is rejected, healthy version remains operational; repair PR passes and still requires approval before installation.

## What is not autonomous yet

This initial implementation provides the local watch/verify/report loop only. A ChatGPT conversation with GitHub access does NOT run continuously or wake itself when a PR comment arrives. A separate developer-orchestrator (API-driven service or explicitly available agent service) must consume WT_VERIFY_V1, invoke the developer model, and push the next change without a human chat input. Until that exists, a user or separately authorized workflow triggers the next developer turn.

Avoid browser UI automation as the long-term control plane for the developer model; use a supported API or connected GitHub-capable agent. Keep explicit limits for time, cost, permissions and side effects.
