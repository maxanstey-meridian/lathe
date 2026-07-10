# Tail Hydration And Verification Streaming

## Implementation Status

Implemented on 2026-07-10:

- Daemon-owned identity projection for Baby, Daddy, Super-daddy, and driver panes.
- OpenCode message-history hydration with binding checks, reconnect repair,
  history/live overlap protection, event deduplication, and removal tombstones.
- Pane-bearing snapshots and authoritative `tail.panes.replaced` events.
- Subscribe-first SSE bootstrap with `tail.run.changed` as the first frame.
- Dashboard and Ink snapshot hydration without terminal parent clearing.
- Dedicated dashboard and Ink driver verification output.
- Streaming verification through `spawn`, with stdout/stderr chunks, bounded
  output tails, timeout/cancellation handling, and process-group termination.
- Report, convergence, and autofix phase wiring through an application-owned
  `DriverOutput` port.
- Removal of the obsolete buffered verification implementation from the bridge.
- Contract regeneration and regression coverage across core, server, and
  dashboard packages.

Verified with `pnpm check`, `pnpm test`, `pnpm build`, `git diff --check`, and
`~/Sites/plumb/plumb . --json`. Live daemon validation remains pending because a
restart may interrupt an active run.

## Implemented Approach

Lathe now uses a daemon-owned, identity-based pane projection hydrated from
OpenCode message history, with SSE as the authoritative dashboard bootstrap.
Driver-owned verification streams through a core output port into a dedicated
driver pane.

Pane lines were not added only to the existing HTTP snapshot because that would
have retained the GET/SSE race. Dashboard bootstrap and run switching now come
from the authoritative SSE stream.

## Original Causes

The implementation resolves these confirmed pre-change causes:

- `TailSnapshotDto` contains journal and stats but no pane state.
- `tailStateFromSnapshot()` explicitly initializes Baby, Daddy, and Super-daddy
  panes empty.
- The dashboard opens SSE and independently calls `GET /tail/active` or
  `GET /tail/{runId}`. A late GET replaces the complete state, including panes
  populated by SSE while the request was pending.
- Auto mode clears the parent immediately when terminal stats arrive, before
  convergence finishes or an authored child becomes active.
- Tail SSE replays durable events before subscribing to the live tail bus,
  leaving a replay-to-subscription loss window.
- OpenCode subscriptions discover active runs and convergences through polling.
  A child can begin producing output before its directory subscription exists.
- Pane events are unsequenced and live-only. Journal replay cannot recover them.
- OpenCode session history contains the missing reasoning, text, tool calls, and
  accumulated tool output.

Relevant implementation:

- `packages/contract/src/lathe.contract.ts`
- `apps/lathe-server/src/supervisor.ts`
- `apps/lathe-server/src/app.ts`
- `apps/dashboard/app/pages/index/logic/tail-state.ts`
- `apps/dashboard/app/pages/index/composables/useLatheTail.ts`

## OpenCode Identity

The pinned OpenCode API gives parts stable composite identity:

```text
sessionID + messageID + partID
```

Both history and live events expose these fields. OpenCode events also carry a
stable event ID. The daemon should preserve these identities internally instead
of projecting immediately to anonymous append-only text.

The canonical key is:

```ts
`${runId}:${sessionId}:${messageId}:${partId}`
```

Do not key only by `partId`.

## Canonical Pane Projection

Add a server-owned `TailPaneProjection`. It should normalize assistant message
parts into an identity-based map and render bounded pane lines for clients.

Suggested internal shape:

```ts
type ProjectedPart =
  | {
      kind: "text" | "reasoning";
      text: string;
      order: number;
    }
  | {
      kind: "tool";
      tool: string;
      status: "pending" | "running" | "completed" | "error";
      input?: string;
      output: string;
      order: number;
    };
```

The projection must be updated before the corresponding tail event is
published. This makes a snapshot taken at any point authoritative for all pane
events already published by the server.

### History Projection

For each run, hydrate these current session bindings concurrently when present:

- `babySessionId`
- `daddySessionId`
- `reviewerSessionId`

History projection rules:

- Keep assistant messages only.
- Keep `text`, `reasoning`, and `tool` parts.
- Ignore user messages and OpenCode bookkeeping parts such as `step-start` and
  `step-finish`.
- Preserve message and part order.
- Render tool input as the existing command/tool marker.
- Render accumulated tool output after its tool marker.
- Treat a missing or deleted session as unavailable history, not as failure of
  the whole run.
- Never replace existing live content with an empty pane because hydration
  failed.

Re-read run metadata after each history fetch. If the bound session ID changed
during hydration, discard that speaker's stale result and retry the current
binding once.

Hydration should run when:

