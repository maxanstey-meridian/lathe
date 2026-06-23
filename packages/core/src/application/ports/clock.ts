// Clock port: the interface that use cases depend on (ARCHITECTURE §3.2).
// The door for a test double is right here — receive a Clock via the ports bag,
// do NOT import the system clock directly.

export type Clock = {
  now(): number;
  nowIso(): string;
};
