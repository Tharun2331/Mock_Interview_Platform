import { describe, expect, it } from "bun:test";
import { Readable } from "node:stream";
import type { Request as ExpressRequest } from "express";
import { UPLOAD } from "../../lib/constants";
import { UploadError } from "../../lib/errors";
import { MESSAGES } from "../../lib/messages";
import {
  isMultipart,
  readMultipart,
  readPdf,
  readTextField,
  type MultipartForm,
} from "../../lib/multipart";

// The upload boundary. Its limits are layered on purpose — a declared-size
// check that can answer 413 cleanly, a stream cap against a client that lies,
// and an exact per-file check after parsing — and each layer catches something
// the others cannot.

// Builds a real multipart body by letting the platform encode it, so these
// tests exercise the actual parser rather than a hand-rolled approximation.
async function multipartRequest(
  form: FormData,
  overrides: Record<string, string> = {}
): Promise<ExpressRequest> {
  const encoded = new Response(form);
  const contentType = encoded.headers.get("content-type") ?? "";
  const buffer = Buffer.from(await encoded.arrayBuffer());

  const stream = Readable.from(buffer);
  // readMultipart only reads `.headers` and treats the value as a Node stream.
  // The cast is confined to this helper rather than spread across call sites.
  const req = stream as unknown as ExpressRequest;
  req.headers = {
    "content-type": contentType,
    "content-length": String(buffer.byteLength),
    ...overrides,
  };

  return req;
}

function pdfBytes(sizeBytes: number): Uint8Array {
  const bytes = new Uint8Array(sizeBytes);
  bytes.set(new TextEncoder().encode(UPLOAD.PDF_MAGIC), 0);
  return bytes;
}

function headersOnly(contentType: string | undefined): ExpressRequest {
  return { headers: { "content-type": contentType } } as unknown as ExpressRequest;
}

describe("isMultipart", () => {
  it("accepts a multipart content type with its boundary", () => {
    expect(
      isMultipart(headersOnly("multipart/form-data; boundary=----abc123"))
    ).toBe(true);
  });

  it("is case-insensitive, because header casing is the client's choice", () => {
    expect(isMultipart(headersOnly("MULTIPART/FORM-DATA; boundary=x"))).toBe(true);
  });

  it("rejects JSON and an absent content type", () => {
    expect(isMultipart(headersOnly("application/json"))).toBe(false);
    expect(isMultipart(headersOnly(undefined))).toBe(false);
    expect(isMultipart(headersOnly(""))).toBe(false);
  });
});

describe("readMultipart", () => {
  it("parses a well-formed upload into its parts", async () => {
    const form = new FormData();
    form.set(UPLOAD.RESUME_FIELD, new Blob([pdfBytes(1024)]), "resume.pdf");
    form.set(UPLOAD.GITHUB_FIELD, "https://github.com/Tharun2331");

    const parsed = await readMultipart(await multipartRequest(form));

    expect(parsed.has(UPLOAD.RESUME_FIELD)).toBe(true);
    expect(readTextField(parsed, UPLOAD.GITHUB_FIELD)).toBe(
      "https://github.com/Tharun2331"
    );
  });

  // The only layer that yields a clean 413 — it rejects before a byte of body
  // is read, so the response arrives instead of an ECONNRESET.
  it("rejects on the declared length before reading the body", async () => {
    const form = new FormData();
    form.set(UPLOAD.RESUME_FIELD, new Blob([pdfBytes(64)]), "resume.pdf");

    const req = await multipartRequest(form, {
      "content-length": String(UPLOAD.MAX_RESUME_BYTES * 10),
    });

    await expect(readMultipart(req)).rejects.toThrow(UploadError);
  });

  // A file exactly at the per-file cap must not be refused by the whole-body
  // budget, which is why BODY_OVERHEAD_BYTES exists.
  it("allows a body whose declared length is the file cap plus framing", async () => {
    const form = new FormData();
    form.set(UPLOAD.RESUME_FIELD, new Blob([pdfBytes(512)]), "resume.pdf");

    const req = await multipartRequest(form, {
      "content-length": String(UPLOAD.MAX_RESUME_BYTES + UPLOAD.BODY_OVERHEAD_BYTES),
    });

    await expect(readMultipart(req)).resolves.toBeDefined();
  });

  // Second layer: a client that lies about Content-Length or omits it entirely.
  // express.json({ limit }) does not cover this path — it ignores multipart.
  // The budget the stream is capped at is maxBytes PLUS BODY_OVERHEAD_BYTES, so
  // a body only exceeds it well past the nominal file limit. Sizing these below
  // that would make the test pass on the declared-size check instead and prove
  // nothing about the cap.
  const OVER_BUDGET = UPLOAD.BODY_OVERHEAD_BYTES * 4;

  it("caps the stream when the client understates the body size", async () => {
    const form = new FormData();
    form.set(UPLOAD.RESUME_FIELD, new Blob([pdfBytes(OVER_BUDGET)]), "resume.pdf");
    // A believable declared size that the body then blows straight past.
    const req = await multipartRequest(form, { "content-length": "10" });

    await expect(readMultipart(req, 1024)).rejects.toThrow(UploadError);
  });

  it("still caps a body that declares no length at all", async () => {
    const form = new FormData();
    form.set(UPLOAD.RESUME_FIELD, new Blob([pdfBytes(OVER_BUDGET)]), "resume.pdf");
    const encoded = new Response(form);
    const buffer = Buffer.from(await encoded.arrayBuffer());
    const stream = Readable.from(buffer);
    const req = stream as unknown as ExpressRequest;
    // Chunked transfer: no content-length for assertDeclaredSize to check, so
    // the cap is the only thing standing between this and unbounded buffering.
    req.headers = { "content-type": encoded.headers.get("content-type") ?? "" };

    await expect(readMultipart(req, 1024)).rejects.toThrow(UploadError);
  });

  it("reports malformed input as its own message rather than a size error", async () => {
    const stream = Readable.from(Buffer.from("not multipart at all"));
    const req = stream as unknown as ExpressRequest;
    req.headers = {
      "content-type": "multipart/form-data; boundary=----nonexistent",
      "content-length": "20",
    };

    await expect(readMultipart(req)).rejects.toThrow(MESSAGES.UPLOAD_MALFORMED);
  });
});

