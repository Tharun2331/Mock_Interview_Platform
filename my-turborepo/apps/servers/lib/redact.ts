import {
  ComprehendClient,
  DetectPiiEntitiesCommand,
  PiiEntityType,
} from "@aws-sdk/client-comprehend";
import { config } from "./config";
import { REDACTION } from "./constants";
import { ServiceError } from "./errors";
import { MESSAGES } from "./messages";

// Strips personal identifiers out of extracted resume text before anything else
// sees it. Runs once, at profile save — not per session, and never on the way
// out of storage, because what is stored is already redacted.
//
// What this protects is the *inference* boundary. The original PDF stays in S3
// with its PII intact and that is deliberate: the candidate uploaded it
// knowingly, it is the archive a parser change is re-run against, and it is
// theirs to download. What must not happen is that same material reaching a
// model prompt, where it lands in logs and traces nobody here controls, or
// sitting in DynamoDB where every future feature reads it by default.

export const comprehendClient = new ComprehendClient({
  region: config.awsRegion,
  maxAttempts: REDACTION.MAX_ATTEMPTS,
  requestHandler: {
    requestTimeout: REDACTION.REQUEST_TIMEOUT_MS,
  },
});

// Identity, contact, credential and financial identifiers. Everything here is
// something a resume can carry and the Planner has no use for.
//
// DATE_TIME is NOT in this set, and that omission is load-bearing: employment
// dates are exactly what the Planner reasons over when it judges seniority and
// picks a starting difficulty. Stripping them would leave a resume that says
// what someone did with no indication of when or for how long, which is most of
// the signal. The same logic keeps company, project and technology names —
// semi-identifying, and the entire point of the document.
const REDACTED_TYPES: ReadonlySet<string> = new Set<string>([
  PiiEntityType.NAME,
  PiiEntityType.EMAIL,
  PiiEntityType.PHONE,
  PiiEntityType.ADDRESS,
  PiiEntityType.AGE,
  PiiEntityType.URL,
  PiiEntityType.USERNAME,
  PiiEntityType.IP_ADDRESS,
  PiiEntityType.MAC_ADDRESS,
  PiiEntityType.LICENSE_PLATE,
  PiiEntityType.VEHICLE_IDENTIFICATION_NUMBER,
  // Government identifiers. A resume should never carry these, which is exactly
  // why they are worth stripping — the ones that show up are the ones somebody
  // pasted in by mistake.
  PiiEntityType.SSN,
  PiiEntityType.DRIVER_ID,
  PiiEntityType.PASSPORT_NUMBER,
  PiiEntityType.CA_SOCIAL_INSURANCE_NUMBER,
  PiiEntityType.CA_HEALTH_NUMBER,
  PiiEntityType.IN_AADHAAR,
  PiiEntityType.IN_NREGA,
  PiiEntityType.IN_PERMANENT_ACCOUNT_NUMBER,
  PiiEntityType.IN_VOTER_NUMBER,
  PiiEntityType.UK_NATIONAL_HEALTH_SERVICE_NUMBER,
  PiiEntityType.UK_NATIONAL_INSURANCE_NUMBER,
  PiiEntityType.UK_UNIQUE_TAXPAYER_REFERENCE_NUMBER,
  PiiEntityType.US_INDIVIDUAL_TAX_IDENTIFICATION_NUMBER,
  // Financial and credential material, same reasoning.
  PiiEntityType.BANK_ACCOUNT_NUMBER,
  PiiEntityType.BANK_ROUTING,
  PiiEntityType.INTERNATIONAL_BANK_ACCOUNT_NUMBER,
  PiiEntityType.SWIFT_CODE,
  PiiEntityType.CREDIT_DEBIT_NUMBER,
  PiiEntityType.CREDIT_DEBIT_CVV,
  PiiEntityType.CREDIT_DEBIT_EXPIRY,
  PiiEntityType.PIN,
  PiiEntityType.PASSWORD,
  PiiEntityType.AWS_ACCESS_KEY,
  PiiEntityType.AWS_SECRET_KEY,
]);

// A narrow second pass, kept only where Comprehend was measured to fall short.
//
// It covered email and URL too, until an ablation showed both were pure
// redundancy: Comprehend scored every address and link at 1.000, including
// `first.last+tag@gmail.com`, and caught a bare `linkedin.com/in/...` that the
// URL pattern could not match without also matching `next.js` and `socket.io`.
// On those two categories the model is strictly better than a regex, so the
// regexes are gone.
//
// Phone stays because it is the one category with a measured gap: Comprehend
// reads `+1 (807) 555-0142` and `807.555.9911` at 1.000 but returns nothing at
// all for an unformatted `6475550123` — not a low score, no detection. People
// write their number that way often enough to matter.
//
// This is not a fallback for Comprehend being down. It cannot be: redaction
// fails closed, so an API failure throws before this pass would ever stand
// alone. It exists solely to cover that recall gap.
//
// The cost is a false positive on any bare ten-digit integer that is not a
// phone number. That is an acceptable trade in one direction only — a stripped
// number costs the Planner a data point, an un-stripped one is a leak — but it
// is why the pattern demands ten significant digits, which keeps it off years,
// version numbers and the "2019 - 2023" ranges that fill an employment section.
//
// Names are deliberately absent. There is no regex for a name, which is
// precisely why Comprehend is here.
const DETERMINISTIC_PATTERNS: ReadonlyArray<{
  label: string;
  pattern: RegExp;
}> = [
  {
    label: PiiEntityType.PHONE,
    pattern:
      /(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}\b/g,
  },
];