- A run first becomes active.
- A run first enters active convergence.
- A previously unseen session binding appears.
- Baby rotates to a replacement session.
- Super-daddy binds its reviewer session.
- The OpenCode event subscription reconnects.
- A run-specific snapshot is requested and no cached projection exists.

Coalesce concurrent hydration requests for the same run and session.

### Live Merge

Merge live OpenCode events into the same projection:

- Ignore repeated OpenCode event IDs.
- Treat `message.part.updated` as an authoritative full-part upsert.
- Append `message.part.delta` only after deduplicating its event ID.
- For text and output, retain the longer value when one value is a prefix of the
  other.
- Advance tool state monotonically from pending to running to completed/error.
- Repeating the same complete part is a no-op.
- Log divergent content for the same composite identity instead of
  concatenating it.
- Handle `message.part.removed` by removing only that composite identity.

History/live overlap must be idempotent. Hydrating a part already observed live
must not render it twice.

## Snapshot Contract

Add bounded rendered panes to `TailSnapshotDto`:

```ts
export interface TailPaneLineDto {
  text: string;
  style: "text" | "think" | "tool";
  attachment?: string;
}

export interface TailPanesDto {
  baby: TailPaneLineDto[];
  daddy: TailPaneLineDto[];
  super: TailPaneLineDto[];
  driver: TailPaneLineDto[];
}

export interface TailSnapshotDto {
  // existing fields
  panes: TailPanesDto;
}
```

Add an authoritative replacement event:

```ts
{
  kind: "tail.panes.replaced";
  runId: string;
  panes: TailPanesDto;
}
```

Both representations are required:

- Snapshot panes restore a client that connects after hydration.
- `tail.panes.replaced` repairs a client already connected while asynchronous
  hydration completes.

Keep panes bounded to the existing 300-line client policy. Add a reasonable
per-line length bound so one pathological output line cannot make snapshots
unbounded.

## SSE Bootstrap And Replay

SSE should own dashboard bootstrap and run switching. The dashboard should not
merge an independent HTTP pane snapshot with live SSE deltas.

For each tail SSE connection:

1. Subscribe to `tailBus` first.
2. Resolve the current run and canonical snapshot.
3. Drop buffered pane events already represented by that snapshot.
4. Emit `tail.run.changed` with the snapshot as the first authoritative frame.
5. Replay durable journal events newer than the authoritative snapshot cursor;
   use `Last-Event-ID` only when no snapshot exists.
6. Deduplicate journal events received both through replay and the live buffer.
7. Release later live events in order.

When a pane event itself causes active auto-follow to discover another run, the
new run snapshot already contains that event. Emit the new `tail.run.changed`
snapshot and do not append the triggering pane event again.

The dashboard should:

- Remove terminal-status clearing from `useLatheTail`.
- Retain the parent panes throughout convergence.
- Replace panes only on `tail.run.changed` or `tail.panes.replaced`.
- Use a connection generation so callbacks from a closed EventSource cannot
  install stale state after run selection changes.
- Let the active stream, rather than local terminal-status logic, decide when
  the parent is replaced by the child.
- Avoid a second GET-based pane bootstrap once SSE supplies the initial
  snapshot. HTTP snapshot routes can remain for CLI and non-following callers.

The Ink TUI must also initialize panes from snapshots and replace them from
authoritative events rather than clearing every pane on `tail.run.changed`.

## Parent-To-Child Transition

The lifecycle ordering already provides a reliable transition point:

- Super-daddy admits the authored child while parent convergence remains active.
- Queue workers exclude that repository while convergence is active.
- Parent convergence removes its active pointer only in its `finally` block.
- The child writes its active-run pointer before journalling `run_started`.

The visible transition should therefore be:

```text
parent panes remain visible
-> parent convergence completes
-> child active pointer is written
-> first child event is observed
-> tail.run.changed carries the hydrated child snapshot
-> later child live events append normally
```

There should be no deliberate blank intermediate state.

## History Retention Semantics

This design fixes normal browser refresh and SSE reconnect behavior. While the
daemon and current OpenCode sessions survive, refreshing the dashboard restores
the existing Baby, Daddy, and Super-daddy history instead of starting with
blank panes.

It cannot guarantee indefinite full-run history:

- Baby rotation deletes the old Baby session and persists only the replacement
  session ID.
- After daemon restart, pre-rotation Baby history cannot be reconstructed from
  OpenCode.
- The shared Super-daddy reviewer deletes its previous session when moving to a
  different worktree.
- Finished historical Super-daddy panes can therefore disappear after later
  reviews or daemon restart.

The in-memory projection may retain content observed before rotation for the
daemon's lifetime, but current surviving sessions are the only reconstructible
source after restart. Complete indefinite transcripts require a durable
Lathe-owned pane store, which is a separate and materially larger feature.

