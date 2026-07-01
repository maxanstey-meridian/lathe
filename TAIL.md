# Tail Daemon-Only Cutover Plan

## Goal

`lathe tail` must become daemon-owned.

The CLI must stop opening local Lathe state and must stop subscribing directly to opencode. After this cutover, tail should work like the other CLI read surfaces: the daemon owns SQLite, paths, opencode subscriptions, context-token reads, and live event fan-out; the CLI is only a presentation client.

## Current State

### Completed

- Tail contract DTOs now exist in `packages/contract/src/lathe.contract.ts`: `TailSnapshotDto`, `TailJournalLineDto`, `TailEvent`, `TailRunStatus`, speaker/style helper types.
- Generated contract artifacts were refreshed: `packages/contract/generated/api.contract.json`, `openapi.json`, and `schema.d.ts`.
- Daemon snapshot endpoints now exist:
  - `GET /tail/active`
  - `GET /tail/{runId}`
- Daemon tail SSE sidecar endpoints now exist, separate from dashboard `/events`:
  - `GET /tail/active/events`
  - `GET /tail/{runId}/events`
- `apps/lathe-server/src/app.ts` now owns a separate `TailEventBus` and tail SSE stream implementation.
- `apps/lathe-server/src/supervisor.ts` now builds daemon-owned tail snapshots from store/config reads.
- Durable journal rows now project to tail events: `tail.journal`, `tail.stats`, and `tail.super.verdict`.
- Plain/non-TTY `lathe tail` now fetches daemon tail snapshots and follows daemon tail SSE.
- Plain CLI tail no longer uses local `journalFile`, local journal replay, or `watchFile`/`unwatchFile`.
- TTY/Ink `lathe tail` now fetches daemon tail snapshots and follows daemon tail SSE.
- `apps/lathe-cli/src/commands.ts` no longer imports `SqliteStoreAdapter`, `buildRepo`, local `openTail`, local paths, or local store read seams for tail.
- `packages/core/src/interfaces/cli/tail.ts` is now presentation-only: it exports `runTailUi`/`TailUiDeps` and no longer constructs a store or opencode subscribers.
- `packages/core/src/interfaces/tui/tail-ui.tsx` now renders from `TailSnapshotDto` plus `TailEvent` and no longer polls store state or subscribes directly to opencode.
- The daemon supervisor now owns opencode event subscriptions for active tail runs and publishes live-only `tail.pane.delta` / `tail.pane.tool` events.
- The daemon supervisor now polls opencode context tokens and publishes live-only `tail.stats` updates.
- Active tail SSE can emit `tail.run.changed` with a daemon snapshot so TTY auto-advance can switch without reading local pointers.
- Focused and workspace verification passed:
  - `pnpm --filter @lathe/server test`
  - `pnpm --filter @lathe/server typecheck`
  - `pnpm --filter @lathe/core typecheck`
  - `pnpm --filter @lathe/core build`
  - `pnpm --filter @lathe/server build && pnpm --filter @lathe/cli test`
  - `pnpm --filter @lathe/cli typecheck`
  - `pnpm run typecheck`

### Remaining Caveats

- Opencode pane deltas/tool lines are live-only. Durable replay is still journal/stat/super-verdict only.
- TTY event subscription close currently stops forwarding events to Ink, but the underlying fetch stream is not abort-controller cancelled yet.
- Live context-token `tail.stats` updates are seq-less by design; durable journal-derived stats keep `seq` and replay normally.
- The daemon opencode subscription service is intentionally scoped to active run/convergence targets, not every historical run.

### CLI Tail Is Still Local

This section is now only partially true.

Plain/non-TTY tail and TTY tail have been cut over to the daemon.

- `apps/lathe-cli/src/commands.ts:292-294` explicitly says tail is local until the SSE + journal endpoint pass.
- `apps/lathe-cli/src/commands.ts:297-309` defines `TailDeps` around a local `Store`, local `Paths`, local `openTail`, and local file watching.
- `apps/lathe-cli/src/commands.ts:311-331` builds those deps with `loadConfig`, `buildRepo`, `SqliteStoreAdapter.create`, `openTail(config, paths, ...)`, and `paths.journalFile`.
- `apps/lathe-cli/src/commands.ts:507-588` resolves active run and plain replay from local store reads.
- `apps/lathe-cli/src/commands.ts:526-551` still uses `journalFile`, `existsSync`, `watchFile`, and `unwatchFile` as the plain-tail follow trigger.

Current status: this section is obsolete. `apps/lathe-cli/src/commands.ts` now has daemon-backed plain and TTY tail helpers. It still names its test seam `openTailUi`, but that is only an Ink presentation callback, not local state composition.

