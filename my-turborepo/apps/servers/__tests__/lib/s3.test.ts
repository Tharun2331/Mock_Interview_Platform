import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import {
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";
import { UPLOAD } from "../../lib/constants";
import { ServiceError, UploadError } from "../../lib/errors";
import { MESSAGES } from "../../lib/messages";
import { deleteResume, putResume, resumeKey } from "../../lib/s3";

// The candidate's entire S3 footprint is one object, and this module owns both
// writing and removing it.

const s3 = mockClient(S3Client);

const USER_ID = "8f14e45f-ceea-467a-9a3f-3b1d2c4e5f60";
const BUCKET = "prepilot-uploads-test";

beforeEach(() => {
  s3.reset();
  s3.on(PutObjectCommand).resolves({});
  s3.on(DeleteObjectCommand).resolves({});
});

afterAll(() => s3.restore());

// One object per user, not one per session. Keying by session meant N copies of
// one file and no way to answer "what is this candidate's current resume"
// without reading every session to find out.
describe("where a resume is stored", () => {
  it("is one stable key per user", () => {
    expect(resumeKey(USER_ID)).toBe(`resumes/${USER_ID}/resume.pdf`);
  });

  it("is the same key on a re-upload, so the old one is overwritten", () => {
    expect(resumeKey(USER_ID)).toBe(resumeKey(USER_ID));
  });

  // Cognito subs are UUIDs and session ids are server-generated ULIDs, so this
  // is already safe. It is enforced anyway because the IAM policy scopes writes
  // to the `resumes/` prefix — a stray path segment from a future caller would
  // quietly undermine that, and IAM would not notice.
  it.each([
    ["../../etc/passwd", "traversal"],
    ["a/b", "a path separator"],
    ["user id", "a space"],
    ["", "an empty id"],
    ["user%2f..", "percent encoding"],
  ])("refuses %p — %s", (userId) => {
    expect(() => resumeKey(userId)).toThrow(UploadError);
  });

  it("accepts the identifier shapes the app actually produces", () => {
    // A Cognito sub, a federated username, and a ULID.
    for (const id of [
      USER_ID,
      "google_109371234567890",
      "01J000000000000000000000",
    ]) {
      expect(() => resumeKey(id)).not.toThrow();
    }
  });
});

describe("storing the PDF", () => {
  it("writes it to the candidate's key as a PDF", async () => {
    await putResume({ userId: USER_ID, bytes: new Uint8Array([1, 2, 3]) });

    const input = s3.commandCalls(PutObjectCommand)[0]?.args[0].input;
    expect(input?.Bucket).toBe(BUCKET);
    expect(input?.Key).toBe(`resumes/${USER_ID}/resume.pdf`);
    expect(input?.ContentType).toBe(UPLOAD.RESUME_MIME);
  });

  it("returns the key it wrote, so the caller stores a pointer it did not guess", async () => {
    const key = await putResume({
      userId: USER_ID,
      bytes: new Uint8Array([1]),
    });

    expect(key).toBe(`resumes/${USER_ID}/resume.pdf`);
  });

  // Stored raw, PII and all, deliberately: the redacted text in DynamoDB is
  // what the Planner reads, and this is the archive a parser change can be
  // re-run against.
  it("stores the bytes exactly as given", async () => {
    const bytes = new Uint8Array([37, 80, 68, 70]);

    await putResume({ userId: USER_ID, bytes });

    expect(s3.commandCalls(PutObjectCommand)[0]?.args[0].input.Body).toBe(
      bytes,
    );
  });

  it("writes nothing when the key is refused", async () => {
    await expect(
      putResume({ userId: "../evil", bytes: new Uint8Array([1]) }),
    ).rejects.toThrow(UploadError);

    expect(s3.commandCalls(PutObjectCommand)).toHaveLength(0);
  });

  // Credentials, network, bucket policy — none of it is the candidate's doing,
  // so it must not surface as a problem with their file.
  it("wraps a failed write as a ServiceError, not an UploadError", async () => {
    s3.on(PutObjectCommand).rejects(new Error("AccessDenied"));

    await expect(
      putResume({ userId: USER_ID, bytes: new Uint8Array([1]) }),
    ).rejects.toThrow(ServiceError);
  });

  it("keeps the cause in the message for the log", async () => {
    s3.on(PutObjectCommand).rejects(new Error("AccessDenied"));

    await expect(
      putResume({ userId: USER_ID, bytes: new Uint8Array([1]) }),
    ).rejects.toThrow(/AccessDenied/);
  });
});

describe("removing the PDF", () => {
  it("deletes the candidate's one object", async () => {
    await deleteResume(USER_ID);

    const input = s3.commandCalls(DeleteObjectCommand)[0]?.args[0].input;
    expect(input?.Bucket).toBe(BUCKET);
    expect(input?.Key).toBe(`resumes/${USER_ID}/resume.pdf`);
  });

  // S3 treats deleting a missing key as success, which is what makes erasure
  // safe to retry: a sweep that failed halfway can simply be run again.
  it("is safe to run twice", async () => {
    await deleteResume(USER_ID);
    await deleteResume(USER_ID);

    expect(s3.commandCalls(DeleteObjectCommand)).toHaveLength(2);
  });

  it("wraps a failed delete as a ServiceError", async () => {
    s3.on(DeleteObjectCommand).rejects(new Error("NoSuchBucket"));

    await expect(deleteResume(USER_ID)).rejects.toThrow(ServiceError);
  });

  it("says the delete failed rather than the upload", async () => {
    s3.on(DeleteObjectCommand).rejects(new Error("NoSuchBucket"));

    await expect(deleteResume(USER_ID)).rejects.toThrow(
      MESSAGES.RESUME_DELETE_FAILED,
    );
  });

  it("refuses an unsafe id without calling S3", async () => {
    await expect(deleteResume("../evil")).rejects.toThrow(UploadError);

    expect(s3.commandCalls(DeleteObjectCommand)).toHaveLength(0);
  });
});