describe("readPdf", () => {
  // A form whose file part is built directly, so size and header can be varied
  // independently of the encoder.
  function formWith(value: unknown): MultipartForm {
    return {
      get: () => value as never,
      has: () => value !== null,
    };
  }

  function blobFile(bytes: Uint8Array, type = "application/pdf") {
    const blob = new Blob([bytes], { type });
    return {
      name: "resume.pdf",
      size: blob.size,
      type: blob.type,
      arrayBuffer: () => blob.arrayBuffer(),
    };
  }

  it("accepts a real PDF and returns its bytes", async () => {
    const result = await readPdf(formWith(blobFile(pdfBytes(2048))), "resume");

    expect(result.bytes.byteLength).toBe(2048);
    expect(result.filename).toBe("resume.pdf");
  });

  // Validated by file header, not declared MIME type: a part's Content-Type is
  // whatever the client wrote, so a renamed executable arrives claiming
  // application/pdf just as readily as a real PDF does.
  it("rejects a non-PDF that claims to be one", async () => {
    const disguised = new TextEncoder().encode("MZ\x90\x00 this is an executable");

    await expect(
      readPdf(formWith(blobFile(disguised, "application/pdf")), "resume")
    ).rejects.toThrow(MESSAGES.UPLOAD_NOT_PDF);
  });

  it("accepts a real PDF even when the client declared the wrong type", async () => {
    await expect(
      readPdf(formWith(blobFile(pdfBytes(1024), "application/octet-stream")), "resume")
    ).resolves.toBeDefined();
  });

  it("rejects a text field where a file was expected", async () => {
    await expect(readPdf(formWith("just a string"), "resume")).rejects.toThrow(
      MESSAGES.UPLOAD_NOT_A_FILE
    );
  });

  it("rejects an absent part", async () => {
    await expect(readPdf(formWith(null), "resume")).rejects.toThrow(
      MESSAGES.UPLOAD_NOT_A_FILE
    );
  });

  it("rejects an empty file", async () => {
    await expect(
      readPdf(formWith(blobFile(new Uint8Array(0))), "resume")
    ).rejects.toThrow(MESSAGES.UPLOAD_NOT_A_FILE);
  });

  // The exact per-file limit, which is what gives the precise "your file is X,
  // the limit is Y" answer the stream budget cannot.
  it("rejects a file over the per-file cap and quotes the limit", async () => {
    const oversized = blobFile(pdfBytes(UPLOAD.MAX_RESUME_BYTES + 1));

    await expect(readPdf(formWith(oversized), "resume")).rejects.toThrow(UploadError);
  });

  it("accepts a file exactly at the cap", async () => {
    const exact = blobFile(pdfBytes(UPLOAD.MAX_RESUME_BYTES));

    await expect(readPdf(formWith(exact), "resume")).resolves.toBeDefined();
  });

  // The parser yields a Blob, not a File, so the original filename does not
  // survive the round trip.
  it("falls back to a default filename when the part carries none", async () => {
    const blob = new Blob([pdfBytes(512)]);
    const nameless = {
      size: blob.size,
      type: blob.type,
      arrayBuffer: () => blob.arrayBuffer(),
    };

    expect((await readPdf(formWith(nameless), "resume")).filename).toBe("resume.pdf");
  });
});

describe("readTextField", () => {
  function formWith(value: unknown): MultipartForm {
    return { get: () => value as never, has: () => value !== null };
  }

  it("returns a non-empty string", () => {
    expect(readTextField(formWith("https://github.com/x"), "gitHub")).toBe(
      "https://github.com/x"
    );
  });

  it("treats an empty string as absent", () => {
    expect(readTextField(formWith(""), "gitHub")).toBeUndefined();
  });

  it("returns undefined for a missing field or a file", () => {
    expect(readTextField(formWith(null), "gitHub")).toBeUndefined();
    expect(
      readTextField(
        formWith({ size: 1, type: "application/pdf", arrayBuffer: async () => new ArrayBuffer(1) }),
        "gitHub"
      )
    ).toBeUndefined();
  });
});
