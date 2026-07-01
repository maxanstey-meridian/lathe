// `lathe tail` on a TTY: the Ink split-pane presentation. The daemon owns all
// state reads and opencode subscriptions; this package only renders typed tail
// snapshots/events supplied by the CLI's daemon client.

export { runTailUi } from "../tui/tail-ui.js";
export type { TailUiDeps } from "../tui/tail-ui.js";
