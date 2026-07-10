export type VerificationProcessEvent =
  | { kind: "started"; commandId: string; command: string }
  | {
      kind: "output";
      commandId: string;
      command: string;
      stream: "stdout" | "stderr";
      chunk: string;
    }
  | {
      kind: "finished";
      commandId: string;
      command: string;
      exitCode: number;
      timedOut: boolean;
    };

export type VerificationPhase = "report" | "convergence" | "autofix";

export type DriverOutput = {
  verification(runId: string, phase: VerificationPhase, event: VerificationProcessEvent): void;
};

export const noopDriverOutput: DriverOutput = { verification: () => {} };
