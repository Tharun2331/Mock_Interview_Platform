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
  // Raised when the pre sign-up Lambda refuses the address. Cognito wraps the
  // Lambda's own message in "PreSignUp failed with error ...", which is not
  // copy a candidate should see.
  UserLambdaValidationException: MESSAGES.AUTH_EMAIL_NOT_ALLOWED,
  LimitExceededException: MESSAGES.AUTH_TOO_MANY_ATTEMPTS,
  TooManyRequestsException: MESSAGES.AUTH_TOO_MANY_ATTEMPTS,
  TooManyFailedAttemptsException: MESSAGES.AUTH_TOO_MANY_ATTEMPTS,
};

// A second, smaller table for MFA-context calls (MfaSettings.tsx, and the
// sign-in TOTP challenge in signin.tsx), kept apart from AUTH_ERROR_MESSAGES
// on purpose.
//
// The two generic entries there — NotAuthorizedException and
// UserNotFoundException, both mapped to "Incorrect email or password" —
// make sense on a form where a password was just typed. They make no sense
// on a settings screen that never asks for one: fetchMFAPreference() failing
// on a Cognito NotAuthorizedException (raised for reasons that have nothing
// to do with a password, a stale session among them) showed a candidate "did
// you mean to be signed in as someone else" copy on a page that had not
// asked them to authenticate anything. This table omits both, so an
// unrecognised error here falls through to the caller's own, accurate
// fallback instead of borrowing the wrong one.
const MFA_ERROR_MESSAGES: Record<string, string> = {
  CodeMismatchException: MESSAGES.AUTH_CODE_INVALID,
  ExpiredCodeException: MESSAGES.AUTH_CODE_EXPIRED,
  // Wrong code during TOTP setup (VerifySoftwareToken) or during the sign-in
  // challenge (VerifySoftwareTokenMfa). CodeMismatchException is Cognito's
  // name for the same failure in the sign-up path, mapped to identical copy.
  EnableSoftwareTokenMFAException: MESSAGES.AUTH_CODE_INVALID,
  // Raised by updateMFAPreference({ totp: "DISABLED" }) if setup was never
  // completed — the settings screen only ever shows Disable once it has, so
  // this reads as "something already changed" rather than a real failure mode.
  SoftwareTokenMFANotFoundException: MESSAGES.AUTH_MFA_NOT_FOUND,
  LimitExceededException: MESSAGES.AUTH_TOO_MANY_ATTEMPTS,
  TooManyRequestsException: MESSAGES.AUTH_TOO_MANY_ATTEMPTS,
  TooManyFailedAttemptsException: MESSAGES.AUTH_TOO_MANY_ATTEMPTS,
};

// Returns text safe to display. Never returns `error.message` — an unrecognised
// error yields the caller's fallback rather than leaking provider internals.
// The pre sign-up Lambda refuses for two unrelated reasons under one exception
// name: an address it will not accept, and a failed human check (Turnstile).
// Telling a person who failed the human check that their email is not allowed
// sends them off to find another address that will fail the same way.
//
// Told apart by the Lambda's own refusal text, which Cognito wraps in
// "PreSignUp failed with error ...". MUST stay in step with TURNSTILE_REFUSAL in
// infra/terraform/modules/cognito/pre_sign_up/index.mjs; a drift there falls
// back to the address message, which is wrong but not dangerous.
const HUMAN_CHECK_REFUSAL_MARKER = "confirm you are a person";

export function isHumanCheckRefusal(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === "UserLambdaValidationException" &&
    error.message.includes(HUMAN_CHECK_REFUSAL_MARKER)
  );
}

export function errorMessage(error: unknown, fallback: string): string {
  if (isHumanCheckRefusal(error)) return MESSAGES.AUTH_HUMAN_CHECK_FAILED;
  if (error instanceof Error) {
    const mapped = AUTH_ERROR_MESSAGES[error.name];
    if (mapped !== undefined) return mapped;
  }
  return fallback;
}

// The MFA-context counterpart. Also logs the raw error name to the console —
// unlike the sign-in form, these screens are reached far less often, so a real
// failure here is worth a trace even outside a dev build; nothing sensitive is
// in a Cognito exception name.
export function mfaErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) {
    console.error(`[mfa] ${error.name}: ${error.message}`);
    const mapped = MFA_ERROR_MESSAGES[error.name];
    if (mapped !== undefined) return mapped;
  }
  return fallback;
}

// Amplify throws this when a session already exists — a stale localStorage
// session, or another tab that signed in while this page was open. It means the
// user IS authenticated, so callers should proceed instead of showing an error.
export function isAlreadyAuthenticated(error: unknown): boolean {
  return (
    error instanceof Error && error.name === "UserAlreadyAuthenticatedException"
  );
}
