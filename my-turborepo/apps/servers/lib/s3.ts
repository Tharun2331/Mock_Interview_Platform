import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { config } from "./config";
import { UPLOAD } from "./constants";
import { UploadError } from "./errors";
import { MESSAGES } from "./messages";

export const s3Client = new S3Client({ region: config.awsRegion });

// Checked at point of use rather than at boot. The bucket is only needed by the
// upload path, and failing startup over it would take down /plan and the auth
// routes too — which have nothing to do with S3.
function requireBucket(): string {
  if (config.uploadsBucket.length === 0) {
    throw new UploadError(MESSAGES.UPLOAD_BUCKET_UNSET);
  }
  return config.uploadsBucket;
}

// Cognito subs are UUIDs and session ids are generated here, so both are
// already safe. Enforced anyway because the IAM policy's prefix scoping assumes
// keys stay under `resumes/` — a stray path segment from a future caller would
// quietly undermine that.
const SAFE_KEY_SEGMENT = /^[A-Za-z0-9._-]+$/;

export function resumeKey(userId: string, sessionId: string): string {
  if (!SAFE_KEY_SEGMENT.test(userId) || !SAFE_KEY_SEGMENT.test(sessionId)) {
    throw new UploadError(MESSAGES.UPLOAD_STORE_FAILED);
  }
  return `resumes/${userId}/${sessionId}.pdf`;
}

// Stores the raw PDF exactly as uploaded. The parsed text is what the Planner
// reads, but the original is kept so a parser change can be re-run against past
// uploads without asking candidates to re-submit.
export async function putResume(args: {
  userId: string;
  sessionId: string;
  bytes: Uint8Array;
}): Promise<string> {
  const key = resumeKey(args.userId, args.sessionId);

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
    if (error instanceof UploadError) throw error;
    throw new UploadError(MESSAGES.UPLOAD_STORE_FAILED);
  }
}
