// ---------------------------------------------------------------------------
// Typed daemon client — openapi-fetch over the generated @lathe/contract paths.
//
// Every call's path, method, body, and per-status response is inferred from the
// contract. Commands import this and call the client directly — no hand-rolled
// fetch, no `any`, no casting responses to DTOs.
//
// The default baseUrl comes from config.daemon (host/port). For testing or
// non-default daemon ports, call createDaemonClient(baseUrl) instead of the
// default export.
// ---------------------------------------------------------------------------

import createClient from "openapi-fetch";
import type { paths } from "@lathe/contract";
import { loadConfig } from "@lathe/core";

export const createDaemonClient = (baseUrl?: string) => {
  if (!baseUrl) {
    const { config } = loadConfig();
    baseUrl = `http://${config.daemon.host}:${config.daemon.port}`;
  }
  return createClient<paths>({ baseUrl });
};

/** Default client instance — uses config.daemon host/port. */
export const lathe = createDaemonClient();
