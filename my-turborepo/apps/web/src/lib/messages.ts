// Every user-facing string in the web app. Nothing renders text inline, so copy
// can be reviewed in one place and swapped for an i18n catalogue later without
// touching components.
export const MESSAGES = {
  APP_NAME: "PrepPilot",
  LOADING: "Loading…",

  // --- Identity surfaces ---
  // The thesis, in the subject's own vernacular: the gap this product closes is
  // between knowing an answer and saying it out loud under time pressure.
  APP_TAGLINE: "Practise saying it out loud.",
  APP_PITCH:
    "A spoken mock interview built from your own resume and repositories. Talk it through, interrupt when you need to, and read back exactly what you said.",
  // Three claims, each one a thing the product actually does — not features in
  // the abstract. Numbered because the sequence is real: you attach, you talk,
  // you read it back.
  APP_POINTS: [
    {
      title: "Questions from your own work",
      body: "Your resume and public repositories decide what gets asked, so nothing is generic.",
    },
    {
      title: "A conversation, not a form",
      body: "Speak your answers. Jump in mid-question — the interviewer stops and listens.",
    },
    {
      title: "The transcript is yours",
      body: "Every answer is written down as you give it, ready to read back afterwards.",
    },
  ],
  FOOTER_NOTE: "Built for practice. Nothing you say here is shared.",

  // Names where the control takes you, not where you are.
  THEME_TO_DARK: "Switch to dark theme",
  THEME_TO_LIGHT: "Switch to light theme",

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
  FORM_ROLE_LABEL: "Target role",
  FORM_ROLE_HINT:
    "The role you are practising for. Pick one or type your own.",
  FORM_ROLE_PLACEHOLDER: "e.g. Backend Engineer",
  FORM_ROLE_REQUIRED: "Enter the role you are practising for.",
  // Matches the button through its whole flow: the thing you asked for is a
  // plan, so the pending and finished states describe the same object.
  FORM_SUBMIT: "Generate interview plan",
  FORM_SUBMIT_PENDING: "Reading your repositories…",
  FORM_SESSION_EXPIRED: "Your session expired. Sign in again to continue.",
  FORM_UNEXPECTED_RESPONSE:
    "We reached GitHub but could not read the response. Try again.",
  // Only for a real GitHub failure now. This used to be the catch-all for every
  // unmapped error, including the backend being unreachable — which told people
  // to re-check a URL that was perfectly valid.
  FORM_FAILED: "We could not read that GitHub profile. Check the URL and retry.",
  FORM_UNREACHABLE:
    "We could not reach PrepPilot. Check your connection and try again.",

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

  // --- Session plan ---
  PLAN_PHASE_BUILDING: "Building your interview plan",
  PLAN_TITLE: "Session plan",
  PLAN_READY_BADGE: "Ready",
  PLAN_DESCRIPTION: "Your session is prepared and ready to begin.",
  PLAN_STAT_QUESTIONS: "Questions",
  PLAN_STAT_DURATION: "Duration",
  PLAN_STAT_FOCUSES: "Focuses",
  PLAN_FOCUS_AREAS: "Focus areas",
  PLAN_SOURCE_GITHUB: "From your repositories",
  PLAN_SOURCE_RESUME: "From your resume",
  PLAN_BEGIN: "Begin interview",
  PLAN_START_OVER: "Change these inputs",
  // Says plainly that the opening level is a starting point, because the
  // interview moves off it. A fixed-sounding label would misdescribe the
  // product and read as a verdict before a single question is asked.
  PLAN_DIFFICULTY_NOTE:
    "Starts at this level and adjusts to your answers as you go.",

  // The plan comes from a model call, so it needs its own retry path rather
  // than sending the candidate back to re-upload a resume that stored fine.
  PLAN_FAILED_TITLE: "We could not build your plan",
  PLAN_FAILED_RETRY: "Try again",
  PLAN_FAILED_GENERIC:
    "Your resume and repositories were saved. Only the plan failed, so trying again will not re-upload anything.",
  PLAN_SESSION_MISSING:
    "That session is no longer available. Start again with your resume.",
  PLAN_ALREADY_STARTED:
    "This interview has already started, so its plan can no longer be changed.",
  PLAN_UNEXPECTED_RESPONSE:
    "We built a plan but could not read it back. Try again.",

  // --- Live interview ---
  INTERVIEW_TITLE: "Interview",
  // Said once, early, in plain words. People default to turn-taking politeness
  // with software and will not discover interruption on their own.
  INTERVIEW_INTERRUPT_HINT:
    "You can jump in any time — the interviewer will stop.",
  INTERVIEW_START: "Start interview",
  INTERVIEW_STOP: "End interview",
  INTERVIEW_MIC_PREPARING: "Waiting for microphone access",
  INTERVIEW_MIC_EXPLAIN:
    "PrepPilot needs your microphone to hear your answers. Your browser will ask next.",
  INTERVIEW_CONNECTING: "Connecting to your interviewer",
  INTERVIEW_LISTENING: "Listening — you have the floor",
  INTERVIEW_THINKING: "Thinking",
  INTERVIEW_SPEAKING: "Interviewer is speaking",
  INTERVIEW_INTERRUPTING: "You interrupted — go ahead",
  INTERVIEW_MIC_ON: "Microphone on",
  // The clock is rendered as large numerals with a caption under them, so the
  // word and the digits are separate strings. The composed sentences below are
  // still used verbatim for the screen-reader announcement, because "34:58"
  // split from its label reads as bare digits with no unit.
  INTERVIEW_TIME_LABEL: "remaining",
  INTERVIEW_TIME_ENDING_LABEL: "wrapping up",
  INTERVIEW_TIME_LEFT: (remaining: string): string => `${remaining} remaining`,
  // Distinct copy for the final stretch, so the change is carried by words as
  // well as colour.
  INTERVIEW_TIME_ENDING: (remaining: string): string =>
    `Wrapping up — ${remaining} remaining`,
  INTERVIEW_TRANSCRIPT: "Transcript",
  // Offered when the reader has scrolled up to re-read. Auto-scrolling them
  // back would take the page away mid-sentence.
  INTERVIEW_JUMP_LATEST: "Jump to latest",
  INTERVIEW_TRANSCRIPT_EMPTY:
    "Your conversation will appear here as you speak.",
  INTERVIEW_ENDED: "Interview ended",
  INTERVIEW_ENDED_BY_YOU: "You ended the interview.",
  INTERVIEW_DISCONNECTED:
    "The connection dropped. Reconnecting would start a new conversation, so this session has ended.",
  INTERVIEW_CONNECT_FAILED:
    "We could not reach your interviewer. Check your connection and try again.",
  INTERVIEW_NO_SESSION:
    "No interview session was found. Start from your resume and plan.",
  INTERVIEW_RETRY: "Try again",
  INTERVIEW_BACK: "Back to setup",
  INTERVIEW_SPEAKER_YOU: "You",
  INTERVIEW_SPEAKER_INTERVIEWER: "Interviewer",

  // Microphone failures, mapped from the DOMException name rather than its
  // message — each needs a different recovery, and the messages differ by
  // browser while the names do not.
  MIC_BLOCKED:
    "Your microphone is blocked. Allow access from the icon in your browser's address bar, then try again.",
  MIC_NOT_FOUND:
    "No microphone was found. Connect one and try again.",
  MIC_IN_USE:
    "Your microphone is in use by another app. Close it and try again.",
  MIC_FAILED: "We could not start your microphone. Try again.",

  // --- Interview setup chrome ---
  // An eyebrow naming where the candidate is in a three-step flow. The steps
  // are real and sequential, which is what earns the numbering.
  SETUP_EYEBROW: "Step 01 — Your material",
  PLAN_EYEBROW: "Step 02 — Your plan",
  INTERVIEW_EYEBROW: "Step 03 — Live",

  // --- Feedback ---
  // The results screen is reached but not yet fed: scoring lands with the
  // Evaluator. Saying so plainly beats a skeleton that implies data is seconds
  // away, or an empty state that reads as a failure.
  RESULT_TITLE: "Feedback",
  RESULT_PENDING_TITLE: "Your feedback is not ready yet",
  RESULT_PENDING_BODY:
    "Scoring runs after an interview finishes. When it is ready you will find each answer here with what would have made it stronger.",
  RESULT_BACK: "Start another interview",
} as const;

// Shortcuts, not an allowlist. The field accepts any role — these exist because
// typing is friction on a required field, and because a well-formed role name
// gives the plan better material than "swe" does. Clicking one fills the input,
// so there is a single source of truth for what was chosen.
export const TARGET_ROLE_PRESETS = [
  "Backend Engineer",
  "Frontend Engineer",
  "Full Stack Engineer",
  "Cloud / DevOps Engineer",
] as const;

export const planFocusCount = (count: number): string =>
  `${count} focus ${count === 1 ? "area" : "areas"}`;

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
