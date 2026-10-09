import { isAxiosError } from "axios";
import { AuthErrorResponseSchema, type AuthErrorCode } from "@repo/shared";
import { MESSAGES } from "@/lib/messages";

// A refused auth call, carrying the server's stable code (ADR-0011).
//
// The server never forwards Cognito's own text, so there is nothing raw to
// leak here: the page maps a fixed set of codes to its own copy, and anything
// else (a network drop, a 5xx) falls back to the caller's message.
export class AuthApiError extends Error {
  readonly code: AuthErrorCode;

  constructor(code: AuthErrorCode) {
    super(code);
    this.name = "AuthApiError";
    this.code = code;
  }
}

// Turns whatever an auth call threw into an AuthApiError when the server said
// why, and leaves it alone otherwise.
export function toAuthApiError(error: unknown): unknown {
  if (!isAxiosError(error)) return error;
  const parsed = AuthErrorResponseSchema.safeParse(error.response?.data);
  return parsed.success ? new AuthApiError(parsed.data.code) : error;
}

// Codes mapped to text for the sign-in, sign-up and confirm forms.
//
// INVALID_CREDENTIALS is already one code for an unknown email and a wrong
// password — the server collapses them so the response is no enumeration
// oracle — and it gets one message here for the same reason.
const AUTH_ERROR_MESSAGES: Partial<Record<AuthErrorCode, string>> = {
  INVALID_CREDENTIALS: MESSAGES.AUTH_INVALID_CREDENTIALS,
  NOT_CONFIRMED: MESSAGES.AUTH_NOT_CONFIRMED,
  // Sign-up genuinely has to say the address is taken, or the user is stuck
  // with no way forward. This one leaks existence by necessity, not oversight.
  ACCOUNT_EXISTS: MESSAGES.AUTH_ACCOUNT_EXISTS,
  CODE_INVALID: MESSAGES.AUTH_CODE_INVALID,
  CODE_EXPIRED: MESSAGES.AUTH_CODE_EXPIRED,
  PASSWORD_REQUIREMENTS: MESSAGES.AUTH_PASSWORD_REQUIREMENTS,
  // The pre sign-up trigger refuses an address and a failed human check under
  // one Cognito exception; the server tells them apart, because sending
  // someone who failed the check off to find another address fails again.
  EMAIL_NOT_ALLOWED: MESSAGES.AUTH_EMAIL_NOT_ALLOWED,
  HUMAN_CHECK_FAILED: MESSAGES.AUTH_HUMAN_CHECK_FAILED,
  TOO_MANY_ATTEMPTS: MESSAGES.AUTH_TOO_MANY_ATTEMPTS,
  SIGNIN_EXPIRED: MESSAGES.AUTH_SIGNIN_EXPIRED,
};

// A second, smaller table for MFA-context calls (MfaSettings.tsx and the
// sign-in TOTP step), kept apart on purpose: INVALID_CREDENTIALS reads
// "Incorrect email or password", which makes no sense on a settings screen that
// never asked for one. Here a dead session says so instead.
const MFA_ERROR_MESSAGES: Partial<Record<AuthErrorCode, string>> = {
  CODE_INVALID: MESSAGES.AUTH_CODE_INVALID,
  CODE_EXPIRED: MESSAGES.AUTH_CODE_EXPIRED,
  // Disabling TOTP that was never set up — the screen only offers Disable
  // once it has, so this reads as "something already changed".
  MFA_NOT_FOUND: MESSAGES.AUTH_MFA_NOT_FOUND,
  TOO_MANY_ATTEMPTS: MESSAGES.AUTH_TOO_MANY_ATTEMPTS,
  SIGNIN_EXPIRED: MESSAGES.AUTH_SIGNIN_EXPIRED,
  UNAUTHENTICATED: MESSAGES.AUTH_SESSION_EXPIRED,
};

function codeOf(error: unknown): AuthErrorCode | undefined {
  return error instanceof AuthApiError ? error.code : undefined;
}

// Returns text safe to display, or the caller's fallback for anything the
// server did not explain.
export function errorMessage(error: unknown, fallback: string): string {
  const code = codeOf(error);
  return (
    (code !== undefined ? AUTH_ERROR_MESSAGES[code] : undefined) ?? fallback
  );
}

// The MFA-context counterpart. Also logs the code — these screens are reached
// rarely enough that a real failure is worth a trace, and a code carries
// nothing sensitive.
export function mfaErrorMessage(error: unknown, fallback: string): string {
  const code = codeOf(error);
  if (code !== undefined) console.error(`[mfa] ${code}`);
  return (
    (code !== undefined ? MFA_ERROR_MESSAGES[code] : undefined) ?? fallback
  );
}
