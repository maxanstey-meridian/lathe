export class RepositoryLeaseLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepositoryLeaseLostError";
  }
}