### TTY Tail Is Also Local

This section is obsolete after the latest slice.

- `packages/core/src/interfaces/cli/tail.ts:19-45` constructs `SqliteStoreAdapter`, `createEvents(config)`, and `createContextTokenReader(config)` locally before calling `runTailUi`.
- `packages/core/src/interfaces/tui/tail-ui.tsx:192-195` reads local run meta for label and model promotion.
- `packages/core/src/interfaces/tui/tail-ui.tsx:211-249` polls opencode `/session/{sessionId}/message` locally for context-token updates.
- `packages/core/src/interfaces/tui/tail-ui.tsx:251-298` polls local SQLite store for journal, ledger, gate state, and meta.
- `packages/core/src/interfaces/tui/tail-ui.tsx:300-414` subscribes directly to opencode live event feeds for baby, daddy, and super-daddy panes.
- `packages/core/src/interfaces/tui/tail-ui.tsx:496-517` auto-advances by polling local meta and active-run state.

TTY tail now works from daemon snapshots/events. The old local store/opencode polling path has been removed.

### Existing Daemon `/events` Is Not Enough

This remains true. A tail-specific stream now exists; do not collapse it back into `/events`.

- `apps/lathe-server/src/app.ts:213-262` serves sidecar `GET /events`.
- `apps/lathe-server/src/supervisor.ts:162-202` tails SQLite journal rows with `readJournalSince` and publishes projected events to the bus.
- `apps/lathe-server/src/supervisor.ts:436-450` replays those projected events for SSE reconnects.
- `apps/lathe-server/src/event-projection.ts:31-121` maps internal `JournalEvent` to dashboard-level `LatheEvent`, dropping many internal events.
- `packages/contract/src/lathe.contract.ts:146-152` defines `LatheEvent` as a small dashboard event union: run state, turn start, gate decision, tokens, verdict, and log.

That stream is useful, but it cannot preserve the current TTY UI by itself. It does not carry opencode text deltas, reasoning deltas, tool completion lines, speaker routing, session ids, active-run auto-advance state, ledger totals, gate state, promoted-model state, or context-token polling updates.

## Required Target Shape

### CLI Responsibilities After Cutover

- Create daemon client from config.
- Refuse tail when daemon is down.
- Resolve explicit flags and presentation mode.
- Fetch daemon snapshots and consume daemon SSE.
- Render plain text or Ink UI from daemon payloads.

The CLI must not:

- import `SqliteStoreAdapter`,
- import `buildRepo`,
- import `openTail` from `@lathe/core/tail`,
- call `loadConfig` for local `paths`, except to build daemon URL if needed,
- call `makePaths` or `paths.journalFile`,
- read local Store state,
- watch local files,
- subscribe directly to opencode,
- call opencode context-token endpoints directly.

### Daemon Responsibilities After Cutover

- Resolve active tail target.
- Read run snapshot from SQLite/store.
- Replay journal events for a run.
- Stream live journal events.
- Own opencode subscriptions for baby/daddy/super-daddy panes.
- Own opencode context-token reads.
- Route opencode deltas to the correct pane using run meta session ids.
- Publish active-run changes so auto-advance does not require CLI store reads.

## New Daemon Tail Surface

This is implemented. Snapshot, durable SSE, active SSE, live pane events, context-token stats, and active-run change events exist.

Do not overload the existing dashboard `/events` stream. Add a tail-specific daemon surface.

### Snapshot Endpoint

Implemented:

- `GET /tail/{runId}`
- `GET /tail/active`

Current snapshot includes: `runId`, `summary`, `status`, `startedAt`, `models`, `promoted`, `budget`, `worktree`, `outcomesDone`, `outcomesTotal`, `gateReason`, `contextTokens`, `turn`, `rotations`, `journal`, `lastSeq`.

Add a request/response endpoint, likely in the rivet contract:

- `GET /tail/{runId}`

Response shape should include enough initial state for both plain and TTY tail:

- `runId`
- `summary` or display label
- `status`
- `startedAt`
- `models`: baby, promoted, daddy, super
- `promoted`: boolean
- `budget`
- `worktree`
- `outcomesDone`
- `outcomesTotal`
- `gateReason`
- `contextTokens`
- `turn`
- `rotations`
- `journal`: rendered line plus raw driver classification, or a stable tail event union
- `lastSeq`: journal/tail sequence for reconnect

For no explicit run id, add one of:

- `GET /tail/active`, returning the current active run/convergence target or `null`, or
- include active-run resolution in `GET /status` and have CLI use that.

Prefer `GET /tail/active` because tail needs tail-specific snapshot fields and because auto-advance should be owned by the tail surface.

### Tail SSE Endpoint

