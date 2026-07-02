// Structured-extraction salvage (CONTRACT §18 S11). One home for the routines that
// recover a structured value from a dirty model reply: the single balanced-object
// scanner shared by every JSON fail-closed parser, the best-first JSON candidate
// builder, and the YAML escape repair the authoring path needs. There must be
// exactly ONE of each in the codebase — these are it.

// ---------------------------------------------------------------------------
// JSON candidate scanning

// Every top-level {...} object in the text, brace-matched with string/escape
// awareness so a brace inside a JSON string value (or a `}` in prose) cannot throw
// off the depth counter. THE single scanner — review.ts, convergence.ts and
// handoff.ts all call this one rather than copying it.
export const balancedObjects = (text: string): string[] => {
  const objects: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      if (depth === 0) {
        start = i;
      }
      depth += 1;
    } else if (ch === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        objects.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return objects;
};

// Candidate JSON substrings to try, best-first: fenced blocks then every balanced
// object (both last-first, since reasoning models trail the real verdict), then the
// legacy whole-string fallbacks. Shared by the planner-response and verify-verdict
// parsers (their builders were byte-identical). The balanced-only parsers
// (final-review, super-review) call `balancedObjects(raw).reverse()` directly — a
// deliberately fence-agnostic subset, not this fuller builder.
export const jsonCandidates = (raw: string): string[] => {
  const cleaned = raw.trim();
  const candidates: string[] = [];

  const fences = [...cleaned.matchAll(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/g)]
    .map((m) => m[1]?.trim())
    .filter((s): s is string => Boolean(s));
  candidates.push(...fences.reverse());

  candidates.push(...balancedObjects(cleaned).reverse());

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start !== -1 && end > start) {
    candidates.push(cleaned.slice(start, end + 1));
  }
  candidates.push(cleaned);

  return candidates;
};

// ---------------------------------------------------------------------------
// YAML escape salvage (the cli-cutover authoring scar)

// The escape sequences YAML 1.2 permits after a backslash inside a DOUBLE-QUOTED
// scalar. Anything else is a syntax error — most commonly a model markdown-escaping
// a backtick (`\`lathe serve\``) out of habit.
const VALID_YAML_DQ_ESCAPES = new Set([
  "0",
  "a",
  "b",
  "t",
  "\t",
  "n",
  "v",
  "f",
  "r",
  "e",
  " ",
  '"',
  "/",
  "\\",
  "N",
  "_",
  "L",
  "P",
  "x",
  "u",
  "U",
  "\n",
  "\r",
]);

// Deterministic SALVAGE, not a rewrite: repair invalid backslash escapes inside
// double-quoted YAML scalars by dropping the spurious backslash (the model meant
// the literal character — a backtick, usually — and over-escaped it). It only ever
// touches a `\X` where X is not a legal escape, so a well-formed scalar is returned
// byte-for-byte unchanged. Single-quoted scalars (backslash is literal there) and
// everything outside a quoted scalar are left alone. Callers apply this ONLY after a
// real parse failure, so valid YAML is never run through a meaning-altering pass.
export const repairYamlEscapes = (yaml: string): string => {
  let out = "";
  let inDouble = false;
  let inSingle = false;
  for (let i = 0; i < yaml.length; i++) {
    const ch = yaml[i];
    if (inSingle) {
      out += ch;
      if (ch === "'") {
        inSingle = false; // a doubled '' just re-opens on the next iteration
      }
      continue;
    }
    if (inDouble) {
      if (ch === "\\") {
        const next = yaml[i + 1];
        if (next !== undefined && !VALID_YAML_DQ_ESCAPES.has(next)) {
          continue; // drop the spurious backslash; the next char is emitted as-is
        }
        out += ch;
        if (next !== undefined) {
          out += next;
          i += 1; // consume the legitimately-escaped char so a `\"` can't close us
        }
        continue;
      }
      if (ch === '"') {
        inDouble = false;
      }
      out += ch;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
    } else if (ch === "'") {
      inSingle = true;
    }
    out += ch;
  }
  return out;
};
