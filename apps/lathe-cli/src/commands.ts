// ---------------------------------------------------------------------------
// @lathe/cli commands — the testable core behind the `lathe` bin.
//
// P05 cutover: mutating commands (enqueue, chain add, abort, accept, reject,
// and the queue add/drop aliases) plus read commands (status, review, queue
// list, get, tail) go through the daemon — the single owner of run state — over
// the generated openapi-fetch client.
//
// Everything here is parameterised over a CliEnv (daemon client + reachability
// probe + output sinks) so the commands can be driven in tests against a stub
// or an in-process app, with no process.exit and no network. index.ts is the
// thin entry that builds the real env and dispatches argv.
// ---------------------------------------------------------------------------

import type { paths } from "@lathe/contract";
import type { ReviewDto, RunDetailDto, StatusDto, TailEvent, TailSnapshotDto } from "@lathe/contract";
import { loadConfig } from "@lathe/core";
import { runTailUi } from "@lathe/core/tail";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { createDaemonClient, type DaemonClient } from "./client.js";
import { cmdDb } from "./db.js";

// ---------------------------------------------------------------------------
// CLI environment — the seams the commands need, injectable for tests.
// ---------------------------------------------------------------------------

export interface CliEnv {
  client: DaemonClient;
  isDaemonUp: () => Promise<boolean>;
  log: (line: string) => void;
  err: (line: string) => void;
}

/**
 * Keeps daemon command response types tied to the generated OpenAPI contract
 * without repeating the full indexed-access chain at every call site.
 *
 * Before:
 *   paths["/runs"]["post"]["responses"][202]["content"]["application/json"]
 *
 * Now:
 *   PathJsonResponse<"/runs", "post", 202>
 *
 * That example is the JSON body returned by `POST /runs` when enqueue succeeds.
 */
type PathJsonResponse<
  Path extends keyof paths,
  Method extends keyof paths[Path],
  Status extends paths[Path][Method] extends { responses: infer Responses } ? keyof Responses : never,
> = paths[Path][Method] extends { responses: infer Responses }
  ? Status extends keyof Responses
    ? Responses[Status] extends { content: { "application/json": infer Json } }
      ? Json
      : never
    : never
  : never;

// Probe daemon reachability over the generated client (GET /config) — no raw
// fetch. A refused connection rejects the promise; treat that as "down".
export const checkDaemon = async (client: DaemonClient): Promise<boolean> => {
  try {
    const { response } = await client.GET("/config");
    return response.ok;
  } catch {
    return false;
  }
};

// The real environment: client + reachability + console sinks.
export const makeEnv = (): CliEnv => {
  const { config } = loadConfig();
  const baseUrl = `http://${config.daemon.host}:${config.daemon.port}`;
  const client = createDaemonClient(baseUrl);
  return {
    client,
    isDaemonUp: () => checkDaemon(client),
    log: (line) => console.log(line),
    err: (line) => console.error(line),
  };
};

// ---------------------------------------------------------------------------
// Daemon call wrapper
// ---------------------------------------------------------------------------

// openapi-fetch returns { data, error, response }: on a 2xx `data` is the parsed
// success DTO; on a non-2xx `error` is the parsed error body and `response`
// carries the status. The contract declares only success responses, so `error`
// is typed `never` — we read it as unknown rather than casting the response.
const errorDetail = (error: unknown): string => {
  if (typeof error === "string") {
    return error;
  }
  if (error && typeof error === "object") {
    const e = error as { message?: unknown; error?: unknown };
    if (typeof e.message === "string") {
      return e.message;
    }
    if (typeof e.error === "string") {
      return e.error;
    }
  }
  return "";
};

// Run a mutating command against the daemon. fn issues the typed call; we map a
// 2xx to exit 0 (after onOk), and route failures through onErr for status-
// specific messages, falling back to a generic daemon-error line.
const runDaemon = async <T>(
  env: CliEnv,
  fn: (client: DaemonClient) => Promise<{ data?: T; error?: unknown; response: Response }>,
  onOk: (data: T) => void,
  onErr?: (status: number, detail: string, error: unknown) => boolean,
): Promise<number> => {
  if (!(await env.isDaemonUp())) {
    env.err("no daemon running — start `lathe serve` first");
    return 1;
  }

  const { data, error, response } = await fn(env.client);
  if (response.ok && data !== undefined) {
    onOk(data);
    return 0;
  }

  const detail = errorDetail(error);
  if (onErr?.(response.status, detail, error)) {
    return 1;
  }
  env.err(`daemon error (${response.status}): ${detail}`);
  return 1;
};

