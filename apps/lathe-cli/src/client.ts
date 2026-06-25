// ---------------------------------------------------------------------------
// Typed daemon client — openapi-fetch over the generated @lathe/contract paths.
//
// Every call's path, method, body, and per-status response is inferred from the
// contract. Commands import this and call the client directly — no hand-rolled
// fetch, no `any`, no casting responses to DTOs.
//
// The default baseUrl is http://127.0.0.1:4198 (the daemon's loopback). For
// testing or non-default daemon ports, call createClient(baseUrl) instead of
// the default export.
// ---------------------------------------------------------------------------

import createClient from "openapi-fetch";
import type { paths } from "@lathe/contract";

const DEFAULT_BASE_URL = "http://127.0.0.1:4198";

export const createDaemonClient = (baseUrl: string = DEFAULT_BASE_URL) =>
  createClient<paths>({ baseUrl });

/** Default client instance — uses the standard daemon port. */
export const lathe = createDaemonClient();
