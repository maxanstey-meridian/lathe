// Caffeinate port: process power assertion (ARCHITECTURE §3.2).
// Trivial; may fold into run-loop adapter, but declared here for completeness.

export type Caffeinate = {
  holdPowerAssertion(): Promise<void>;
};
