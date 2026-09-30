// Cognito pre sign-up trigger: refuses the addresses that make free-interview
// farming cheap.
//
// Every account gets three interviews without anyone granting anything, and each
// one is a billed Nova Sonic stream. Cognito's paid threat protection is out of
// scope for this project's budget, so this is the free substitute. It raises the
// cost of a throwaway account from "change one character" to "own another real
// mailbox":
//
//   - Disposable-mail domains (mailinator and friends). One of these gives an
//     attacker unlimited inboxes that pass email verification.
//   - Sub-addressing, like name+1@gmail.com. Every tag lands in the same inbox,
//     so one mailbox would otherwise be unlimited accounts. Controlled by
//     BLOCK_PLUS_ADDRESSING, because it also refuses a few people who use tags
//     on purpose.
//
// Only native sign-ups are checked. A Google sign-in (PreSignUp_ExternalProvider)
// carries an address Google has already verified and owns, and an admin-created
// user (PreSignUp_AdminCreateUser) is an operator's decision.
//
// Plain JavaScript with no dependencies, so Terraform can zip and ship this file
// as-is with no build step. Runs well inside Lambda's free tier: one invocation
// per sign-up attempt.
//
// The thrown message reaches the browser inside "PreSignUp failed with error
// ...". The web app shows its own copy for that case (UserLambdaValidationException
// in apps/web/src/lib/errors.ts), so the wording here is for the logs.

/** Well-known disposable-mail providers. Extend per environment with the
 * BLOCKED_EMAIL_DOMAINS variable rather than editing this list. */
export const DISPOSABLE_DOMAINS = [
  "10minutemail.com",
  "1secmail.com",
  "1secmail.net",
  "1secmail.org",
  "burnermail.io",
  "discard.email",
  "dispostable.com",
  "emailondeck.com",
  "fakeinbox.com",
  "getnada.com",
  "grr.la",
  "guerrillamail.biz",
  "guerrillamail.com",
  "guerrillamail.de",
  "guerrillamail.info",
  "guerrillamail.net",
  "guerrillamail.org",
  "mailcatch.com",
  "maildrop.cc",
  "mailinator.com",
  "mailnesia.com",
  "mintemail.com",
  "moakt.com",
  "mohmal.com",
  "sharklasers.com",
  "spamgourmet.com",
  "temp-mail.io",
  "temp-mail.org",
  "tempail.com",
  "tempmail.com",
  "tempmail.dev",
  "tempmailo.com",
  "tempr.email",
  "throwawaymail.com",
  "tmpmail.net",
  "tmpmail.org",
  "trashmail.com",
  "trashmail.de",
  "yopmail.com",
  "yopmail.fr",
];

/**
 * @param {string} domain lowercased domain part of an email
 * @param {string[]} blocked
 * @returns {boolean} true for a blocked domain or any subdomain of one
 */
export function isBlockedDomain(domain, blocked) {
  return blocked.some(
    (entry) => domain === entry || domain.endsWith(`.${entry}`),
  );
}

/**
 * The decision, separated from the Lambda wiring so it can be tested directly.
 *
 * @param {string} email
 * @param {{ blockPlusAddressing: boolean, extraBlockedDomains: string[] }} options
 * @returns {string | null} a reason to refuse, or null to allow
 */
export function refusalReason(email, options) {
  const normalised = email.trim().toLowerCase();
  const at = normalised.lastIndexOf("@");
  if (at < 1 || at === normalised.length - 1) {
    return "A valid email address is required.";
  }

  const local = normalised.slice(0, at);
  const domain = normalised.slice(at + 1);

  if (
    isBlockedDomain(domain, [
      ...DISPOSABLE_DOMAINS,
      ...options.extraBlockedDomains,
    ])
  ) {
    return "Disposable email addresses cannot be used to sign up.";
  }

  if (options.blockPlusAddressing && local.includes("+")) {
    return "Email addresses with a + tag cannot be used to sign up.";
  }

  return null;
}

/** Reads this function's configuration from its environment. */
function optionsFromEnv() {
  return {
    blockPlusAddressing: process.env.BLOCK_PLUS_ADDRESSING !== "false",
    extraBlockedDomains: (process.env.BLOCKED_EMAIL_DOMAINS ?? "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0),
  };
}

/**
 * @param {{ triggerSource: string, request: { userAttributes?: Record<string, string> } }} event
 */
export async function handler(event) {
  if (event.triggerSource !== "PreSignUp_SignUp") return event;

  const email = event.request.userAttributes?.email ?? "";
  const reason = refusalReason(email, optionsFromEnv());

  if (reason !== null) {
    // The domain only, never the full address: the log line needs to say what
    // was refused, not who tried.
    const domain = email.slice(email.lastIndexOf("@") + 1).toLowerCase();
    console.log(`[pre-sign-up] refused a sign-up at ${domain}: ${reason}`);
    throw new Error(reason);
  }

  return event;
}
