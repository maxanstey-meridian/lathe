export class RunTransitionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunTransitionConflictError";
  }
}
