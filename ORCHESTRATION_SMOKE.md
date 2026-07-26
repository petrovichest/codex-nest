# CodexNest orchestration smoke report

- Date: 2026-07-26
- Commit: `f5b6261`
- Result: **PASS**

## Scope

The smoke run used two independent, read-only managed tasks. One audited the
client transition from a completed Plan to Team mode; the other audited the
server-side managed-task lifecycle. Only the parent coordinator created this
report after both child results were delivered.

## Client path

The client audit checked `implementPlan("team")` in
`apps/client/src/components/ThreadPage.tsx` and its tests.

- A completed Plan switches `collaborationMode` from `plan` to `team`.
- The implementation turn uses the message
  `Да, реализуй этот план в режиме оркестратора`.
- The optimistic message and `startTurn` share the same `clientMessageId`.
- A successful request accepts the optimistic message.
- A failed request removes it and attempts to restore Plan mode.
- Plan implementation actions are disabled while the latest plan has
  unresolved annotations.

Verification:

```text
NODE_ENV=test npm test -w @codexnest/client -- src/components/ThreadPage.test.tsx -t "starts a completed plan in orchestrator mode"
1 passed, 77 skipped
```

Observations:

- The focused happy-path test does not directly assert the optimistic
  add/accept actions, and the error-path test does not directly assert the
  optimistic removal.
- Restoring Plan mode is best-effort. If the rollback settings request also
  fails, the session may remain in Team mode while the original error is shown.

## Server path

The server audit checked the managed-tool handler, task creation and scheduling,
terminal notification handling, result claiming and delivery, and parent
continuation in `apps/server/src/api.ts`.

- Managed tool calls are accepted only for a Team parent session.
- `spawn_task` creates a child task in `queued` state.
- Scheduling advances tasks through `starting` and `running`.
- Child completion records one terminal result.
- The result is claimed, delivered to the parent continuation, and cleaned up
  after delivery.
- Failed parent continuation releases the claim so delivery can be retried.

Verification:

```text
npm test -w @codexnest/server -- src/api.test.ts -t "Team orchestration"
4 passed, 7 skipped
```

Observation:

- Runtime handling rejects managed tool calls outside Team mode, but direct
  boundary coverage for root tool visibility outside Team mode remains limited.

## Verdict

CodexNest successfully created two managed child tasks, ran them independently,
delivered both terminal results to the parent session, and allowed the parent
coordinator to synthesize this report. The tested client entry point and server
task lifecycle both passed their focused regression tests.