type Span = {
  begin: number;
  end: number;
  label: string;
};

export type RedactionResult = {
  text: string;
  // Counts and type names only. The values themselves are never returned or
  // logged — a redactor that reports what it removed by quoting it back has
  // moved the leak rather than closed it.
  redactedCount: number;
  types: string[];
};

function collectDeterministicSpans(text: string): Span[] {
  const spans: Span[] = [];

  for (const { label, pattern } of DETERMINISTIC_PATTERNS) {
    // A fresh regex per pass. The literals above carry /g, and a shared /g regex
    // keeps `lastIndex` between calls — the second resume would start matching
    // wherever the first one stopped.
    const scoped = new RegExp(pattern.source, pattern.flags);
    for (const match of text.matchAll(scoped)) {
      if (match.index === undefined) continue;
      spans.push({
        begin: match.index,
        end: match.index + match[0].length,
        label,
      });
    }
  }

  return spans;
}

async function collectComprehendSpans(text: string): Promise<Span[]> {
  let response;
  try {
    response = await comprehendClient.send(
      new DetectPiiEntitiesCommand({
        Text: text,
        LanguageCode: REDACTION.LANGUAGE_CODE,
      })
    );
  } catch (error) {
    // Fail closed. The alternative — storing what the deterministic pass alone
    // caught — silently ships names and addresses into DynamoDB and into every
    // future Planner prompt, and nothing downstream could tell that from a
    // properly redacted resume. An upload that fails is recoverable; one that
    // succeeds with PII still in it is not.
    throw new ServiceError(
      `${MESSAGES.REDACTION_FAILED} — ${
        error instanceof Error ? error.message : "unknown"
      }`
    );
  }

  const spans: Span[] = [];

  for (const entity of response.Entities ?? []) {
    const { BeginOffset, EndOffset, Type, Score } = entity;

    // Every field on the response is optional in the SDK's types. An entity
    // missing an offset cannot be applied, and one missing a type cannot be
    // judged — skipping beats guessing at either.
    if (BeginOffset === undefined || EndOffset === undefined) continue;
    if (Type === undefined || !REDACTED_TYPES.has(Type)) continue;
    if (Score !== undefined && Score < REDACTION.MIN_CONFIDENCE) continue;

    spans.push({ begin: BeginOffset, end: EndOffset, label: Type });
  }

  return spans;
}

// Comprehend can return adjacent or overlapping entities, and the deterministic
// pass regularly re-finds something Comprehend already flagged. Replacing those
// independently would corrupt the text — the second replacement would be
// computed against offsets the first one already invalidated.
function mergeSpans(spans: Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.begin - b.begin || a.end - b.end);
  const merged: Span[] = [];

  for (const span of sorted) {
    const previous = merged[merged.length - 1];

    if (previous !== undefined && span.begin <= previous.end) {
      // Overlapping. Widen the existing span rather than nesting, and keep the
      // first label: the passes agree far more often than not, and when they
      // disagree either label describes something being removed anyway.
      previous.end = Math.max(previous.end, span.end);
      continue;
    }

    merged.push({ ...span });
  }

  return merged;
}

// Right to left, so each replacement leaves every remaining offset valid.
// Left to right, the first substitution shifts the rest of the string and every
// subsequent span points somewhere slightly wrong — which is the kind of bug
// that produces text that looks fine and has half an email address in it.
function applySpans(text: string, spans: Span[]): string {
  let output = text;

  for (let index = spans.length - 1; index >= 0; index -= 1) {
    const span = spans[index];
    if (span === undefined) continue;
    output = `${output.slice(0, span.begin)}[${span.label}]${output.slice(span.end)}`;
  }

  return output;
}

// Replaces identifiers with typed placeholders — `[NAME]`, `[EMAIL]` — rather
// than deleting them.
//
// Deletion would leave "reachable at  or on " and a model that fills the gap
// with something plausible. A labelled placeholder keeps the sentence readable,
// tells the Planner a person's name stood there without saying whose, and makes
// a redaction visible when someone is reading the stored text trying to work out
// whether this ran at all.
export async function redactResumeText(text: string): Promise<RedactionResult> {
  if (text.trim().length === 0) {
    return { text: "", redactedCount: 0, types: [] };
  }

  // Throws rather than chunking. Splitting the text would silently drop any
  // identifier straddling a boundary — an email split across two calls is
  // detected in neither — and a redactor whose failure mode is "quietly missed
  // some" is worse than one that stops. Unreachable while callers respect
  // PLAN_LIMITS.MAX_RESUME_CHARS; if it ever fires, the cap moved.
  const byteLength = Buffer.byteLength(text, "utf8");
  if (byteLength > REDACTION.MAX_BYTES) {
    throw new ServiceError(
      `${MESSAGES.REDACTION_INPUT_TOO_LARGE} (${byteLength} bytes, limit ${REDACTION.MAX_BYTES})`
    );
  }

  const spans = mergeSpans([
    ...(await collectComprehendSpans(text)),
    ...collectDeterministicSpans(text),
  ]);

  return {
    text: applySpans(text, spans),
    redactedCount: spans.length,
    types: [...new Set(spans.map((span) => span.label))].sort(),
  };
}