// ---------------------------------------------------------------------------
// Mutating commands — always go through the daemon
// ---------------------------------------------------------------------------

export const cmdEnqueue = (env: CliEnv, packetPath: string): Promise<number> => {
  if (!packetPath) {
    env.err("usage: lathe enqueue <packet.md>");
    return Promise.resolve(1);
  }
  const resolved = resolve(packetPath);
  if (!existsSync(resolved)) {
    env.err(`no such file: ${resolved}`);
    return Promise.resolve(1);
  }

  return runDaemon<PathJsonResponse<"/runs", "post", 202>>(
    env,
    (client) => client.POST("/runs", { body: { packetPath: resolved } }),
    (data) => env.log(`enqueued: ${data.runId} (${data.status})`),
    (status) => {
      if (status === 400) {
        env.err("packet rejected by daemon");
        return true;
      }
      return false;
    },
  );
};

export const cmdChain = (env: CliEnv, dir: string): Promise<number> => {
  if (!dir) {
    env.err("usage: lathe chain add <dir>");
    return Promise.resolve(1);
  }
  const resolved = resolve(dir);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    env.err(`not a directory: ${resolved}`);
    return Promise.resolve(1);
  }

  return runDaemon<PathJsonResponse<"/chains", "post", 202>>(
    env,
    (client) => client.POST("/chains", { body: { chainDir: resolved } }),
    (runs) => {
      for (const run of runs) {
        env.log(`enqueued: ${run.runId} (${run.status})`);
      }
    },
  );
};

export const cmdStop = (env: CliEnv, runId: string): Promise<number> => {
  if (!runId) {
    env.err("usage: lathe cancel <runId>");
    return Promise.resolve(1);
  }

  return runDaemon<PathJsonResponse<"/runs/{runId}/stop", "post", 202>>(
    env,
    (client) => client.POST("/runs/{runId}/stop", { params: { path: { runId } } }),
    (data) => env.log(`${data.cancellationRequested ? "cancellation requested" : "cancelled"}: ${data.runId} (${data.status})`),
    (status) => {
      if (status === 404) {
        env.err(`run ${runId} not found`);
        return true;
      }
      return false;
    },
  );
};

export const cmdAnswer = (env: CliEnv, runId: string, answer: string): Promise<number> => {
  const decision = answer.trim();
  if (!runId || !decision) {
    env.err("usage: lathe resolve <runId> <decision>");
    return Promise.resolve(1);
  }

  return runDaemon<PathJsonResponse<"/runs/{runId}/answer", "post", 201>>(
    env,
    (client) =>
      client.POST("/runs/{runId}/answer", {
        params: { path: { runId } },
        body: { answer: decision },
      }),
    (data) => env.log(`resolved: ${data.runId} (${data.status})`),
    (status, detail) => {
      if (status === 404) {
        env.err(`run ${runId} not found`);
        return true;
      }
      if (status === 409) {
        env.err(detail || `run ${runId} is not answerable`);
        return true;
      }
      return false;
    },
  );
};

export const cmdAccept = (env: CliEnv, runId: string): Promise<number> => {
  if (!runId) {
    env.err("usage: lathe prepare <runId>");
    return Promise.resolve(1);
  }

  return runDaemon<PathJsonResponse<"/runs/{runId}/accept", "post", 201>>(
    env,
    (client) => client.POST("/runs/{runId}/accept", { params: { path: { runId } } }),
    (data) => env.log(`prepared for merge: ${data.runId} (${data.status})`),
    (status, detail, error) => {
      if (status === 409) {
        const e = error as { code?: string };
        if (e.code === "accept_refused") {
          env.err(`${runId} cannot be prepared for merge — acceptance review must pass first`);
          return true;
        }
        const match = detail.match(/prepare (.+) first/);
        const chainTip = match ? match[1] : "a chain tip";
        env.err(`${runId} is not a chain tip — prepare ${chainTip} first`);
        return true;
      }
      return false;
    },
  );
};

