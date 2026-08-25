import { extractText, getDocumentProxy } from "unpdf";
import { ResumeParseError } from "./errors";
import { MESSAGES } from "./messages";

export type ParsedResume = {
  text: string;
  pages: number;
  characters: number;
};

// PDF text extraction preserves layout whitespace — column breaks, headers and
// justified spacing all arrive as runs of spaces and newlines. Collapsing them
// costs nothing in meaning and meaningfully cuts the input tokens the Planner
// pays for on every request.
function normalise(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

export async function parseResume(bytes: Uint8Array): Promise<ParsedResume> {
  // pdf.js TRANSFERS the input ArrayBuffer to its worker, which detaches the
  // caller's view — after this call their `bytes.byteLength` is 0.
  //
  // Copying here rather than asking callers to remember: the route uploads these
  // same bytes to S3 in parallel, and a detached buffer there stores a 0-byte
  // object with no error raised. Contained at the source of the surprise.
  const owned = new Uint8Array(bytes);

  try {
    const document = await getDocumentProxy(owned);
    const { text, totalPages } = await extractText(document, {
      mergePages: true,
    });

    const merged = normalise(Array.isArray(text) ? text.join(" ") : text);

    return {
      text: merged,
      pages: totalPages,
      characters: merged.length,
    };
  } catch {
    // Encrypted, corrupt, or not really a PDF past the header. The caller
    // decides whether that is fatal — a plan from GitHub alone is still useful.
    throw new ResumeParseError(MESSAGES.RESUME_PARSE_FAILED);
  }
}
