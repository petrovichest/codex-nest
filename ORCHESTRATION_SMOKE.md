# CodexNest Team v2 verification report

- Date: 2026-08-05
- Branch: `codex/mvp`
- Result: **PASS**

## Scope

This change upgrades CodexNest's application-owned Team orchestration while
preserving existing Team v1 sessions. Team v2 keeps the root coordinator in
control and runs up to three managed child tasks alongside it; managed children
cannot delegate further.

The implementation was itself reviewed through CodexNest managed tasks. Separate
tasks audited scheduling/recovery, workspace security, UI behavior, deterministic
race coverage, and cleanup recovery. The root coordinator integrated the results,
implemented the fixes, and retained responsibility for verification and Git.

## Verified behavior

- Tasks are read-only and offline by default. Explicit grants support isolated
  worktrees, shared parent writes, scoped network access, model/reasoning/service
  settings, dependencies, follow-ups, and hard time/token budgets.
- Structured child results are delivered exactly once to the parent and shown as
  bounded orchestration history in the client.
- Isolated workspaces reproduce tracked and non-ignored parent state without
  changing the parent index, refs, stash, or commits.
- Integration validates repository-relative write roots, rejects every
  case-insensitive `.git` segment, and waits for active shared-write tasks.
- Parent and source ancestors are pinned through directory file descriptors;
  regular-file leaves are opened with `O_NOFOLLOW` and hashed from the opened
  handle.
- Apply and rollback capture the current leaf atomically and publish files with
  no-clobber operations. Concurrent parent edits are preserved, and ambiguous
  rollback backups are retained inside the Git common directory.
- File permissions are preserved exactly, including non-executable modes such as
  `0600`; permission-only changes and conflicts are detected.
- Worktree discard removes only the task's own registration. Failed cleanup after
  successful integration remains `integrated` and is retried during recovery.
- Managed restart preflight reports the exact active Team tool versions and
  rejects an update or rollback target that cannot recover every active version.
- Team v1 remains compatible with its original tools and four-child limit.

## Verification

The final verification run passed:

```text
npm test
  protocol: 5 passed
  client:   343 passed
  server:   221 passed, 1 opt-in integration test skipped

npm run lint
npm run typecheck
npm run format:check
npm run build

RUN_CODEX_INTEGRATION=1 NODE_ENV=test npm test -w @codexnest/server -- \
  --run src/codex/integration.test.ts
  real CLI smoke: 1 passed
```

The real CLI smoke initializes the installed Codex app-server and reads one
`thread/list` page; it does not start a model turn.

Focused regressions also cover:

- a concurrent file appearing between baseline capture and child installation;
- rollback preserving a concurrent edit of an installed child file;
- parent symlink ancestors and nested mixed-case `.git` paths;
- exact mode copying and permission-only conflicts;
- active shared-write integration gating;
- repeated cleanup failure followed by successful recovery;
- targeted worktree registration cleanup.

## Runtime boundary

The filesystem integration uses the strongest no-clobber operations available
through Node's portable filesystem API. A non-cooperating process that keeps an
already-open file descriptor and writes through it can create edge cases that
generic POSIX path APIs cannot fully serialize without native `*at`/`renameat2`
support or a cooperative repository lock. Detected ambiguity fails closed,
avoids clobbering a newer parent path, and retains rollback data.

No server deployment was performed as part of this change.