export const cmdReject = (env: CliEnv, runId: string, reason: string): Promise<number> => {
  const requiredChanges = reason.trim();
  if (!runId || !requiredChanges) {
    env.err("usage: lathe request-changes <runId> <required changes>");
    return Promise.resolve(1);
  }

  return runDaemon<PathJsonResponse<"/runs/{runId}/reject", "post", 201>>(
    env,
    (client) =>
      client.POST("/runs/{runId}/reject", {
        params: { path: { runId } },
        body: { reason: requiredChanges },
      }),
    (data) => env.log(`changes requested: ${data.runId} (${data.status})`),
    (status) => {
      if (status === 404) {
        env.err(`run ${runId} not found`);
        return true;
      }
      return false;
    },
  );
};

// ---------------------------------------------------------------------------
// Read commands — status/review/queue/get/tail go through the daemon.
// ---------------------------------------------------------------------------

export type TailDeps = {
  openTailUi: (snapshot: TailSnapshotDto, subscribe: (onEvent: (event: TailEvent) => void) => { close: () => void }) => number;
  streamTailEvents: (target: string, lastSeq: number, onEvent: (event: TailEvent) => void) => Promise<void>;
  stdoutIsTTY: () => boolean;
  startPolling: (poll: () => void) => () => void;
  onSigint: (handler: () => void) => void;
  exit: (code: number) => never;
};

const streamTailEvents = async (
  baseUrl: string,
  target: string,
  lastSeq: number,
  onEvent: (event: TailEvent) => void,
): Promise<void> => {
  const encoded = target === "active" ? "active" : encodeURIComponent(target);
  const res = await fetch(`${baseUrl}/tail/${encoded}/events`, {
    headers: lastSeq > 0 ? { "Last-Event-ID": String(lastSeq) } : undefined,
  });
  if (!res.ok || !res.body) {
    throw new Error(`tail stream failed (${res.status})`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      return;
    }
    buffer += decoder.decode(value, { stream: true });
    let frameEnd = buffer.indexOf("\n\n");
    while (frameEnd !== -1) {
      const frame = buffer.slice(0, frameEnd);
      buffer = buffer.slice(frameEnd + 2);
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data) {
        onEvent(JSON.parse(data) as TailEvent);
      }
      frameEnd = buffer.indexOf("\n\n");
    }
  }
};

const openTailDeps = (): TailDeps => {
  const { config, paths: configPaths } = loadConfig();
  const baseUrl = `http://${config.daemon.host}:${config.daemon.port}`;
  void configPaths;
  return {
    openTailUi: (snapshot, subscribe) => {
      runTailUi({ snapshot, subscribe });
      return -1;
    },
    streamTailEvents: (runId, lastSeq, onEvent) => streamTailEvents(baseUrl, runId, lastSeq, onEvent),
    stdoutIsTTY: () => process.stdout.isTTY === true,
    startPolling: (poll) => {
      const interval = setInterval(poll, 1000);
      return () => clearInterval(interval);
    },
    onSigint: (handler) => process.on("SIGINT", handler),
    exit: (code) => process.exit(code),
  };
};

const renderStatusDto = (status: StatusDto): string => {
  const lines: string[] = [];

  if (status.activeRuns.length > 0) {
    for (const run of status.activeRuns) {
      lines.push(`ACTIVE: ${run.runId}  (${run.outcomes})`);
      if (run.gateLatched) {
        lines.push(`  gate latched: ${run.gateLatched}`);
      }
      for (const event of run.recentEvents) {
        lines.push(`  ${event.at.slice(11, 19)} ${event.event}`);
      }
    }
  } else {
    lines.push("no active run");
  }

  if (status.queued.length > 0) {
    lines.push(`queued: ${status.queued.map((q) => q.runId).join(", ")}`);
  }

  for (const parked of status.parked) {
    const retries = parked.stallRetries
      ? `, ${parked.stallRetries} auto-retr${parked.stallRetries === 1 ? "y" : "ies"}`
      : "";
    lines.push(
      `parked: ${parked.runId} (${parked.blockedReason ?? "?"}${retries}) — ${(parked.blockedQuestion ?? "").slice(0, 100)}`,
    );
  }

  if (status.campaigns.length > 0) {
    lines.push("campaigns:");
    for (const campaign of status.campaigns) {
      const mark = campaign.status === "converged" ? "✅" : campaign.status === "needs_max" ? "🅿" : "…";
      lines.push(
        `  ${mark} ${campaign.campaignId}  [${campaign.status}]  pass ${campaign.pass}/${campaign.maxPasses}  — ${campaign.originalIntent.slice(0, 60)}`,
      );
    }
  }

  if (status.staged.length > 0) {
    lines.push("chain (staged):");
    for (const staged of status.staged) {
      const parent = staged.parentRunId ? `← ${staged.parentRunId}` : "(no parent — head)";
      lines.push(`  … ${staged.runId}  ${parent}`);
    }
  }

  const reviewCount = status.review.readyForReview + status.review.failed;
  if (reviewCount > 0) {
    const parts = [
      status.review.failed > 0 ? `${status.review.failed} failed` : "",
      status.review.readyForReview > 0 ? `${status.review.readyForReview} ready` : "",
    ].filter((part) => part.length > 0);
    lines.push(`review: ${parts.join(", ")} — lathe review`);
  }

  return lines.join("\n");
};

