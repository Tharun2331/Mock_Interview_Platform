import { describe, expect, it } from "bun:test";
import { parseResume } from "../../lib/resume";
import { ResumeParseError } from "../../lib/errors";
import { MESSAGES } from "../../lib/messages";
import { corruptPdf, minimalPdf } from "../helpers/pdf";

// PDF text extraction, and the one surprise in it that has already cost a bug.
//
// Nothing here is mocked. pdf.js runs for real against a real document,
// because the behaviour worth pinning — that the caller's buffer survives the
// call — is a property of pdf.js itself and a stub would assert nothing about
// it.

describe("reading a resume", () => {
  it("extracts the text", async () => {
    const parsed = await parseResume(
      minimalPdf("Tharun Sekar backend engineer Kafka Postgres"),
    );

    expect(parsed.text).toBe("Tharun Sekar backend engineer Kafka Postgres");
  });

  it("reports the page count and character count", async () => {
    const parsed = await parseResume(minimalPdf("Hello"));

    expect(parsed.pages).toBe(1);
    expect(parsed.characters).toBe("Hello".length);
  });

  // Layout whitespace — column breaks, headers, justified spacing — arrives as
  // runs of spaces and newlines. Collapsing costs nothing in meaning and cuts
  // the input tokens the Planner pays for on every request.
  it("collapses layout whitespace into single spaces", async () => {
    const parsed = await parseResume(minimalPdf("spaced     out     text"));

    expect(parsed.text).toBe("spaced out text");
    expect(parsed.text).not.toContain("  ");
  });

  it("reports characters consistently with the text it returns", async () => {
    const parsed = await parseResume(minimalPdf("a     b"));

    expect(parsed.characters).toBe(parsed.text.length);
  });
});

// THE reason lib/resume.ts copies its input.
//
// pdf.js TRANSFERS the input ArrayBuffer to its worker, which detaches the
// caller's view — after an uncopied call their `byteLength` is 0. The route
// uploads these same bytes to S3 in parallel, and a detached buffer there
// stores a zero-byte object with no error raised anywhere. A candidate's
// resume would appear to upload and be empty in the bucket.
//
// Two tests, because the copy has to hold on both paths: a document that
// parses and one that does not.
describe("the caller's bytes", () => {
  it("survives a successful parse", async () => {
    const bytes = minimalPdf("Kafka Postgres");
    const sizeBefore = bytes.byteLength;

    await parseResume(bytes);

    expect(bytes.byteLength).toBe(sizeBefore);
    expect(sizeBefore).toBeGreaterThan(0);
  });

  it("survives a failed parse", async () => {
    const bytes = corruptPdf();
    const sizeBefore = bytes.byteLength;

    await expect(parseResume(bytes)).rejects.toThrow(ResumeParseError);

    expect(bytes.byteLength).toBe(sizeBefore);
  });

  it("is still readable afterwards, not merely the right length", async () => {
    const bytes = minimalPdf("Kafka");
    const firstByte = bytes[0];

    await parseResume(bytes);

    // A detached view reads as undefined rather than throwing, so the length
    // check alone could pass on a buffer nothing can be read from.
    expect(bytes[0]).toBe(firstByte);
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
  });
});

describe("a document that cannot be read", () => {
  // Encrypted, corrupt, or not really a PDF past the header. The caller decides
  // whether that is fatal.
  it("raises a typed error rather than returning empty text", async () => {
    await expect(parseResume(corruptPdf())).rejects.toThrow(ResumeParseError);
  });

  it("uses copy the candidate can act on", async () => {
    await expect(parseResume(corruptPdf())).rejects.toThrow(
      MESSAGES.RESUME_PARSE_FAILED,
    );
  });

  it("rejects bytes that are not a PDF at all", async () => {
    const notAPdf = new TextEncoder().encode("just some plain text");

    await expect(parseResume(notAPdf)).rejects.toThrow(ResumeParseError);
  });

  it("rejects an empty upload", async () => {
    await expect(parseResume(new Uint8Array(0))).rejects.toThrow(
      ResumeParseError,
    );
  });
});
