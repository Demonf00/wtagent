# WTAgent autonomous delivery — final verification

## Reproducible checks

From a trusted checkout of the WTAgent repository, run:

```powershell
node --test test/autonomy-end-to-end-delivery.test.js
node scripts/verify-autonomy-end-to-end.js
npm run check
npm test
```

The dedicated SU-03 script runs the real integration tests, reads the local
roadmap, checks that every VERIFIED phase has an independent Git commit that
is an ancestor of the current checkout, and writes a private JSON report in
the operating system's temporary directory. It refuses missing phases, test
failures, or missing Git provenance.

## Tested end-to-end path

The single SU-03 integration test uses the actual TaskSupervisor and
TaskCoordinator with a temporary workspace and real Node test-based final
acceptance. It runs the first task, revises the DAG to include a new preflight
dependency, restarts the Supervisor, deliberately omits the second task's file,
verifies BLOCKED rather than a false success, requests the prepared repair,
runs the repair through the Supervisor, restarts again, completes remaining
tasks, and checks the durable final delivery receipt. It compares execution
counts to prove the original task and repair side effects were not replayed.
After a further Coordinator reload, it confirms read-only repeatability.

The script also runs these separately exercised integrations:

- CM-03: persisted cross-conversation rotation handoff and verified dependent
  task resume, with an invalid handoff rejected.
- FR-04: recovery after an injected crash during Supervisor repair submission,
  preserving the idempotency key and avoiding duplicated effects.
- DP-03: real Supervisor with revised DAG and process restart recovery.
- FV-06 / OB-03: actual behavioral goal verification and a delivery report
  which rejects invented success, missing evidence and tampered receipts.
- SU-01: intentionally broken candidate verification in a disposable Git
  worktree, without replacing trusted Supervisor code.
- SU-02: explicit approval, exact candidate SHA and archive-hash checks before
  any **recorded** promotion or rollback.

## Evidence and limitations

The SU-03 JSON report identifies the exact source SHA, test counts, successful
test titles, verified phase commits, and whether coverage came from the unified
scenario or a separate integration. A checkpoint/receipt is historical
consistency evidence, not a cryptographic signature or a guarantee of present
functionality. Verification of the same goal in a later environment must
recheck the relevant artifacts and behavior.

These are deterministic local integration tests with simulated Worker logic,
not live browser-provider checks, remote service tests, system-level security
sandbox verification, or production deployments. Git worktrees isolate file
versions but are **not** OS sandboxes. SU-02 promote/rollback changes a
persistent, human-approved *version pointer only*; it does not automatically
merge, install, release, publish or restart any Agent. The candidate verifier
also explicitly reports skipped live checks.

The final roadmap has an independently verified code commit for every phase.
Use the roadmap's commitSha and testEvidence fields to reproduce or audit
individual deliverables.