const renderReviewDto = (review: ReviewDto): string => {
  if (review.runs.length === 0) {
    return "nothing to review";
  }

  const lines: string[] = [];
  for (const run of review.runs) {
    const icon =
      run.status === "ready_for_review"
        ? "✅"
        : run.status === "accepted"
          ? "☑"
          : run.status === "blocked"
            ? "🅿"
            : run.status === "failed"
              ? "❌"
              : "⏸";
    lines.push(`${icon} ${run.runId}  [${run.status}]  ${run.outcomes}  branch ${run.branch}`);
    if (run.status === "blocked") {
      lines.push(`   needs: ${run.blockedQuestion ?? "(no question recorded)"}`);
      lines.push(`   resolve with: lathe resolve ${run.runId} "<your decision>"`);
    }
    if (run.status === "failed") {
      lines.push(`   retry with context: lathe resolve ${run.runId} "<context for the retry>"`);
    }
    if (run.status === "ready_for_review") {
      lines.push(`   diff:   git -C ${run.repo} diff ${run.base}...${run.branch}`);
      lines.push(
        `   prepare: lathe prepare ${run.runId}   (fetches the reviewed campaign tip; you merge manually)`,
      );
    }
  }
  return lines.join("\n");
};

const renderQueueDto = (status: StatusDto): string => {
  if (status.queued.length === 0) {
    return "queue is empty";
  }
  return status.queued.map((entry, index) => `${index + 1}. ${entry.runId}`).join("\n");
};

const renderRunDetailDto = (run: RunDetailDto): string[] => {
  const lines = [
    `run: ${run.runId}`,
    `  status:    ${run.status}`,
    `  campaign:  ${run.campaignId}`,
    `  base:      ${run.base}`,
    `  branch:    ${run.branch}`,
    `  pass:      ${run.pass}`,
    `  worktree:  ${run.worktreePath}`,
  ];
  if (run.parentRunId) {
    lines.push(`  parent:    ${run.parentRunId}`);
  }
  if (run.expectedSurface.length > 0) {
    lines.push(`  surface:   ${run.expectedSurface.join(", ")}`);
  }
  if (run.turn !== 0) {
    lines.push(`  turn:      ${run.turn}`);
  }
  if (run.contextTokens !== 0) {
    lines.push(`  ctx:       ${run.contextTokens}/${run.contextWindow}`);
  }
  if (run.outcomes) {
    lines.push(`  outcomes: ${run.outcomes}`);
  }
  if (run.blockedReason) {
    lines.push(`  blocked:  ${run.blockedReason}`);
  }
  if (run.blockedQuestion) {
    lines.push(`  question: ${run.blockedQuestion}`);
  }
  return lines;
};

export const cmdStatus = (env: CliEnv): Promise<number> =>
  runDaemon<PathJsonResponse<"/status", "get", 200>>(
    env,
    (client) => client.GET("/status"),
    (data) => env.log(renderStatusDto(data)),
  );

export const cmdReview = (env: CliEnv): Promise<number> =>
  runDaemon<PathJsonResponse<"/review", "get", 200>>(
    env,
    (client) => client.GET("/review"),
    (data) => env.log(renderReviewDto(data)),
  );