## Hydration Regression Tests

### Projection Tests

- History preserves assistant message and part order.
- User and bookkeeping parts are omitted.
- The same part ID in different sessions does not collide.
- Repeated `message.part.updated` events are idempotent.
- History text plus an overlapping live update renders once.
- Running and completed tool updates produce one command and one output stream.
- A repeated OpenCode event ID is ignored.
- `message.part.removed` removes only the matching composite part.
- A failed stale-session hydration does not clear replacement-session content.

### Hydration Tests

- Begin fetching `baby-0`, change metadata to `baby-1`, resolve the old fetch,
  and assert only the current binding is installed.
- Return 404 for a deleted old Baby session, expose the replacement binding,
  and assert the retry hydrates the replacement.
- Return 404 with an unchanged binding and assert the other speakers still
  hydrate successfully.
- Add `reviewerSessionId` after the run subscription exists and assert the Super
  pane hydrates without recreating the run subscription.
- Reconnect the OpenCode event stream after missing output and assert history
  repairs the projection without duplication.

### SSE Tests

- Subscribe before snapshot/replay and publish an event during bootstrap;
  assert it appears exactly once.
- Assert the first dashboard frame is always an authoritative
  `tail.run.changed`, including when no run is active.
- Reconnect with `Last-Event-ID`; the authoritative snapshot supersedes older
  state and journal events newer than its cursor replay.
- Switch parent to child when the triggering child pane event is already in the
  projection; assert the event is not appended twice.
- Assert another active run's events do not replace the selected active target.

### Dashboard And TUI Tests

- Snapshot initialization restores all panes.
- `tail.panes.replaced` replaces panes authoritatively.
- Terminal parent stats update status without clearing panes.
- Parent-to-child replacement atomically removes parent content.
- A closed EventSource generation cannot install stale state.
- Selecting an explicit run while the previous bootstrap is pending cannot
  install the previous run's snapshot.
- The Ink TUI initializes and replaces panes from snapshot content.

### Required Lifecycle Regression

```text
parent converges
-> Super-daddy authors a child
-> child starts and emits output before dashboard subscription
-> dashboard connects
-> first authoritative child snapshot contains the earlier child output
```

This should be covered across server and dashboard tests, not only through a
pure projector unit test.

## Driver-Owned Verification Streaming

Implement verification streaming after hydration as a separate change.

The current `Verify` adapter uses `execFile`, which buffers stdout and stderr
until command completion. The deferred report-verification patch journals each
command only after it completes, so a ten-minute command remains silent for ten
minutes.

### Core Boundary

Core must not import `@lathe/contract`. Define application-owned verification
process events:

```ts
export type VerificationProcessEvent =
  | {
      kind: "started";
      commandId: string;
      command: string;
    }
  | {
      kind: "output";
      commandId: string;
      command: string;
      stream: "stdout" | "stderr";
      chunk: string;
    }
  | {
      kind: "finished";
      commandId: string;
      command: string;
      exitCode: number;
      timedOut: boolean;
    };

export type VerificationPhase = "report" | "convergence" | "autofix";

export type DriverOutput = {
  verification: (
    runId: string,
    phase: VerificationPhase,
    event: VerificationProcessEvent,
  ) => void;
};
```

Provide a no-op implementation outside the daemon host. The use cases already
own `runId` and phase and should supply that context rather than making the
adapter infer it.

Observation failures must never alter verification behavior. Exceptions from
the output sink must be swallowed at the adapter boundary.

### Process Adapter

Replace `execFile` with:

```ts
spawn("/bin/zsh", ["-c", command], ...)
```

Requirements:

- Read stdout and stderr as decoded UTF-8 streams.
- Emit chunks as they arrive, tagged with their source stream.
- Maintain a rolling 400-character combined output tail rather than retaining
  complete output.
- Preserve input command ordering in returned `VerificationResult[]`, even if
  commands execute concurrently.
- Distinguish repeated command strings with `commandId`.
- Preserve timeout exit code 124.
- Terminate the process group on timeout or cancellation so descendants do not
  survive the shell process.
- Escalate from SIGTERM to SIGKILL after a short grace period.
- Keep command completion durable through the existing `verification_run`
  journal event.
- Do not persist output chunks in SQLite.

Remove the obsolete duplicate buffered verification implementation from
`packages/core/src/infrastructure/bridge.ts` after confirming it has no callers.

### Use-Case Coverage

Stream all driver-owned command phases:

- Report verification in `turn-loop.ts`.
- Convergence verification in `converge-run.ts`.
- Convergence autofix commands in `converge-run.ts`.

Streaming is observational only. It must not change report rejection, Daddy
final review, Super-daddy ordering, verification exit-code handling, or
convergence decisions.

### Server And Wire Mapping

