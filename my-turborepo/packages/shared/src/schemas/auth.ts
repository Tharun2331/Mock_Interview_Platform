import z from "zod";

// Mirrors the Cognito user pool's password_policy (min 8 + upper/lower/number/symbol).
// One definition shared by the sign-up form and the server's sign-up route, so
// the browser and the API refuse exactly the same passwords.
const NewPasswordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters long.")
  .max(256, "Password is too long.")
  .regex(/[a-z]/, "Password must contain a lowercase letter.")
  .regex(/[A-Z]/, "Password must contain an uppercase letter.")
  .regex(/[0-9]/, "Password must contain a number.")
  .regex(/[^A-Za-z0-9]/, "Password must contain a symbol.");

// Sign-up is by email (username_attributes = ["email"]).
export const SignupSchema = z
  .object({
    email: z.email("Enter a valid email address."),
    password: NewPasswordSchema,
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords do not match.",
    path: ["confirmPassword"],
  });

export type SignupInput = z.infer<typeof SignupSchema>;

// Cognito emails a 6-digit confirmation code after sign-up.
export const ConfirmSignupSchema = z.object({
  code: z.string().regex(/^\d{6}$/, "Enter the 6-digit code from your email."),
});

export type ConfirmSignupInput = z.infer<typeof ConfirmSignupSchema>;

// Correcting a mistyped address on the confirm page. Email only: the address is
// the Cognito username, so changing it restarts sign-up rather than updating the
// pending account in place.
export const ChangeEmailSchema = z.object({
  email: z.email("Enter a valid email address."),
});

export type ChangeEmailInput = z.infer<typeof ChangeEmailSchema>;

// Sign-in only checks that a password was entered — Cognito verifies it.
// (The full complexity rules live on SignupSchema, where they're enforced.)
export const SigninSchema = z.object({
  email: z.email("Enter a valid email address."),
  password: z.string().min(1, "Enter your password."),
});

export type SignInInput = z.infer<typeof SigninSchema>;

// A 6-digit code from an authenticator app. Same shape as ConfirmSignupSchema's
// email code, kept separate because the two mean different things and a shared
// name would blur which flow a validation error belongs to: this one covers
// both TOTP enrollment (verifyTOTPSetup) and the sign-in challenge
// (confirmSignIn), which take the same input shape.
export const TotpCodeSchema = z.object({
  code: z.string().regex(/^\d{6}$/, "Enter the 6-digit code from your app."),
});

export type TotpCodeInput = z.infer<typeof TotpCodeSchema>;

// ---------------------------------------------------------------------------
// The API's auth routes (ADR-0011)
//
// The browser no longer talks to Cognito: it sends these to /api/v1/auth, and
// the server answers with httpOnly cookies rather than tokens. Nothing below
// ever carries a token, by construction.
// ---------------------------------------------------------------------------

// What the client sends. No confirmPassword — matching it is the form's job.
// The Turnstile token is opaque; the pre sign-up Lambda verifies it, and the
// cap only stops an absurd body reaching Cognito.
export const SignupRequestSchema = z.object({
  email: z.email(),
  password: NewPasswordSchema,
  turnstileToken: z.string().min(1).max(4096).optional(),
});

export type SignupRequest = z.infer<typeof SignupRequestSchema>;

export const SigninRequestSchema = z.object({
  email: z.email(),
  password: z.string().min(1).max(256),
});

export type SigninRequest = z.infer<typeof SigninRequestSchema>;

export const ConfirmSignupRequestSchema = z.object({
  email: z.email(),
  code: ConfirmSignupSchema.shape.code,
});

export type ConfirmSignupRequest = z.infer<typeof ConfirmSignupRequestSchema>;

// Where a sign-in or sign-up stands after the call. `DONE` means the session
// cookies were set; `TOTP` means the password checked out and a code is due
// (POST /auth/signin/totp); `CONFIRM_SIGN_UP` means the email is unverified.
export const AuthStepSchema = z.enum(["DONE", "TOTP", "CONFIRM_SIGN_UP"]);
export type AuthStep = z.infer<typeof AuthStepSchema>;

export const AuthStepResponseSchema = z.object({ next: AuthStepSchema });
export type AuthStepResponse = z.infer<typeof AuthStepResponseSchema>;

// Failures as stable codes, never Cognito's own text. The web app owns the copy
// each one maps to. INVALID_CREDENTIALS covers both a wrong password and an
// unknown email on purpose — telling them apart is an enumeration oracle.
export const AuthErrorCodeSchema = z.enum([
  "INVALID_CREDENTIALS",
  "NOT_CONFIRMED",
  "ACCOUNT_EXISTS",
  "CODE_INVALID",
  "CODE_EXPIRED",
  "PASSWORD_REQUIREMENTS",
  "EMAIL_NOT_ALLOWED",
  "HUMAN_CHECK_FAILED",
  "TOO_MANY_ATTEMPTS",
  "MFA_NOT_FOUND",
  // The pending TOTP sign-in is gone (expired or never started): start over.
  "SIGNIN_EXPIRED",
  // No valid session; sign in again.
  "UNAUTHENTICATED",
  "INVALID_REQUEST",
  "FAILED",
]);
export type AuthErrorCode = z.infer<typeof AuthErrorCodeSchema>;

export const AuthErrorResponseSchema = z.object({ code: AuthErrorCodeSchema });
export type AuthErrorResponse = z.infer<typeof AuthErrorResponseSchema>;

// GET /auth/me. Group membership comes from the verified access token, so the
// web app learns it without ever holding that token. A rendering signal only:
// RequireAdmin on the server is the control.
export const MeResponseSchema = z.object({
  id: z.string(),
  username: z.string(),
  groups: z.array(z.string()),
});
export type MeResponse = z.infer<typeof MeResponseSchema>;

// POST /auth/signout. A Google sign-in also left a session on Cognito's hosted
// UI; without visiting this URL the next "Continue with Google" signs straight
// back in. null for a password sign-in, which has no hosted-UI session.
export const SignoutResponseSchema = z.object({
  logoutUrl: z.string().nullable(),
});
export type SignoutResponse = z.infer<typeof SignoutResponseSchema>;

export const MfaStatusResponseSchema = z.object({ enabled: z.boolean() });
export type MfaStatusResponse = z.infer<typeof MfaStatusResponseSchema>;

// The secret is shown once, for enrolment. It is the authenticator's seed, not
// a session credential, so returning it to the page is inherent to TOTP.
export const TotpSetupResponseSchema = z.object({
  sharedSecret: z.string(),
  setupUri: z.string(),
});
export type TotpSetupResponse = z.infer<typeof TotpSetupResponseSchema>;