// `queue` lists through daemon status; `queue add`/`queue drop` are daemon
// aliases for enqueue/stop, so they never mutate the Store behind the daemon's
// back.
export const cmdQueue = (env: CliEnv, args: string[]): Promise<number> => {
  const sub = args[0];
  if (sub === "add") {
    if (!args[1]) {
      env.err("usage: lathe queue add <packet.md>");
      return Promise.resolve(1);
    }
    return cmdEnqueue(env, args[1]);
  }
  if (sub === "drop") {
    if (!args[1]) {
      env.err("usage: lathe queue drop <runId>");
      return Promise.resolve(1);
    }
    return cmdStop(env, args[1]);
  }
  return runDaemon<PathJsonResponse<"/status", "get", 200>>(
    env,
    (client) => client.GET("/status"),
    (data) => env.log(renderQueueDto(data)),
  );
};

export const cmdGet = (env: CliEnv, runId: string): Promise<number> => {
  if (!runId) {
    env.err("usage: lathe get <runId>");
    return Promise.resolve(1);
  }

  return runDaemon<PathJsonResponse<"/runs/{runId}", "get", 200>>(
    env,
    (client) => client.GET("/runs/{runId}", { params: { path: { runId } } }),
    (data) => {
      for (const line of renderRunDetailDto(data)) {
        env.log(line);
      }
    },
    (status) => {
      if (status === 404) {
        env.err(`run ${runId} not found`);
        return true;
      }
      return false;
    },
  );
};

const renderTailSnapshot = (snapshot: TailSnapshotDto): string =>
  snapshot.journal.map((entry) => entry.line).join("\n");

const printTailSnapshot = (env: CliEnv, snapshot: TailSnapshotDto): void => {
  const replay = renderTailSnapshot(snapshot);
  if (replay) {
    env.log(replay);
  }
};

const printTailEvent = (env: CliEnv, event: TailEvent): void => {
  if (event.kind === "tail.journal") {
    env.log(event.line);
  } else if (event.kind === "tail.run.changed" && event.snapshot) {
    printTailSnapshot(env, event.snapshot);
  }
};

const fetchTailSnapshot = async (
  env: CliEnv,
  runId: string | undefined,
): Promise<TailSnapshotDto | null | undefined> => {
  if (runId) {
    const { data, response } = await env.client.GET("/tail/{runId}", { params: { path: { runId } } });
    if (response.status === 404) {
      return undefined;
    }
    return response.ok ? data : undefined;
  }
  const { data, response } = await env.client.GET("/tail/active");
  return response.ok ? data ?? null : undefined;
};

const followTailSnapshot = async (
  env: CliEnv,
  deps: TailDeps,
  snapshot: TailSnapshotDto,
  autoAdvance: boolean,
): Promise<void> => {
  try {
    await deps.streamTailEvents(autoAdvance ? "active" : snapshot.runId, snapshot.lastSeq, (event) =>
      printTailEvent(env, event),
    );
  } catch (err) {
    env.err(err instanceof Error ? err.message : String(err));
  }
};

const openDaemonTailUi = (deps: TailDeps, snapshot: TailSnapshotDto, autoAdvance: boolean): void => {
  deps.openTailUi(snapshot, (onEvent) => {
    let closed = false;
    const target = autoAdvance ? "active" : snapshot.runId;
    void deps.streamTailEvents(target, snapshot.lastSeq, (event) => {
      if (!closed) {
        onEvent(event);
      }
    });
    return {
      close: () => {
        closed = true;
      },
    };
  });
};

const daemonPlainTail = async (
  env: CliEnv,
  deps: TailDeps,
  runId: string | undefined,
  follow: boolean,
): Promise<void> => {
  if (!(await env.isDaemonUp())) {
    env.err("no daemon running — start `lathe serve` first");
    return;
  }

  const snapshot = await fetchTailSnapshot(env, runId);
  if (snapshot === undefined) {
    env.err(runId ? `run ${runId} not found` : "daemon tail request failed");
    return;
  }
  if (snapshot === null) {
    if (!follow) {
      env.log("no active run");
      return;
    }
    env.log("no active run or convergence — waiting for one to start…");
    let polling = false;
    let cancelPoll = (): void => {};
    cancelPoll = deps.startPolling(() => {
      if (polling) {
        return;
      }
      polling = true;
      void fetchTailSnapshot(env, undefined)
        .then((next) => {
          if (next && next !== null) {
            cancelPoll();
            env.log(`run ${next.runId} became active — tailing…`);
            printTailSnapshot(env, next);
            void followTailSnapshot(env, deps, next, true);
          }
        })
        .finally(() => {
          polling = false;
        });
    });
    deps.onSigint(() => {
      cancelPoll();
      deps.exit(0);
    });
    return;
  }

  printTailSnapshot(env, snapshot);
  if (follow) {
    await followTailSnapshot(env, deps, snapshot, runId === undefined);
  }
};

