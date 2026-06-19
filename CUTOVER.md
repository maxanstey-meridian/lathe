# Cutover: switching `meridian` from plumb (v2) to lathe (v3)

This is the **manual final step** Max performs once the v3 chain is whole and
reviewed. Building lathe's CLI does **not** perform the switch-over — the live
`meridian` keeps running from the plumb repo until you deliberately flip it here.

## What ships

- `meridian` is the bin (`package.json` → `dist/interfaces/cli/index.js`).
- The command surface is unchanged from v2 (CONTRACT X1): `plan`, `queue
  [add|drop]`, `chain add`, `run`, `status`, `tail`, `review`, `answer`,
  `accept`, `super-review`, `converge`.
- The gate plugin is resolved relative to the package root
  (`reference/plugin/gate-plugin.ts`), so `reference/` must remain alongside
  `dist/` — `npm link` of the whole package keeps it there.

## Steps

1. **Build:**

   ```sh
   cd ~/Sites/lathe        # this repo
   pnpm install
   pnpm run build          # tsc → dist/
   ```

2. **Link the bin onto PATH (replacing plumb's `meridian`):**

   ```sh
   npm link                # exposes dist/interfaces/cli/index.js as `meridian`
   which meridian          # confirm it resolves here, not to plumb
   ```

   If plumb's `meridian` was itself an `npm link`, unlink it first
   (`npm rm -g plumb` or `npm unlink` in the plumb repo) so PATH resolves to
   lathe.

3. **Smoke-check the read commands (no driver started):**

   ```sh
   meridian status
   meridian review
   ```

4. **Run the driver** once you're satisfied:

   ```sh
   meridian run
   ```

5. **Retire plumb:** once a night or two has run clean on lathe, archive the
   plumb repo. The state root (`~/.meridian/v2`, set by `config.stateRoot`) is
   shared, so in-flight runs, the queue, and campaigns carry over untouched.

## `tail` views

- **TTY (default):** the Ink split-pane UI — Baby/Daddy panes, the context gauge,
  and the driver-event/status strip — fed by the journal plus the live opencode
  SSE feed (`src/interfaces/tui/tail-ui.tsx`, over the `Events` port). `q` quits.
- **Pipes / `--plain` / `--no-follow`:** the plain journal line stream + replay
  (`src/interfaces/tui/render.ts`). Both are read-only over the same durable
  state and render identically for a live and a finished run (D4).
