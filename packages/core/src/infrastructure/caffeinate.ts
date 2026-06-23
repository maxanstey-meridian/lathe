// Caffeinate adapter: a macOS power assertion held for the driver's lifetime
// (CONTRACT T3). The child is tied to this process (`-w <pid>`) so it dies with
// the driver; on non-darwin platforms it is a no-op.

import { spawn } from "node:child_process";
import type { Caffeinate } from "../application/ports/caffeinate.js";

export const createCaffeinate = (): Caffeinate => ({
  holdPowerAssertion: async () => {
    if (process.platform === "darwin") {
      spawn("caffeinate", ["-i", "-w", String(process.pid)], {
        stdio: "ignore",
        detached: true,
      }).unref();
    }
  },
});