export const cmdTail = async (env: CliEnv, args: string[], deps = openTailDeps()): Promise<void> => {
  const follow = !args.includes("--no-follow");
  const plain = args.includes("--plain");
  const explicit = args.find((a) => !a.startsWith("--"));

  if (plain || !deps.stdoutIsTTY() || !follow) {
    await daemonPlainTail(env, deps, explicit, follow);
    return;
  }

  if (!(await env.isDaemonUp())) {
    env.err("no daemon running — start `lathe serve` first");
    return;
  }

  const autoAdvance = explicit === undefined;
  const snapshot = await fetchTailSnapshot(env, explicit);

  if (snapshot === undefined) {
    env.err(explicit ? `run ${explicit} not found` : "daemon tail request failed");
    return;
  }

  if (snapshot === null) {
    env.log("no active run or convergence — waiting for one to start…");
    let polling = false;
    let cancelPoll = (): void => {};
    cancelPoll = deps.startPolling(() => {
      if (polling) {
        return;
      }
      polling = true;
      void fetchTailSnapshot(env, undefined)
        .then((next) => {
          if (next && next !== null) {
            cancelPoll();
            env.log(`run ${next.runId} became active — tailing…`);
            openDaemonTailUi(deps, next, true);
          }
        })
        .finally(() => {
          polling = false;
        });
    });
    deps.onSigint(() => {
      cancelPoll();
      deps.exit(0);
    });
    return;
  }

  openDaemonTailUi(deps, snapshot, autoAdvance);
};

// ---------------------------------------------------------------------------
// Plan commands — pre-queue draft shelf (via daemon)
// ---------------------------------------------------------------------------

export const cmdPlanAdd = (env: CliEnv, packetPath: string): Promise<number> => {
  if (!packetPath) {
    env.err("usage: lathe plan add <file.md>");
    return Promise.resolve(1);
  }
  const resolved = resolve(packetPath);
  if (!existsSync(resolved)) {
    env.err(`no such file: ${resolved}`);
    return Promise.resolve(1);
  }
  const content = readFileSync(resolved, "utf-8");
  const filename = basename(resolved);

  return runDaemon<PathJsonResponse<"/plans", "post", 201>>(
    env,
    (client) => client.POST("/plans", { body: { content, filename } }),
    (data) => env.log(`plan added: ${data.planId} (${data.title})`),
  );
};

export const cmdPlanList = (env: CliEnv): Promise<number> =>
  runDaemon<PathJsonResponse<"/plans", "get", 200>>(
    env,
    (client) => client.GET("/plans"),
    (data) => {
      if (data.length === 0) {
        env.log("no plans");
        return;
      }
      for (const plan of data) {
        const queued = plan.queuedRunId ? " [queued]" : "";
        const tags = plan.tags.length > 0 ? ` (${plan.tags.join(", ")})` : "";
        env.log(`  ${plan.planId} — ${plan.title}${tags}${queued}`);
      }
    },
  );

export const cmdPlanShow = (env: CliEnv, planId: string): Promise<number> => {
  if (!planId) {
    env.err("usage: lathe plan show <planId>");
    return Promise.resolve(1);
  }

  return runDaemon<PathJsonResponse<"/plans/{planId}", "get", 200>>(
    env,
    (client) => client.GET("/plans/{planId}", { params: { path: { planId } } }),
    (data) => {
      env.log(`plan: ${data.planId}`);
      env.log(`title: ${data.title}`);
      env.log(`tags: ${data.tags.join(", ") || "(none)"}`);
      env.log(`queued: ${data.queuedRunId ?? "no"}`);
      env.log("");
      env.log(data.raw);
    },
    (status) => {
      if (status === 404) {
        env.err(`plan ${planId} not found`);
        return true;
      }
      return false;
    },
  );
};

