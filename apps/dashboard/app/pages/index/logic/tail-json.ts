export type ClassifiedLine =
  | { readonly kind: "text" }
  | {
      readonly kind: "json";
      readonly label: string;
      readonly formatted: string;
      readonly payloads: readonly JsonPayload[];
      readonly segments: readonly JsonSegment[];
    };

export type JsonPayload = {
  readonly label: string;
  readonly formatted: string;
};

export type JsonSegment =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "json"; readonly payload: JsonPayload; readonly payloadIndex: number };

const MIN_LENGTH = 80;

const jsonEnd = (text: string, start: number): number | null => {
  const first = text[start];
  const stack = first === "{" ? ["}"] : first === "[" ? ["]"] : [];
  if (stack.length === 0) {
    return null;
  }

  let inString = false;
  let escaped = false;

  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{") {
      stack.push("}");
      continue;
    }

    if (char === "[") {
      stack.push("]");
      continue;
    }

    if (char === "}" || char === "]") {
      if (stack.at(-1) !== char) {
        return null;
      }

      stack.pop();
      if (stack.length === 0) {
        return index + 1;
      }
    }
  }

  return null;
};

const payloadFromJson = (json: string): JsonPayload | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }

  if (parsed === null || typeof parsed !== "object") {
    return null;
  }

  const label = Array.isArray(parsed)
    ? `[${parsed.length} items]`
    : `{${Object.keys(parsed as Record<string, unknown>).length} keys}`;

  return {
    label,
    formatted: JSON.stringify(parsed, null, 2),
  };
};

const extractSegments = (text: string): JsonSegment[] => {
  const segments: JsonSegment[] = [];
  const payloads: JsonPayload[] = [];
  let index = 0;

  while (index < text.length) {
    const objectStart = text.indexOf("{", index);
    const arrayStart = text.indexOf("[", index);
    const starts = [objectStart, arrayStart].filter((start) => start >= 0);
    if (starts.length === 0) {
      break;
    }

    const start = Math.min(...starts);
    if (start > index) {
      segments.push({ kind: "text", text: text.slice(index, start) });
    }

    const end = jsonEnd(text, start);
    if (end === null) {
      segments.push({ kind: "text", text: text[start] ?? "" });
      index = start + 1;
      continue;
    }

    if (end - start <= MIN_LENGTH) {
      segments.push({ kind: "text", text: text.slice(start, end) });
      index = end;
      continue;
    }

    const payload = payloadFromJson(text.slice(start, end));
    if (payload !== null) {
      const payloadIndex = payloads.length;
      payloads.push(payload);
      segments.push({ kind: "json", payload, payloadIndex });
      index = end;
      continue;
    }

    segments.push({ kind: "text", text: text[start] ?? "" });
    index = start + 1;
  }

  if (index < text.length) {
    segments.push({ kind: "text", text: text.slice(index) });
  }

  return segments;
};

export function classifyLine(text: string): ClassifiedLine {
  if (text.length <= MIN_LENGTH) {
    return { kind: "text" };
  }

  const trimmed = text.trim();
  const segments = extractSegments(trimmed);
  const payloads = segments.flatMap((segment) => segment.kind === "json" ? [segment.payload] : []);
  const first = payloads[0];
  if (first === undefined) {
    return { kind: "text" };
  }

  return {
    kind: "json",
    label: first.label,
    formatted: first.formatted,
    payloads,
    segments,
  };
}
