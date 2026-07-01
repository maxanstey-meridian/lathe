// ---------------------------------------------------------------------------
// Validate-packet use case (CONTRACT §4 K1, K3)
//
// Pure validation — no filesystem writes. Replicates the (a)-(e) admission
// steps from SqliteStoreAdapter.admitQueue so the dashboard can preview
// parsed frontmatter and any problems without enqueuing.
// ---------------------------------------------------------------------------

import type { Repo } from "../ports/repo.js";
import {
  extractRepoFromYaml,
  extractBaseFromYaml,
  stampBase,
  parsePacketShape,
} from "../../domain/packet.js";

export type ValidatePacketResult = {
  repoPath: string | undefined;
  baseInFm: string | undefined;
  headBranch: string;
  stamped: string;
  shape: ReturnType<typeof parsePacketShape>;
  repoValid: boolean;
  baseExists: boolean;
  base: string;
};

// Validate a packet (raw markdown) against the admission pipeline without
// writing anything. Returns the intermediate validation state so the caller
// can present a full preview or error diagnostics.
export const validatePacket = (
  raw: string,
  repo: Repo,
  filename?: string,
): ValidatePacketResult => {
  // (a) Extract repo path and base from raw frontmatter YAML block.
  const repoPath = extractRepoFromYaml(raw);
  const baseInFm = extractBaseFromYaml(raw);

  // (b) headBranch via Repo port — only when base is absent.
  let headBranch = "";
  if (!baseInFm) {
    if (repoPath) {
      try {
        headBranch = repo.headBranch(repoPath);
      } catch {
        headBranch = "";
      }
    }
  }

  // (c) Stamp base from HEAD (no-ops if base is already present in frontmatter).
  const stamped = stampBase(raw, headBranch);

  // (d) Shape validation via parsePacketShape.
  const runId = filename ? filename.replace(/\.md$/, "") : undefined;
  const shape = parsePacketShape(stamped, runId);

  // (e) Filesystem verify: repo is a valid git repository, base branch exists.
  let repoValid = false;
  let baseExists = false;
  let base = "";

  if (shape.ok) {
    base = shape.packet.frontmatter.base;
    if (repoPath) {
      repoValid = repo.repoValid(repoPath);
      if (repoValid) {
        baseExists = repo.branchExists(repoPath, base);
      }
    }
  }

  return {
    repoPath,
    baseInFm,
    headBranch,
    stamped,
    shape,
    repoValid,
    baseExists,
    base,
  };
};
