/** An error with a status and a stable code that is safe to show the client. */
export class CoordinatorError extends Error {
  constructor(
    public readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 413 | 415 | 422 | 429 | 503,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CoordinatorError";
  }
}

export const notFound = () => new CoordinatorError(404, "not_found", "Not found.");