The supervisor owns the translation from core events to contract events:

```ts
type TailDriverEvent =
  | {
      kind: "tail.driver.command";
      runId: string;
      phase: VerificationPhase;
      commandId: string;
      command: string;
      status: "running";
    }
  | {
      kind: "tail.driver.delta";
      runId: string;
      phase: VerificationPhase;
      commandId: string;
      stream: "stdout" | "stderr";
      text: string;
    }
  | {
      kind: "tail.driver.command";
      runId: string;
      phase: VerificationPhase;
      commandId: string;
      command: string;
      status: "completed" | "error";
      exitCode: number;
      timedOut: boolean;
    };
```

Do not widen `TailSpeaker` to `driver` and do not label driver output as Baby,
Daddy, or Super-daddy. These commands have different ownership.

Update the canonical `driver` pane for each process event, then publish an
authoritative pane replacement. This keeps concurrent command partials keyed by
`commandId` and makes live rendering identical to reconnect rendering without
attributing output to an agent speaker.

### Presentation

Render a dedicated, bounded, full-width driver verification pane beneath the
three agent panes and above or instead of the current three-line driver footer.

Suggested rendering:

```text
[report] $ task check
...stdout...
...stderr...
exit 0
```

The exact height and collapse behavior are a UX choice. The architectural
requirement is that driver output remains distinct from all three agent panes
and is visible while the command is running.

### Verification Streaming Tests

- First stdout chunk is observed before `Verify.run()` settles.
- Interleaved stdout and stderr chunks carry the correct stream tag.
- Output tail remains bounded.
- Non-zero exit emits a terminal error event and preserves the real exit code.
- Timeout emits `timedOut: true`, returns 124, and terminates descendants.
- Cancellation terminates the process group without leaking a child.
- Concurrent commands have distinct IDs and results remain in input order.
- A throwing event sink does not affect command completion.
- Report verification uses phase `report` and the correct run ID.
- Convergence autofix and verification use their respective phases.
- Super-daddy does not begin until convergence verification settles.
- Server mapping never attributes driver output to an agent speaker.
- Tail SSE filters authoritative driver replacements by run ID.
- Dashboard renders concurrent split chunks, stderr, and terminal status from
  the canonical driver pane.

## Implementation Record

- [x] Add canonical pane DTOs and authoritative pane replacement events.
- [x] Implement the identity-based server projection with focused fixtures in
  projection tests.
- [x] Add session-history reading and binding-aware hydration.
- [x] Merge live OpenCode events through the canonical projection.
- [x] Protect live output from stale history completion and deleted-part
  resurrection.
- [x] Scope event deduplication by run for shared root subscriptions.
- [x] Make tail SSE subscribe first and send `tail.run.changed` as the
  authoritative bootstrap frame.
- [x] Update dashboard and Ink TUI snapshot/replacement handling.
- [x] Remove terminal parent clearing and make run replacement atomic in client
  state.
- [x] Add the core `DriverOutput` port and `spawn`-based verification adapter.
- [x] Wire report, convergence, and autofix output through the supervisor.
- [x] Add and render dedicated dashboard and Ink driver output.
- [x] Remove obsolete bridge-owned buffered verification.
- [x] Regenerate contract artifacts.
- [x] Run `pnpm check`, `pnpm test`, `pnpm build`, `git diff --check`, and Plumb.
- [ ] Restart the daemon when no run can be interrupted and validate browser
  refresh/reconnect against a real surviving OpenCode session.
- [ ] Exercise a real promoted parent-to-child transition through the browser.

## Remaining Validation

Automated coverage now verifies projection identity, history/live overlap,
chronological history repair, monotonic tool state, removal tombstones,
authoritative pane replacement, terminal-state retention, buffered SSE bootstrap,
same-sequence replay, concurrent driver rendering, split chunks,
streaming-before-settlement, stream tagging, timeouts, cancellation, resistant
descendant termination, command identity, result order, and observer isolation.

The remaining operational checks require a safe daemon restart:

- Refresh the browser during an active Baby turn and confirm prior pane history
  is restored before subsequent deltas.
- Disconnect/reconnect SSE during tool output and confirm no duplicate or lost
  lines.
- Promote a parent into a child and confirm the parent remains visible until the
  child snapshot replaces it without an empty intermediate frame.
- Observe a long-running report and convergence command in the dedicated driver
  pane.

## Integrated Existing Work

The implementation retained and integrated the pre-existing uncommitted work for:

- Deferred post-`submit_report` verification in the turn loop.
- `Verify` added to `RunPorts`.
- Correct verification timeout units.
- Running OpenCode tool output projected as suffix deltas.
- `running` added to tail tool status.
- OpenCode bash-output regression coverage.

No unrelated dirty-worktree changes were reverted.
