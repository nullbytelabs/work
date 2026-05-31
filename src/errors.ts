/**
 * Errors that carry a message meant for the end user — printed as a clean
 * one-liner by the CLI rather than as an "unexpected error" stack trace.
 * Used for actionable conditions like a missing optional dependency or an
 * unavailable execution target.
 */
export class UserFacingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserFacingError";
  }
}
