// ---------------------------------------------------------------------------
// Typed daemon client — openapi-fetch over the generated @lathe/contract paths.
//
// Every call's path, method, body, and per-status response is inferred from the
// contract. Commands import this and call the client directly — no hand-rolled
// fetch, no `any`, no casting responses to DTOs.
//
// The default baseUrl comes from config.daemon (host/port). Tests (or a non-
// default daemon port) pass an explicit baseUrl, and optionally a custom fetch
// so the client can be driven against an in-process app or a stub with no
// network.
// ---------------------------------------------------------------------------

import type { paths } from "@lathe/contract";
import { loadConfig } from "@lathe/core";
import createClient from "openapi-fetch";

export const createDaemonClient = (baseUrl?: string, fetchImpl?: typeof fetch) => {
  let url = baseUrl;
  if (!url) {
    const { config } = loadConfig();
    url = `http://${config.daemon.host}:${config.daemon.port}`;
  }
  return fetchImpl
    ? createClient<paths>({ baseUrl: url, fetch: fetchImpl })
    : createClient<paths>({ baseUrl: url });
};

export type DaemonClient = ReturnType<typeof createDaemonClient>;
