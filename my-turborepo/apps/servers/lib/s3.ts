import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { config } from "./config";
import { UPLOAD } from "./constants";
import { ServiceError, UploadError } from "./errors";
import { MESSAGES } from "./messages";

export const s3Client = new S3Client({ region: config.awsRegion });

// Checked at point of use rather than at boot. The bucket is only needed by the
// upload path, and failing startup over it would take down /plan and the auth
// routes too — which have nothing to do with S3.
function requireBucket(): string {
  if (config.uploadsBucket.length === 0) {
    // ServiceError, not UploadError: nothing about the candidate's file is
    // wrong. Set UPLOADS_BUCKET from `terraform output uploads_bucket_id`.
    throw new ServiceError(MESSAGES.UPLOAD_BUCKET_UNSET);
  }
  return config.uploadsBucket;
}

// Cognito subs are UUIDs and session ids are server-generated ULIDs, so both
// are already safe. Enforced anyway because the IAM policy's prefix scoping
// assumes keys stay under `resumes/` — a stray path segment from a future
// caller would quietly undermine that.
const SAFE_KEY_SEGMENT = /^[A-Za-z0-9._-]+$/;

// One object per user, not one per session. The resume moved from session-scoped
// to user-scoped material: it is the same document every time, and keying it by
// session meant N copies of one file and no way to answer "what is this
// candidate's current resume" without reading the sessions to find out.
//
// Re-uploading overwrites. That is destructive by design and the bucket has no
// versioning: what is lost is the candidate's own file, which they still have,
// and versioning would solve accidental deletion rather than the staleness this
// design actually cares about — that is what `profileVersion` is for.
//
// The overwrite is only safe because the caller writes here last. Parsing and
// redaction happen first, in memory, so a failure in either leaves the previous
// object untouched rather than replacing a good resume with an unusable one.
export function resumeKey(userId: string): string {
  if (!SAFE_KEY_SEGMENT.test(userId)) {
    throw new UploadError(MESSAGES.UPLOAD_STORE_FAILED);
  }
  return `resumes/${userId}/resume.pdf`;
}

// Stores the raw PDF exactly as uploaded — PII and all, deliberately.
//
// The redacted text in DynamoDB is what the Planner reads; this is the archive.
// It exists so a parser change can be re-run against past uploads without asking
// candidates to re-submit, and so a candidate can get back the file they gave
// us. Redaction protects the inference boundary, not this one.
export async function putResume(args: {
  userId: string;
  bytes: Uint8Array;
}): Promise<string> {
  const key = resumeKey(args.userId);

  try {
    await s3Client.send(
      new PutObjectCommand({
        Bucket: requireBucket(),
        Key: key,
        Body: args.bytes,
        ContentType: UPLOAD.RESUME_MIME,
      })
    );
    return key;
  } catch (error) {
    if (error instanceof UploadError || error instanceof ServiceError) throw error; 
    // The write itself failed — credentials, network, bucket policy. Again not
    // the candidate's doing, so it must not read as a problem with their file.
    throw new ServiceError(
      `${MESSAGES.UPLOAD_STORE_FAILED} ${error instanceof Error ? error.message : ""}`.trim()
    );
  }
}