Implemented:

- `GET /tail/{runId}/events`
- `GET /tail/active/events`

Current streamed events:

- `tail.journal`
- `tail.stats`
- `tail.super.verdict`
- `tail.pane.delta`
- `tail.pane.tool`
- `tail.run.changed`
- `tail.ping`

Note: `tail.pane.delta`, `tail.pane.tool`, live context-token `tail.stats`, and `tail.run.changed` are live-only. They are not replayed from durable storage.

Add a sidecar stream separate from `/events`, for example:

- `GET /tail/{runId}/events`
- `GET /tail/active/events`

Use `Last-Event-ID` for reconnect, same as `/events`.

The streamed union should be explicit and presentation-oriented:

- `tail.journal`: rendered journal line, driver-event flag, raw event kind, run id, seq, at.
- `tail.stats`: context tokens, turn, rotations, outcomes done/total, gate reason, status.
- `tail.pane.delta`: speaker `baby | daddy | super`, style `think | text`, text delta.
- `tail.pane.tool`: speaker, status, tool, detail.
- `tail.super.verdict`: verdict, pass, findings, rendered lines.
- `tail.run.changed`: active run changed; includes the new run id and initial snapshot or tells the client to fetch it.
- `tail.ping`: keepalive.

The daemon should generate these from:

- SQLite journal rows via `store.readJournalSince` / per-run journal reads,
- meta/ledger/gate reads from the daemon-owned store,
- opencode event subscriptions currently created by `createEvents(config)`,
- context-token reads currently created by `createContextTokenReader(config)`.

## Implementation Plan

### Phase 1: Move Tail Read Model Into Server

Status: mostly complete.

- Add tail DTO/event types to `packages/contract/src/lathe.contract.ts` for snapshot responses and tail SSE payloads.
- Keep the actual stream as a sidecar route if rivet cannot model SSE, but keep the payload types in the contract package like `LatheEvent` does today.
- Add `Supervisor.getTailSnapshot(runId)`.
- Add `Supervisor.getActiveTailSnapshot()` or equivalent active resolution.
- Build snapshots only from daemon-owned store/config reads.
- Add tests in `apps/lathe-server/tests/app.test.ts` for snapshot success, missing run, active target, and shape fields required by the UI.

### Phase 2: Add Daemon Tail Stream

Status: complete for this cutover.

- Add a tail bus distinct from the dashboard `EventBus`, or extend the current bus with a separate typed channel.
- Add daemon-owned opencode subscriptions in the supervisor or a small tail service owned by the supervisor.
- Move the speaker routing logic out of `tail-ui.tsx` into that daemon tail service.
- Speaker routing rule: baby is active run baby session.
- Speaker routing rule: daddy is `meta.daddySessionId`.
- Speaker routing rule: super is `meta.reviewerSessionId`.
- Speaker routing rule: fallback baby is `meta.babySessionId`.
- Move tool detail extraction from `tail-ui.tsx` into that daemon tail service.
- Move context-token polling from `tail-ui.tsx` into that daemon tail service.
- Stream journal/stat updates from SQLite and pane deltas/tool lines from opencode as `TailEvent` payloads.
- Preserve reconnect with `Last-Event-ID` for journal/stat events where durable seq exists.
- Document that token-level pane deltas are live-only unless the daemon explicitly buffers them; do not pretend opencode deltas are durable if they are not persisted.
- Add app tests for replay, live publish, no duplicate handoff, and run filtering.

### Phase 3: Make CLI Plain Tail Daemon-Only

Status: complete for plain/non-TTY tail.

Notes:

- `cmdTail` is now async and `apps/lathe-cli/src/index.ts` awaits it.
- Plain tail requires daemon availability.
- `--plain --no-follow <runId>` fetches the daemon snapshot and prints snapshot journal lines.
- `--plain <runId>` fetches the daemon snapshot, prints journal lines, and follows daemon tail SSE from `lastSeq`.
- Local file watch and local journal replay seams were removed from plain tail.

- Remove local `TailStore`, `TailPaths`, `watchJournal`, and local `renderTailReplay` from `apps/lathe-cli/src/commands.ts`.
- Make `cmdTail --plain` require daemon availability, fetch `GET /tail/{runId}` or `GET /tail/active`, print the snapshot journal, then follow the tail SSE stream.
- For `--no-follow`, fetch snapshot and print once.
- For no active run with follow, connect to active tail stream or poll `GET /tail/active`; do not read local active pointers.
- Keep plain rendering in CLI because it is a presentation concern.
- Add CLI tests proving plain tail hits daemon routes and does not use local store/path/watch deps.

### Phase 4: Make TTY Tail Daemon-Only

Status: complete.

