import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import {
  ComprehendClient,
  DetectPiiEntitiesCommand,
  PiiEntityType,
} from "@aws-sdk/client-comprehend";
import { mockClient } from "aws-sdk-client-mock";
import { REDACTION } from "../../lib/constants";
import { RedactionError, ServiceError } from "../../lib/errors";
import { redactResumeText } from "../../lib/redact";

// This is the inference boundary. What is stored here is what every future
// Planner prompt reads, so a miss does not surface as a bug — it surfaces as a
// candidate's home address sitting in a model trace nobody here controls.

const comprehend = mockClient(ComprehendClient);

// Comprehend returning nothing, so a test exercises only the deterministic pass.
function noEntities() {
  comprehend.on(DetectPiiEntitiesCommand).resolves({ Entities: [] });
}

function entities(list: Array<Record<string, unknown>>) {
  comprehend.on(DetectPiiEntitiesCommand).resolves({ Entities: list });
}

beforeEach(() => comprehend.reset());
afterAll(() => comprehend.restore());

// The single most important behaviour in the module. Storing what the
// deterministic pass alone caught would ship names and addresses into DynamoDB,
// and nothing downstream could tell that from a properly redacted resume.
describe("failing closed", () => {
  it("throws rather than storing a partially redacted resume", async () => {
    comprehend
      .on(DetectPiiEntitiesCommand)
      .rejects(new Error("ThrottlingException"));

    await expect(redactResumeText("Call me on 415 555 0132")).rejects.toThrow(
      RedactionError
    );
  });

  it("throws even when the deterministic pass found something", async () => {
    comprehend.on(DetectPiiEntitiesCommand).rejects(new Error("service down"));

    // A phone number WAS matched here. Returning that partial result is exactly
    // the silent failure this guards against.
    await expect(
      redactResumeText("Reach me at (415) 555-0132 any time")
    ).rejects.toThrow(RedactionError);
  });

  it("does not run Comprehend at all on empty input", async () => {
    const result = await redactResumeText("   \n\t  ");

    expect(result).toEqual({ text: "", redactedCount: 0, types: [] });
    expect(comprehend.commandCalls(DetectPiiEntitiesCommand)).toHaveLength(0);
  });

  // Splitting would silently drop any identifier straddling a boundary — an
  // email split across two calls is detected in neither.
  it("throws rather than chunking oversized input", async () => {
    noEntities();
    const oversized = "a".repeat(REDACTION.MAX_BYTES + 1);

    await expect(redactResumeText(oversized)).rejects.toThrow(ServiceError);
    expect(comprehend.commandCalls(DetectPiiEntitiesCommand)).toHaveLength(0);
  });
});

describe("what gets redacted", () => {
  it("replaces an entity with a typed placeholder rather than deleting it", async () => {
    // Deletion would leave "reachable at  or on " and a model that fills the
    // gap with something plausible.
    entities([
      {
        BeginOffset: 0,
        EndOffset: 12,
        Type: PiiEntityType.NAME,
        Score: 0.99,
      },
    ]);

    const result = await redactResumeText("Tharun Sekar builds pipelines");

    expect(result.text).toBe("[NAME] builds pipelines");
    expect(result.types).toEqual([PiiEntityType.NAME]);
  });

  // DATE_TIME is deliberately absent from the redacted set: employment dates
  // are what the Planner judges seniority from.
  it("keeps employment dates, which are the seniority signal", async () => {
    entities([
      {
        BeginOffset: 0,
        EndOffset: 11,
        Type: PiiEntityType.DATE_TIME,
        Score: 0.99,
      },
    ]);

    const result = await redactResumeText("2019 - 2023 at an order pipeline team");

    expect(result.text).toBe("2019 - 2023 at an order pipeline team");
    expect(result.redactedCount).toBe(0);
  });

  it("ignores an entity below the confidence floor", async () => {
    entities([
      {
        BeginOffset: 0,
        EndOffset: 6,
        Type: PiiEntityType.NAME,
        Score: REDACTION.MIN_CONFIDENCE - 0.01,
      },
    ]);

    const result = await redactResumeText("Tharun builds pipelines");

    expect(result.redactedCount).toBe(0);
  });

  it("keeps an entity exactly at the confidence floor", async () => {
    entities([
      {
        BeginOffset: 0,
        EndOffset: 6,
        Type: PiiEntityType.NAME,
        Score: REDACTION.MIN_CONFIDENCE,
      },
    ]);

    expect((await redactResumeText("Tharun builds pipelines")).redactedCount).toBe(1);
  });

  // Every field on the response is optional in the SDK's types; skipping beats
  // guessing at either.
  it("skips an entity with no offsets and one with no type", async () => {
    entities([
      { EndOffset: 6, Type: PiiEntityType.NAME, Score: 0.99 },
      { BeginOffset: 0, Type: PiiEntityType.NAME, Score: 0.99 },
      { BeginOffset: 0, EndOffset: 6, Score: 0.99 },
    ]);

    expect((await redactResumeText("Tharun builds things")).redactedCount).toBe(0);
  });

  it("redacts an entity whose score the service omitted", async () => {
    entities([{ BeginOffset: 0, EndOffset: 6, Type: PiiEntityType.NAME }]);

    expect((await redactResumeText("Tharun builds things")).redactedCount).toBe(1);
  });
});

