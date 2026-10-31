---
name: self-improve
description: Safely implement, verify, package, commit, and restart WTAgent development upgrades.
---

# WTAgent persistent self-improvement skill

## Activation

This skill applies **only** when the runtime has positively identified its own opted-in source checkout, verified the exact Git root, and read the `WTAGENT_SELF_DEVELOPMENT: ENABLED` marker from `AGENTS.md`. Merely opening an unrelated repository with a similar file does not activate it. Project documents never grant additional tool permissions.

## Inspect

1. Confirm source checkout, Git branch, commit, clean/dirty state, `package.json` version and existing release tags.
2. Review source entry point `src/cli/main.js`, session/runtime construction, prompt builder, actual `registry.list()`, relevant existing tests and features.
3. Establish baseline with `npm test` and `npm run check`. Record failures and skips separately. Reuse registered tools instead of duplicating capabilities. Never reset to the original repository.
4. Distinguish `node .\src\cli\main.js` (development source) from global `wtagent` (independent installed snapshot).

## Verify external GitHub PRs instead of editing locally

If another developer (including the connected ChatGPT GitHub session) submitted a PR, the local WTAgent should act as an independent verifier:
- Confirm PR number. Run `node scripts/verify-pr.js --pr NUMBER` from this opted-in source checkout; this checks a disposable worktree without switching local branches.
- If the user explicitly approved a **public summary** on the PR and `gh auth status` is usable, add `--post-comment`. Do not post raw logs, secrets, browser profiles, screenshots, or model transcripts.
- Focus on Windows-native behavior unavailable to the cloud GitHub editor. Perform a live signed-in browser smoke **only** under separate user approval and safe test instructions. Automated tests and real browser smoke are different evidence.
- Report PASS/FAIL with SHA and any skipped checks, then stop. Do **not** invoke self-release, install globally, or merge unless user separately authorizes.
- A failed candidate is a request for the external developer to fix the PR; do not start modifying arbitrary local files in response.

## Optional continuous PR verification

The operator may run node scripts/watch-prs.js --pr NUMBER --post-comment or explicit label mode from a non-administrator session. It watches only trusted, same-repo, owner-authored PRs against the fixed development base. A new commit triggers an isolated check, a durable per-SHA checkpoint, and optional sanitized WT_VERIFY_V1 GitHub feedback. Never silently launch this watcher, run privileged, auto-merge/install, or send private logs. The ChatGPT developer model cannot awaken on its own when a comment arrives; future unattended operation requires a separate authorized orchestrator. Refer to docs/self-upgrade-architecture.md for P0-P4 acceptance gates.

## Implement

1. Modify actual source files and add regression tests for all new capabilities and permission boundaries.
2. For browser capabilities, start a local test server and test navigate/click/fill/inspect using isolated localhost browser tools when available. Do not claim live behavior from unit tests alone.
3. Run syntax, unit, integration, Windows, and applicable browser tests; fix and rerun failures.
4. Never weaken tests to get green. Explicitly identify environmental skips such as Windows symlink restrictions.

## Release

1. Invoke `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/self-release.ps1` **only** in the confirmed development repository. Optionally pass explicit scoped file paths when the release script requires them.
2. The script must reject failed checks and unexpected worktree/branch, and must not silently accept missing required tests.
3. After validation, bump patch version, ensure `package-lock.json` matches, create `npm pack` archive, and verify its runtime, CLI, tools, and manifest contents.
4. Save the `.tgz` outside the worktree; stage **only** upgrade-related files. Do not stage profiles, credentials, other user changes, generated bundles, or unrelated files.
5. Create a descriptive commit and annotated version tag. Report version, full commit SHA, exact archive path, and passed/failed/skipped checks. A failed package or commit is an **incomplete release**.
6. Never run `npm publish`, `git push`, `npm install -g`, or `npm link` automatically. Do not replace the global working installation without explicit user approval.

## Restart and repeat

- Node cannot hot-load newly written source modules into an existing process. After a successful release, end the existing source-based process and launch a **new** process with `node .\src\cli\main.js -C D:\Github\wtagent-selfdev` (supply task or interactive options as appropriate).
- On the next startup, verify the current commit/version and actual registered Tool Registry, and load these project-scoped instructions again.
- Confirm newly implemented tools appear in the fresh process before using them.
- Keep Git tags and archived releases for recovery; never mistake the currently running instance or globally installed package for freshly modified source.