Implemented:

- CLI-side daemon TTY opener in `apps/lathe-cli/src/commands.ts`.
- `tail-ui.tsx` takes initial `TailSnapshotDto` plus a `TailEvent` subscription.
- Local polling effects for store journal/ledger/gate/meta/active run/context tokens are removed.
- TTY consumes `tail.journal`, `tail.stats`, `tail.pane.delta`, `tail.pane.tool`, `tail.super.verdict`, and `tail.run.changed` from daemon streams.
- CLI stopped building `SqliteStoreAdapter` for tail.

- Replace `openTail(config, paths, runId, autoAdvance)` with a CLI-side `openDaemonTail(client, runId, autoAdvance)` or equivalent.
- Refactor `packages/core/src/interfaces/tui/tail-ui.tsx` so it renders from injected snapshot + `TailEvent` subscription, not from `Store`, `subscribe(directory, ...)`, or `readContextTokens`.
- Remove local polling effects for store journal, ledger, gate state, meta, active run, and context tokens.
- Remove opencode event parsing/routing from the UI; the daemon stream should already classify pane events.
- Keep Ink layout/pane state in the UI.
- Add UI-level tests or CLI seam tests proving TTY tail opens daemon-backed UI and no longer constructs `SqliteStoreAdapter`.

### Phase 5: Delete Local Tail State Surface

Status: complete for CLI/TUI cutover. The remaining `@lathe/core/tail` export is presentation-only.

- Delete or repurpose `packages/core/src/interfaces/cli/tail.ts`; it should not create store/opencode adapters for the CLI.
- Remove `@lathe/core/tail` import from `apps/lathe-cli/src/commands.ts`.
- Remove `SqliteStoreAdapter`, `buildRepo`, `systemClock`, `Paths`, and `Store` imports from CLI commands if tail was their only remaining use.
- Remove `journalFile` from `packages/core/src/config/paths.ts` and `makePaths`.
- Remove `existsSync`, `watchFile`, and `unwatchFile` imports from `commands.ts` if no longer needed.
- Update `apps/lathe-cli/src/commands.ts` header and usage text so tail is daemon-backed.
- Fix stale comment in `packages/core/src/infrastructure/sqlite-store.ts:188-190`.
- Fix stale comment in `apps/lathe-cli/src/commands.ts:457`.
- Fix stale comment in `SPLIT.md:64`.
- Grep for `journalFile`, `openTail`, `createEvents`, `createContextTokenReader`, and local `readJournal` usage from CLI paths.

## Test Plan

- `apps/lathe-server/tests/app.test.ts`: tail snapshot endpoint returns full UI snapshot for a run.
- `apps/lathe-server/tests/app.test.ts`: active tail endpoint returns `null` when no active run/convergence exists.
- `apps/lathe-server/tests/app.test.ts`: tail stream replays durable journal/stat events with `Last-Event-ID`.
- `apps/lathe-server/tests/app.test.ts`: tail stream filters by run id.
- `apps/lathe-server/tests/app.test.ts`: tail stream publishes live pane delta/tool events with speaker classification.
- `apps/lathe-cli/tests/cli.test.ts`: `lathe tail --plain --no-follow <runId>` fetches daemon snapshot and prints journal lines.
- `apps/lathe-cli/tests/cli.test.ts`: `lathe tail --plain <runId>` follows daemon SSE rather than watching files.
- `apps/lathe-cli/tests/cli.test.ts`: `lathe tail <runId>` on TTY opens daemon-backed Ink UI, not `@lathe/core/tail`.
- `apps/lathe-cli/tests/cli.test.ts`: no explicit run id resolves through daemon active-tail state.
- Core/package tests: no remaining `Paths.journalFile` contract after removal.

## Verification Commands

Infer final commands from package scripts before running, but expected relevant checks are:

- `pnpm run typecheck`
- `pnpm run lint`
- `pnpm run build`
- `pnpm --filter @lathe/server test`
- `pnpm --filter @lathe/cli test`
- `pnpm --filter @lathe/core test`

## Risks And Decisions

- The existing dashboard `/events` should probably stay stable; tail needs a richer stream rather than broadening the dashboard stream accidentally.
- Opencode pane deltas are currently live-only. If durable replay of pane text is required, that is a separate persistence decision.
- The daemon will maintain opencode subscriptions and fan out to all tail clients. This avoids each CLI process independently subscribing to opencode, but it means the daemon must handle subscription lifecycle carefully.
- Auto-advance must move to daemon-owned active-run events or active-tail polling. The CLI must not poll local active pointers.
- This cutover is bigger than removing `journalFile`; removing `journalFile` is only the final cleanup after both plain and TTY tail no longer use local state.