export const cmdPlanQueue = (env: CliEnv, planId: string): Promise<number> => {
  if (!planId) {
    env.err("usage: lathe plan queue <planId>");
    return Promise.resolve(1);
  }

  return runDaemon<PathJsonResponse<"/plans/{planId}/queue", "post", 200>>(
    env,
    (client) => client.POST("/plans/{planId}/queue", { params: { path: { planId } } }),
    (data) => env.log(`queued: ${data.runId}`),
    (status) => {
      if (status === 404) {
        env.err(`plan ${planId} not found`);
        return true;
      }
      if (status === 400) {
        env.err(`plan ${planId} failed admission`);
        return true;
      }
      return false;
    },
  );
};

export const cmdPlanDelete = (env: CliEnv, planId: string): Promise<number> => {
  if (!planId) {
    env.err("usage: lathe plan delete <planId>");
    return Promise.resolve(1);
  }

  return runDaemon<PathJsonResponse<"/plans/{planId}", "delete", 200>>(
    env,
    (client) => client.DELETE("/plans/{planId}", { params: { path: { planId } } }),
    () => env.log(`deleted: ${planId}`),
    (status) => {
      if (status === 404) {
        env.err(`plan ${planId} not found`);
        return true;
      }
      return false;
    },
  );
};

export const cmdPlan = (env: CliEnv, args: string[]): Promise<number> => {
  const sub = args[0];
  if (sub === "add") {
    return cmdPlanAdd(env, args[1] ?? "");
  }
  if (sub === "list") {
    return cmdPlanList(env);
  }
  if (sub === "show") {
    return cmdPlanShow(env, args[1] ?? "");
  }
  if (sub === "queue") {
    return cmdPlanQueue(env, args[1] ?? "");
  }
  if (sub === "delete") {
    return cmdPlanDelete(env, args[1] ?? "");
  }
  env.err("usage: lathe plan <add|list|show|queue|delete> [args]");
  return Promise.resolve(1);
};

// ---------------------------------------------------------------------------
// Dispatch — returns an exit code; never calls process.exit (testable).
// `serve` and `tail` are handled by index.ts (they don't return an exit code).
// ---------------------------------------------------------------------------

export const usage = `lathe — supervised executor of human-written work packets

  lathe serve                  boot the daemon (always-on run engine + HTTP API)
  lathe enqueue <packet.md>    add a packet to the queue (via daemon)
  lathe chain add <dir>        stage a chain of packets (via daemon)
  lathe cancel <runId>         cancel queued or running work (via daemon)
  lathe resolve <runId> <decision>  resolve a run that needs input and resume it
  lathe prepare <runId>        prepare acceptance-reviewed work for manual merge
  lathe request-changes <runId> <changes>  return review-ready work for repair
  lathe status                 what is running / queued / parked + campaign convergence
  lathe review                 morning triage: terminal statuses, outcomes, questions
  lathe queue [add|drop]       list the queue / add or drop a packet (via daemon)
  lathe plan <add|list|show|queue|delete> [args]  manage draft plans (via daemon)
  lathe get <runId>            show run details (via daemon)
  lathe tail [runId]           live journal stream for a run (via daemon)
  lathe db <command> [args]    read-only SQLite inspector (defaults to active run; --json for raw)
`;

export const runCommand = async (env: CliEnv, command: string, args: string[]): Promise<number> => {
  switch (command) {
    case "--help":
    case "-h":
      env.log(usage);
      return 0;
    case "enqueue":
      return cmdEnqueue(env, args[0] ?? "");
    case "chain":
      if (args[0] !== "add") {
        env.err("usage: lathe chain add <dir>");
        return 1;
      }
      return cmdChain(env, args[1] ?? "");
    case "cancel":
    case "stop":
      return cmdStop(env, args[0] ?? "");
    case "resolve":
    case "answer":
      return cmdAnswer(env, args[0] ?? "", args.slice(1).join(" "));
    case "prepare":
    case "accept":
      return cmdAccept(env, args[0] ?? "");
    case "request-changes":
      return cmdReject(env, args[0] ?? "", args.slice(1).join(" "));
    case "reject":
      return cmdReject(env, args[0] ?? "", args.slice(1).join(" ") || "rejected");
    case "status":
      return cmdStatus(env);
    case "review":
      return cmdReview(env);
    case "queue":
      return cmdQueue(env, args);
    case "plan":
      return cmdPlan(env, args);
    case "get":
      return cmdGet(env, args[0] ?? "");
    case "db":
      return cmdDb(env, args);
    default:
      env.log(usage);
      return command ? 1 : 0;
  }
};
