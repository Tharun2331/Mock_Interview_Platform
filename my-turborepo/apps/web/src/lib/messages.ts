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
  // Distinct from FORM_UNREACHABLE. Both arrive as an axios error with no
  // response, but the recovery differs: unreachable means nothing answered, so
  // check the connection; this means the server took the request and never
  // finished, so the connection is fine and retrying is the whole advice.
  FORM_TIMED_OUT:
    "PrepPilot took too long to answer. Nothing was lost — try again.",

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
  // One phase, not two, because the browser cannot see where extraction ends
  // and the personal-details scan begins — it is a single request. Named for
  // what the server is genuinely doing rather than split into invented steps
  // with fabricated progress behind them.
  RESUME_PHASE_SCANNING: "Reading your resume and removing personal details",

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
  // The clock reaches zero a short grace before the server closes the session —
  // cutting someone off mid-sentence at the exact second is worse than running
  // a few seconds long. Without this the countdown sits frozen at 0:00 and
  // reads as a stuck app rather than a deliberate pause for the sign-off.
  INTERVIEW_TIME_UP_LABEL: "time is up",
  INTERVIEW_TIME_UP: "Time is up. The interviewer is finishing now.",
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
  // Keeps the action's name stable through the flow: the interview ends, and
  // the thing on offer is the feedback it produced.
  INTERVIEW_SEE_FEEDBACK: "See your feedback",

  RESULT_TITLE: "Feedback",
  RESULT_PENDING_TITLE: "Your feedback is not ready yet",
  RESULT_PENDING_BODY:
    "Scoring runs after an interview finishes. When it is ready you will find each answer here with what would have made it stronger.",
  RESULT_BACK: "Start another interview",

  // Scoring is asynchronous, so the first thing a candidate sees is usually a
  // round in progress. Naming the count makes the wait legible — "2 of 6" is a
  // system that is working, an unlabelled spinner is one that might be stuck.
  RESULT_SCORING_TITLE: "Scoring your answers",
  RESULT_SCORING_BODY:
    "Each answer is read and scored on its own, so they arrive one at a time. You can stay on this page or come back later.",
  RESULT_PROGRESS: (done: number, total: number): string =>
    `${done} of ${total} scored`,

  // The three dimensions, with what each one actually measures. A bare
  // "7/10 depth" teaches nothing; the subtitle is what makes it actionable.
  RESULT_DIMENSION_CORRECTNESS: "Correctness",
  RESULT_DIMENSION_CORRECTNESS_HINT: "Was it true, and did it answer the question asked?",
  RESULT_DIMENSION_CLARITY: "Clarity",
  RESULT_DIMENSION_CLARITY_HINT: "Could a listener follow it?",
  RESULT_DIMENSION_DEPTH: "Depth",
  RESULT_DIMENSION_DEPTH_HINT: "Did it go past the textbook answer?",

  RESULT_OVERALL: "Across the whole interview",
  RESULT_YOUR_ANSWER: "What you said",
  RESULT_WHAT_WOULD_HELP: "What would have made it stronger",
  // A score on a half-heard question needs its context, or it reads as an
  // unexplained penalty.
  RESULT_INTERRUPTED: "You answered before the question finished — scored on what you heard",

  RESULT_EMPTY_TITLE: "This interview has nothing to score",
  RESULT_EMPTY_BODY:
    "No answers were recorded, so there is nothing to give feedback on. Starting a fresh interview is the way forward.",

  RESULT_FAILED_TITLE: "This interview did not finish",
  RESULT_FAILED_BODY:
    "Something went wrong before it could be scored. Your next interview will not be affected.",

  RESULT_LOAD_FAILED: "We could not load your feedback.",
  RESULT_MISSING_SESSION:
    "We could not tell which interview to show. Pick one from your history, or start a new one.",

  // --- Profile ---
  // Captured once and reused by every interview. The first-run framing sells
  // what the material buys; the returning framing is a plain edit form, because
  // by then the candidate already knows why they gave it to us.
  RETRY: "Try again",
  PROFILE_NAV: "Profile",
  PROFILE_LOAD_TITLE: "We could not load your profile",
  PROFILE_LOAD_FAILED:
    "Your profile could not be loaded. Nothing has been changed — try again.",

  PROFILE_EYEBROW_FIRST: "Step 01 — Your material",
  PROFILE_EYEBROW_EDIT: "Profile",
  PROFILE_TITLE_FIRST: "Set up your profile",
  PROFILE_TITLE_EDIT: "Your profile",
  // Says what the material buys, concretely, rather than asking for it because
  // the form has fields.
  PROFILE_DESCRIPTION_FIRST:
    "Your resume and repositories decide what you get asked, so the questions come from work you have actually done. You only do this once — every interview reuses it.",
  PROFILE_DESCRIPTION_EDIT:
    "Update your material here. Your next interview will be built from whatever is saved on this page.",

  PROFILE_FIRST_LABEL: "First name",
  PROFILE_LAST_LABEL: "Last name",
  PROFILE_USERNAME_LABEL: "Display name",
  PROFILE_USERNAME_HINT: "What the interviewer calls you.",
  PROFILE_FIRST_REQUIRED: "Enter your first name.",
  PROFILE_LAST_REQUIRED: "Enter your last name.",
  PROFILE_USERNAME_REQUIRED: "Enter a display name.",

  // Shown when a resume is already stored and no new file is attached, so an
  // empty picker does not read as "nothing saved" to someone who saved one
  // weeks ago.
  PROFILE_RESUME_ON_FILE:
    "A resume is already saved. Attach a file only if you want to replace it.",

  PROFILE_PHASE_SAVING: "Saving",
  PROFILE_SUBMIT_FIRST: "Save and continue",
  PROFILE_SUBMIT_EDIT: "Save changes",
  PROFILE_SUBMIT_PENDING: "Saving…",
  PROFILE_SAVED: "Profile saved.",
  PROFILE_SAVE_FAILED:
    "We could not save your profile. This is on our side — try again shortly.",

  // --- Account deletion ---
  // Irreversible and server-side, so the copy names what goes rather than
  // saying "your data". People read "delete your account" as "remove the
  // login" and are genuinely surprised to lose their practice history.
  DELETE_SECTION_TITLE: "Delete your account",
  DELETE_SECTION_BODY:
    "Remove your resume, your interviews and your sign-in. This cannot be undone.",
  DELETE_OPEN: "Delete account",
  DELETE_TITLE: "Delete your account?",
  DELETE_BODY: "This permanently removes:",
  DELETE_ITEMS: [
    "Your stored resume",
    "Every interview you have run, including its transcript and feedback",
    "Your profile and sign-in",
  ],
  DELETE_IRREVERSIBLE:
    "There is no undo, and no way for us to restore any of it afterwards.",
  // Lowercase, and compared lowercased — the check should not turn on whether
  // a phone keyboard capitalised the first letter.
  DELETE_CONFIRM_WORD: "delete",
  DELETE_CONFIRM_LABEL: "Type delete to confirm",
  DELETE_CONFIRM: "Delete my account",
  DELETE_PENDING: "Deleting…",
  DELETE_CANCEL: "Keep my account",
  DELETE_DONE: "Your account and everything in it has been deleted.",
  // Erasure is resumable by design, so the instruction is to retry rather than
  // to contact anyone. Some data may already be gone; saying so is more honest
  // than implying nothing happened.
  DELETE_FAILED:
    "We could not finish deleting your account. Some data may already be removed — try again.",

  // --- Interview setup ---
  START_EYEBROW: "Step 02 — The round",
  START_TITLE: "What are you interviewing for?",
  START_DESCRIPTION:
    "Questions are drawn from your saved resume and repositories, pitched at the role you name here.",
  START_MATERIAL_TITLE: "Planned from",
  START_MATERIAL_RESUME: "Your resume",
  START_MATERIAL_EDIT: "Edit",
  START_SUBMIT: "Build my interview",
  START_SUBMIT_PENDING: "Building…",
  START_PHASE_CREATING: "Preparing your session",
  // The profile went incomplete between the guard and the request — cleared in
  // another tab, most likely. Names the fix rather than the error.
  START_PROFILE_INCOMPLETE:
    "Your profile is missing something. Finish it, then start your interview.",
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

// The one thing a candidate handing over a resume most deserves to be told.
// Counts only — naming the values back would undo the removal — and it says
// "before saving" because that is the actual order: nothing is stored until the
// scan has run.
export const redactionSummary = (count: number): string =>
  count === 0
    ? "No personal details were found to remove. Your resume is stored as you sent it."
    : `Removed ${count} personal ${count === 1 ? "detail" : "details"} — name, contact information and similar — before your resume was used to build questions.`;

export const resumeThinDetail = (characters: number): string =>
  `We only extracted ${characters.toLocaleString()} characters. This usually means the PDF is a scan or an image. You can continue without it, or attach a text-based PDF.`;
