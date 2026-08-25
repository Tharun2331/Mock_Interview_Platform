// Every user-facing string in the web app. Nothing renders text inline, so copy
// can be reviewed in one place and swapped for an i18n catalogue later without
// touching components.
export const MESSAGES = {
  APP_NAME: "PrepPilot",
  LOADING: "Loading…",

  SIGN_OUT: "Sign out",
  SIGN_OUT_FAILED: "Sign out failed. Please try again.",

  // --- Fields shared by the sign-up and sign-in forms ---
  FIELD_EMAIL_LABEL: "Email",
  FIELD_EMAIL_PLACEHOLDER: "you@example.com",
  FIELD_PASSWORD_LABEL: "Password",
  FIELD_PASSWORD_PLACEHOLDER: "••••••••",
  CONTINUE_WITH_GOOGLE: "Continue with Google",

  // --- Auth failures ---
  // Sign-in failures collapse to ONE message on purpose. Distinguishing "no such
  // user" from "wrong password" tells an attacker which emails are registered.
  AUTH_INVALID_CREDENTIALS: "Incorrect email or password.",
  AUTH_ACCOUNT_EXISTS: "An account with this email already exists. Sign in instead.",
  AUTH_CODE_INVALID: "That code is incorrect. Check it and try again.",
  AUTH_CODE_EXPIRED: "That code has expired. Request a new one.",
  AUTH_TOO_MANY_ATTEMPTS: "Too many attempts. Wait a moment and try again.",
  AUTH_PASSWORD_REQUIREMENTS: "That password does not meet the requirements.",
  AUTH_NOT_CONFIRMED: "Confirm your email to finish signing in.",
  AUTH_SIGNED_UP_NOW_SIGN_IN: "Account confirmed. Sign in to continue.",
  AUTH_CONFIRM_FAILED: "Confirmation failed. Check the code and try again.",
  AUTH_SIGNUP_FAILED: "Sign-up failed. Please try again.",
  AUTH_SIGNIN_FAILED: "Sign-in failed. Check your credentials.",
  AUTH_GOOGLE_FAILED: "Google sign-in failed. Please try again.",
  AUTH_CODE_SENT: "We emailed you a 6-digit confirmation code.",

  // --- Sign up ---
  SIGNUP_TITLE: "Create your account",
  SIGNUP_DESCRIPTION: "Sign up with your email to start practising interviews.",
  SIGNUP_DIVIDER: "or sign up with email",
  SIGNUP_PASSWORD_HINT:
    "At least 8 characters, with upper- and lowercase letters, a number, and a symbol.",
  SIGNUP_CONFIRM_PASSWORD_LABEL: "Confirm password",
  SIGNUP_SUBMIT: "Create account",
  SIGNUP_SUBMIT_PENDING: "Creating account…",
  SIGNUP_HAS_ACCOUNT: "Already have an account?",
  SIGNUP_SIGNIN_LINK: "Sign in",

  // --- Sign in ---
  SIGNIN_TITLE: "Welcome back",
  SIGNIN_DESCRIPTION: "Sign in to continue practising interviews.",
  SIGNIN_DIVIDER: "or sign in with email",
  SIGNIN_SUBMIT: "Sign in",
  SIGNIN_SUBMIT_PENDING: "Signing in…",
  SIGNIN_NO_ACCOUNT: "Don’t have an account?",
  SIGNIN_SIGNUP_LINK: "Sign up",

  // --- Confirm email ---
  CONFIRM_TITLE: "Confirm your email",
  CONFIRM_DESCRIPTION: (email: string): string =>
    `Enter the 6-digit code we sent to ${email}.`,
  CONFIRM_CODE_LABEL: "Confirmation code",
  CONFIRM_CODE_PLACEHOLDER: "123456",
  CONFIRM_SUBMIT: "Confirm and continue",
  CONFIRM_SUBMIT_PENDING: "Confirming…",
  CONFIRM_EDIT_EMAIL: "Wrong address?",
  CONFIRM_EDIT_EMAIL_TITLE: "Use a different email",
  // Says up front that this restarts sign-up, so landing back on the sign-up
  // form reads as the expected next step rather than a bug.
  CONFIRM_EDIT_EMAIL_HINT:
    "Your email is your account name, so a new address means signing up again. We’ll take you back with it filled in.",
  CONFIRM_EDIT_EMAIL_SUBMIT: "Continue to sign-up",
  CONFIRM_EDIT_EMAIL_CANCEL: "Cancel",
  CONFIRM_EDIT_EMAIL_UNCHANGED: "That is already the address we sent the code to.",

  // --- Hosted-UI redirect landing ---
  CALLBACK_SIGNING_IN: "Signing you in…",

  // --- Pre-interview form ---
  FORM_TITLE: "Start an interview",
  FORM_DESCRIPTION:
    "Attach your resume so your questions are drawn from your real experience.",
  FORM_GITHUB_LABEL: "GitHub profile URL",
  FORM_GITHUB_OPTIONAL: "Optional",
  FORM_GITHUB_HINT: "Adds questions drawn from your public repositories.",
  FORM_GITHUB_PLACEHOLDER: "https://github.com/your-username",
  FORM_GITHUB_REQUIRED: "Enter your GitHub profile URL to continue.",
  FORM_SUBMIT: "Start interview",
  FORM_SUBMIT_PENDING: "Reading your repositories…",
  FORM_SESSION_EXPIRED: "Your session expired. Sign in again to continue.",
  FORM_UNEXPECTED_RESPONSE:
    "We reached GitHub but could not read the response. Try again.",
  FORM_FAILED: "We could not read that GitHub profile. Check the URL and retry.",

  // --- Resume attachment ---
  RESUME_LABEL: "Resume",
  RESUME_MISSING: "Attach your resume to continue.",
  RESUME_CHOOSE: "Choose a PDF",
  RESUME_REPLACE: "Replace",
  RESUME_REMOVE: "Remove",
  RESUME_REMOVED: "Resume removed.",
  RESUME_NOT_PDF: "That file is not a PDF. Choose a PDF and try again.",
  RESUME_EMPTY: "That file is empty. Choose a different PDF.",

  // Distinct phases, because one undifferentiated bar looks stalled while a PDF
  // is being parsed server-side.
  RESUME_PHASE_UPLOADING: "Uploading your resume",
  RESUME_PHASE_READING: "Reading your resume and repositories",

  // A thin parse is a result, not a failure — the candidate decides what to do.
  RESUME_THIN_TITLE: "We could barely read that PDF",
  RESUME_CONTINUE_ANYWAY: "Continue without it",
  RESUME_TRY_ANOTHER: "Attach a different PDF",

  // --- Screens still stubbed out ---
  INTERVIEW_TITLE: "Interview",
  RESULT_TITLE: "Result",
} as const;

// Names the limit in the same breath as the violation, matching the server's
// wording so the two never contradict each other.
export const resumeTooLarge = (actual: string, limit: string): string =>
  `That file is ${actual}. The limit is ${limit}.`;

// Quotes the limit up front so it is known before a file is chosen, not only
// after one is rejected.
export const resumeHint = (limit: string): string =>
  `PDF only, up to ${limit}.`;

export const resumeThinDetail = (characters: number): string =>
  `We only extracted ${characters.toLocaleString()} characters. This usually means the PDF is a scan or an image. You can continue without it, or attach a text-based PDF.`;
