// ---------------------------------------------------------------------------
// Typed daemon client — openapi-fetch over the generated @lathe/contract paths.
//
// Every call's path, method, body, and per-status response is inferred from the
// contract. P05 cuts the CLI commands over to this; for now it's the seam the
// daemon-facing commands will use.
// ---------------------------------------------------------------------------

import createClient from "openapi-fetch";
import type { paths } from "@lathe/contract";

export const lathe = createClient<paths>({ baseUrl: "http://127.0.0.1:4198" });
