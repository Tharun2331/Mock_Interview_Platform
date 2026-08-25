import { Readable } from "node:stream";
import type { Request as ExpressRequest } from "express";
import { UPLOAD } from "./constants";
import { UploadError } from "./errors";
import { MESSAGES, uploadTooLarge } from "./messages";

// Structural types for the slice of FormData we use.
//
// `@types/node` ships undici's FormData while the Bun runtime provides the web
// one, and the two are nominally incompatible even though the runtime object is
// fine. Describing what we need sidesteps that collision instead of casting at
// every call site, and keeps this module honest about its actual requirements.
// `name` is optional because the parser yields a Blob, not a File — the
// original filename does not survive the round trip. Nothing depends on it (the
// S3 key is derived from user and session id), but it is useful in logs.
export type MultipartFile = {
  name?: string;
  size: number;
  type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
};

type MultipartValue = string | MultipartFile | null;

export type MultipartForm = {
  get(name: string): MultipartValue;
  has(name: string): boolean;
};

function isFile(value: MultipartValue): value is MultipartFile {
  return (
    value !== null &&
    typeof value !== "string" &&
    typeof value.arrayBuffer === "function"
  );
}

export function isMultipart(req: ExpressRequest): boolean {
  const contentType = req.headers["content-type"] ?? "";
  return contentType.toLowerCase().startsWith("multipart/form-data");
}

// Node header values may be string or string[]; the fetch Request wants a flat
// record. The boundary lives in content-type, so dropping headers here would
// break parsing.
function toHeaderRecord(
  headers: ExpressRequest["headers"]
): Record<string, string> {
  const record: Record<string, string> = {};

  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") record[key] = value;
    else if (Array.isArray(value)) record[key] = value.join(", ");
  }

  return record;
}

// First line of defence, and the only one that yields a clean HTTP response.
//
// Erroring the body stream mid-flight (see capStream) destroys the request and
// takes the socket with it, so the client sees ECONNRESET rather than a 413.
// Rejecting on the declared length happens before a byte of body is read, which
// both answers properly and avoids receiving the upload at all.
function assertDeclaredSize(req: ExpressRequest, maxBytes: number): void {
  const declared = Number(req.headers["content-length"] ?? Number.NaN);

  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new UploadError(uploadTooLarge(declared, maxBytes));
  }
}

// Second line of defence, against a client that lies about Content-Length or
// omits it entirely (chunked transfer). This one cannot produce a tidy error —
// killing the stream kills the connection — but an abusive client losing its
// socket is a fine outcome, and the alternative is buffering unbounded data
// into memory.
//
// `express.json({ limit })` does NOT cover this path: it only parses
// application/json and ignores multipart entirely.
function capStream(
  source: ReadableStream<Uint8Array>,
  maxBytes: number
): ReadableStream<Uint8Array> {
  let seen = 0;

  return source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > maxBytes) {
          controller.error(new UploadError(uploadTooLarge(seen, maxBytes)));
          return;
        }
        controller.enqueue(chunk);
      },
    })
  );
}

// Express hands handlers a Node `IncomingMessage`, which has no `.formData()`.
// Rebuilding a web `Request` over the same stream lets us use the platform's own
// multipart parser instead of taking on a parsing dependency.
export async function readMultipart(
  req: ExpressRequest,
  maxBytes: number = UPLOAD.MAX_RESUME_BYTES
): Promise<MultipartForm> {
  // Budget for the whole body, which carries framing on top of the file.
  const bodyBudget = maxBytes + UPLOAD.BODY_OVERHEAD_BYTES;

  assertDeclaredSize(req, bodyBudget);

  const body = capStream(
    Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>,
    bodyBudget
  );

  const webRequest = new Request("http://internal/upload", {
    method: "POST",
    headers: toHeaderRecord(req.headers),
    body,
    // Required by the fetch spec for a streaming body; absent from the types.
    duplex: "half",
  } as RequestInit & { duplex: "half" });

  try {
    const form = await webRequest.formData();
    return form as unknown as MultipartForm;
  } catch (error) {
    // The cap surfaces here as a stream error — preserve its message, which
    // names the actual limit, rather than flattening it to "malformed".
    if (error instanceof UploadError) throw error;
    if (error instanceof Error && error.cause instanceof UploadError) {
      throw error.cause;
    }
    throw new UploadError(MESSAGES.UPLOAD_MALFORMED);
  }
}

export type UploadedPdf = {
  bytes: Uint8Array;
  filename: string;
};

// Validates by file header, not by declared MIME type. A part's Content-Type is
// whatever the client wrote, so a renamed executable arrives claiming
// application/pdf just as readily as a real PDF does.
export async function readPdf(
  form: MultipartForm,
  field: string
): Promise<UploadedPdf> {
  const value = form.get(field);

  if (!isFile(value) || value.size === 0) {
    throw new UploadError(MESSAGES.UPLOAD_NOT_A_FILE);
  }

  // The exact per-file limit, checked after parsing. The stream budget above is
  // deliberately looser (it includes multipart framing), so this is what gives
  // the precise "your file is X, the limit is Y" answer.
  if (value.size > UPLOAD.MAX_RESUME_BYTES) {
    throw new UploadError(uploadTooLarge(value.size, UPLOAD.MAX_RESUME_BYTES));
  }

  const bytes = new Uint8Array(await value.arrayBuffer());
  const header = new TextDecoder().decode(
    bytes.slice(0, UPLOAD.PDF_MAGIC.length)
  );

  if (header !== UPLOAD.PDF_MAGIC) {
    throw new UploadError(MESSAGES.UPLOAD_NOT_PDF);
  }

  return { bytes, filename: value.name ?? "resume.pdf" };
}

export function readTextField(
  form: MultipartForm,
  field: string
): string | undefined {
  const value = form.get(field);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
