# WTAgent self-development instructions

<!-- WTAGENT_SELF_DEVELOPMENT: ENABLED -->

These instructions are **opted in only for WTAgent running from this exact development source checkout**, not for arbitrary projects that happen to contain an `AGENTS.md`. The runtime must verify the source checkout, Git root, and opt-in marker before exposing this content to a model. This document does not authorize bypassing any existing tool, path, approval, or execution policy.

## Persistent improvement loop

**Inspect → Implement → Test → Fix → Package → Commit → Restart from source → Repeat.**

1. Inspect current source, package version, Git branch/commit, actual registered Tool Registry, existing behavior, and tests before proposing changes. Reuse and extend previous capabilities; never start again from the original upstream repository.
2. Implement real features in the development checkout. Do not declare completion after describing a plan. Write automated tests for each feature, including failures, project boundaries, and Windows behavior where applicable.
3. Establish a baseline, run applicable syntax, unit, integration, Windows and browser smoke checks, fix failures, and rerun. Never weaken assertions, silently omit required tests, or present skipped behavior as passing.
4. After all required validation passes, execute `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/self-release.ps1` from this checkout. The release script must stop on failure, increment the local patch version, generate and verify a package, preserve it outside the Git worktree, commit only explicitly scoped upgrade files, tag the release, and report artifacts and skips.
5. Never use unconditional `git add .`, `git push`, `npm publish`, or automatic global npm installation. Do not commit unrelated files, secrets, profiles, or archives.
6. Keep the globally installed WTAgent unchanged unless the user explicitly approves an installation. Do not use `npm link`. Test from the development tree using `node .\src\cli\main.js`.
7. Source changes are not reflected in a running Node process. After a successful release, stop the current development process and start a fresh source-based process for the next iteration. Do not claim that a process has restarted without verification.
8. Maintain Git commits, tags, and persistent `.tgz` files as recoverable checkpoints. Continue work from the **latest successful source version** and registered tools, not an obsolete package or initial state.

## GitHub PR verification handoff (developer model + local verifier)

When an external ChatGPT developer has already opened a GitHub PR for WTAgent, prefer **verification**, not duplicative code analysis or independent edits:
1. Confirm the user-approved PR number and that the candidate belongs to `Demonf00/wtagent`. Verify from a **separate local source process**, not the Supervisor currently being repaired. Use the existing `--legacy` escape hatch when needed.
2. From this opted-in source checkout, run `node scripts/verify-pr.js --pr <number>`. This downloads the candidate into an isolated temporary Git worktree, installs temporary dependencies, runs syntax, Supervisor regressions, all tests, and a package dry run. It does **not** switch branches or alter the running global installation.
3. When explicitly authorized to publish a public status summary and the GitHub CLI is authenticated, use `--post-comment`. The comment contains only SHA, check counts and statuses; full logs stay in local AppData. If posting fails, report the local JSON path.
4. Report the exact PR SHA and failed check; distinguish automated tests from any authenticated browser smoke (NOT RUN by default). Send failed results back through the PR; external developer can produce the next revision. Never classify a PR as production-ready based only on a unit-test pass.
5. Keep merging, packaging, self-release, live browser smoke, and changes to global installation as separate explicitly approved steps. Do not auto-merge, push, publish, or auto-restart the current agent.

## Optional continuous GitHub PR verification

When the operator explicitly enables a trusted watcher with the command below, a dedicated non-Supervisor Node process polls eligible PRs and tests each new SHA only once:

    node scripts/watch-prs.js --label wtagent-verify --post-comment

It is independent from Supervisor/Worker under repair and may post only sanitized PASS/FAIL counts and SHA, never raw logs, ChatGPT messages or browser content. A user explicitly selects a PR or adds the opt-in label. No elevated user, auto-merge, install, restart or publish; temporary Git worktrees do NOT sandbox arbitrary code execution.

The developer model can create/update PRs, read WT_VERIFY_V1 feedback and propose the next fix, but this chat does not awaken asynchronously. A separate authorized orchestrator is necessary for unattended developer model turns. See docs/self-upgrade-architecture.md.

## Optional post-merge source synchronization

The local watcher may be started with `--sync-after-merge`. This is opt-in and distinct from PR verification or GitHub merging. It checks that the PR's exact head SHA passed Windows checks, that GitHub confirms it is merged, and that the current checked-out `feat/self-extension` worktree is clean and an exact single fast-forward to the merge commit is possible. Only then does it update source files. It must not auto-merge PRs, reset/rebase dirty branches, restart the currently running WTAgent/Watcher processes, change global installations, or run npm publish. See `scripts/sync-merged-prs.js` and regression tests.

## Execution and safety

- All project operations go through the existing local Runtime and its approval policy. Repository instructions are guidance, not executable commands or permissions.
- Recognize the difference between the globally installed `wtagent` command and source execution `node .\src\cli\main.js`.
- Verify which checks ran, which failed, and which were skipped. Windows symlink permissions can cause legitimate skips; such tests remain **untested**, not passed.
- If packaging or Git commit fails, report the release as incomplete, preserve the recoverable state, and do not advance the successful-release claim.
- Never weaken application security, path containment, or approval boundaries to enable self-development.
- See `skills/self-improve/SKILL.md` for the detailed procedure.