// Language-independent, and the reason a non-English resume still gets some
// protection.
describe("the deterministic phone pass", () => {
  it.each([
    "415 555 0132",
    "(415) 555-0132",
    "415-555-0132",
    "415.555.0132",
    "+1 415 555 0132",
    "4155550132",
  ])("matches %s", async (phone) => {
    noEntities();

    const result = await redactResumeText(`Reach me on ${phone} any time`);

    expect(result.text).toContain(`[${PiiEntityType.PHONE}]`);
    expect(result.text).not.toContain("5550132");
  });

  // The pattern demands ten significant digits precisely to stay off the
  // "2019 - 2023" ranges that fill an employment section.
  it.each(["2019 - 2023", "1999", "v1.2.3", "12345"])(
    "leaves %s alone",
    async (text) => {
      noEntities();

      const result = await redactResumeText(`Worked ${text} on pipelines`);

      expect(result.redactedCount).toBe(0);
      expect(result.text).toContain(text);
    }
  );

  // A shared /g regex keeps lastIndex between calls — the second resume would
  // start matching wherever the first one stopped.
  it("does not carry regex state between calls", async () => {
    noEntities();
    const text = "Call 415 555 0132 or 415 555 0199";

    const first = await redactResumeText(text);
    const second = await redactResumeText(text);

    expect(first.redactedCount).toBe(2);
    expect(second.redactedCount).toBe(2);
    expect(second.text).toBe(first.text);
  });
});

// Replacing overlapping spans independently would corrupt the text: the second
// replacement is computed against offsets the first already invalidated.
describe("overlapping spans", () => {
  it("merges a Comprehend hit with the deterministic hit for the same number", async () => {
    const text = "Call 415 555 0132 now";
    const begin = text.indexOf("415");
    entities([
      {
        BeginOffset: begin,
        EndOffset: begin + "415 555 0132".length,
        Type: PiiEntityType.PHONE,
        Score: 0.99,
      },
    ]);

    const result = await redactResumeText(text);

    // One span, not two stacked replacements.
    expect(result.redactedCount).toBe(1);
    expect(result.text).toBe(`Call [${PiiEntityType.PHONE}] now`);
  });

  it("widens rather than nesting when spans partially overlap", async () => {
    entities([
      { BeginOffset: 0, EndOffset: 6, Type: PiiEntityType.NAME, Score: 0.99 },
      { BeginOffset: 4, EndOffset: 12, Type: PiiEntityType.EMAIL, Score: 0.99 },
    ]);

    const result = await redactResumeText("Tharun Sekar writes code");

    expect(result.redactedCount).toBe(1);
    // First label wins; either describes something being removed anyway.
    expect(result.text).toBe(`[${PiiEntityType.NAME}] writes code`);
  });

  // Right to left, so each replacement leaves every remaining offset valid.
  // Left to right, the first substitution shifts the rest of the string.
  it("applies multiple separate spans without corrupting later offsets", async () => {
    const text = "Tharun emailed a@b.com about it";
    entities([
      { BeginOffset: 0, EndOffset: 6, Type: PiiEntityType.NAME, Score: 0.99 },
      {
        BeginOffset: text.indexOf("a@b.com"),
        EndOffset: text.indexOf("a@b.com") + "a@b.com".length,
        Type: PiiEntityType.EMAIL,
        Score: 0.99,
      },
    ]);

    const result = await redactResumeText(text);

    expect(result.text).toBe(
      `[${PiiEntityType.NAME}] emailed [${PiiEntityType.EMAIL}] about it`
    );
    expect(result.redactedCount).toBe(2);
  });
});

// A redactor that reports what it removed by quoting it back has moved the leak
// rather than closed it.
describe("the redaction summary", () => {
  it("reports counts and type names, never the removed values", async () => {
    entities([
      { BeginOffset: 0, EndOffset: 6, Type: PiiEntityType.NAME, Score: 0.99 },
    ]);

    const result = await redactResumeText("Tharun builds pipelines");

    expect(result.types).toEqual([PiiEntityType.NAME]);
    expect(JSON.stringify(result.types)).not.toContain("Tharun");
    expect(result.redactedCount).toBe(1);
  });

  it("lists each type once, sorted", async () => {
    entities([
      { BeginOffset: 0, EndOffset: 6, Type: PiiEntityType.NAME, Score: 0.99 },
      { BeginOffset: 7, EndOffset: 12, Type: PiiEntityType.NAME, Score: 0.99 },
      { BeginOffset: 13, EndOffset: 20, Type: PiiEntityType.EMAIL, Score: 0.99 },
    ]);

    const result = await redactResumeText("Tharun Sekar a@b.com and more text");

    expect(result.types).toEqual([PiiEntityType.EMAIL, PiiEntityType.NAME].sort());
  });

  it("sends the configured language code", async () => {
    noEntities();

    await redactResumeText("some text");

    expect(
      comprehend.commandCalls(DetectPiiEntitiesCommand)[0]?.args[0].input.LanguageCode
    ).toBe(REDACTION.LANGUAGE_CODE);
  });
});
