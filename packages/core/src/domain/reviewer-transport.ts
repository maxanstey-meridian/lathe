// Transport-vs-verdict classification for the super-daddy review call.
//
// A dropped / refused / timed-out connection is NOT a review verdict — it must
// be retried, never recorded as a pass. This pure classifier decides whether a
// thrown error or provider-error string is a TRANSIENT transport failure (worth
// an immediate retry) or a FATAL one (auth / bad request — retrying won't help).
//
// Parse failures never reach here: parseSuperReview fails closed to an escalate
// VERDICT, which is a real reviewed outcome, not a transport error.

export type ReviewerErrorClass = "transient" | "fatal";

// Substrings that mark a recoverable transport drop — matched case-insensitively
// against the error message (Node socket errnos, undici/fetch, proxies). These
// only ever match error strings, never model output.
const TRANSIENT_MARKERS = [
  "socket hang up",
  "econnreset",
  "econnrefused",
  "econnaborted",
  "etimedout",
  "epipe",
  "enetunreach",
  "eai_again",
  "fetch failed",
  "premature close",
  "other side closed",
  "terminated",
  "timed out",
  "request timeout",
];

// HTTP statuses that never produced a verdict and are worth retrying: 408
// request timeout, 425 too early, 429 rate limit, and any 5xx gateway/server.
const isTransientStatus = (status: number): boolean =>
  status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);

// Pull an "HTTP <code>" out of a formatted provider-error string, if present.
const statusFromDetail = (detail: string): number | undefined => {
  const m = detail.match(/HTTP (\d{3})/);
  return m ? Number(m[1]) : undefined;
};

// A status code is the strongest signal (a 400 is fatal even if the message
// happens to contain a transient-looking word); fall back to substring markers.
// Default is FATAL: an unrecognised error is not blindly retried.
export const classifyReviewerError = (detail: string): ReviewerErrorClass => {
  const status = statusFromDetail(detail);
  if (status !== undefined) {
    return isTransientStatus(status) ? "transient" : "fatal";
  }
  const lower = detail.toLowerCase();
  return TRANSIENT_MARKERS.some((m) => lower.includes(m)) ? "transient" : "fatal";
};

// One-line, human-facing description for an unreachable outcome (logs + the Max
// park message). Keeps the "Connection dropped" framing.
export const describeUnreachable = (detail: string): string => `Connection dropped: ${detail}`;
