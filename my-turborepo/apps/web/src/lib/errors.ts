import { MESSAGES } from "@/lib/messages";

// Cognito error names mapped to text we are willing to show a user. Anything
// not listed here falls through to the caller's fallback, so raw AWS strings
// ("User does not exist.", internal exception text) never reach the screen.
//
// UserNotFoundException and NotAuthorizedException deliberately share one
// message: telling them apart is a user-enumeration oracle, letting an attacker
// discover which emails have accounts by watching which error comes back.
const AUTH_ERROR_MESSAGES: Record<string, string> = {
  UserNotFoundException: MESSAGES.AUTH_INVALID_CREDENTIALS,
  NotAuthorizedException: MESSAGES.AUTH_INVALID_CREDENTIALS,
  UserNotConfirmedException: MESSAGES.AUTH_NOT_CONFIRMED,
  // Sign-up genuinely has to say the address is taken, or the user is stuck
  // with no way forward. This one leaks existence by necessity, not oversight.
  UsernameExistsException: MESSAGES.AUTH_ACCOUNT_EXISTS,
  CodeMismatchException: MESSAGES.AUTH_CODE_INVALID,
  ExpiredCodeException: MESSAGES.AUTH_CODE_EXPIRED,
  InvalidPasswordException: MESSAGES.AUTH_PASSWORD_REQUIREMENTS,
  LimitExceededException: MESSAGES.AUTH_TOO_MANY_ATTEMPTS,
  TooManyRequestsException: MESSAGES.AUTH_TOO_MANY_ATTEMPTS,
  TooManyFailedAttemptsException: MESSAGES.AUTH_TOO_MANY_ATTEMPTS,
};

// Returns text safe to display. Never returns `error.message` — an unrecognised
// error yields the caller's fallback rather than leaking provider internals.
export function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) {
    const mapped = AUTH_ERROR_MESSAGES[error.name];
    if (mapped !== undefined) return mapped;
  }
  return fallback;
}

// Amplify throws this when a session already exists — a stale localStorage
// session, or another tab that signed in while this page was open. It means the
// user IS authenticated, so callers should proceed instead of showing an error.
export function isAlreadyAuthenticated(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === "UserAlreadyAuthenticatedException"
  );
}
