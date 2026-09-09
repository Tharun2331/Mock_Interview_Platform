import {
  ProfileResponseSchema,
  ProfileViewSchema,
  ResumeUploadResponseSchema,
  UPLOAD_FIELDS,
  type ProfileDetailsBody,
  type ProfileView,
  type ResumeUploadResponse,
} from "@repo/shared";
import { api } from "@/lib/api";

// Every profile call in one module, each parsing the response against the same
// shared schema the server builds it from. A route that changes shape fails here
// with a parse error rather than three screens later with an undefined.

const PROFILE_URL = "/api/v1/profile";

export class UnexpectedResponseError extends Error {
  constructor() {
    super("The server sent something this app does not understand.");
    this.name = "UnexpectedResponseError";
  }
}

// Null means "no profile saved yet", which is the expected state on a first
// sign-in rather than an error — the server answers 200 with a null body field
// for exactly this reason, so there is no 404 to special-case here.
export async function fetchProfile(): Promise<ProfileView | null> {
  const response = await api.get(PROFILE_URL);
  const parsed = ProfileResponseSchema.safeParse(response.data);
  if (!parsed.success) throw new UnexpectedResponseError();
  return parsed.data.profile;
}

function parseProfileEnvelope(data: unknown): ProfileView {
  const parsed = ProfileViewSchema.safeParse(
    typeof data === "object" && data !== null && "profile" in data
      ? (data as { profile: unknown }).profile
      : undefined
  );
  if (!parsed.success) throw new UnexpectedResponseError();
  return parsed.data;
}

export async function saveProfileDetails(
  body: ProfileDetailsBody
): Promise<ProfileView> {
  const response = await api.put(PROFILE_URL, body);
  return parseProfileEnvelope(response.data);
}

// Separate from the resume upload because the resume route requires a file.
// Sending no `gitHub` disconnects the profile rather than failing validation.
export async function saveGithub(gitHub: string | null): Promise<ProfileView> {
  const response = await api.put(`${PROFILE_URL}/github`, {
    gitHub: gitHub ?? undefined,
  });
  return parseProfileEnvelope(response.data);
}

export async function uploadResume(args: {
  file: File;
  gitHub: string | null;
  onProgress: (percent: number) => void;
}): Promise<ResumeUploadResponse> {
  const body = new FormData();
  body.append(UPLOAD_FIELDS.RESUME, args.file);
  // Omitted rather than sent empty — the server distinguishes "no profile
  // given" from "a profile that failed to parse".
  if (args.gitHub !== null && args.gitHub.length > 0) {
    body.append(UPLOAD_FIELDS.GITHUB, args.gitHub);
  }

  const response = await api.post(`${PROFILE_URL}/resume`, body, {
    // Real bytes-sent progress, not a simulated bar. Once the last byte is out
    // the wait becomes server-side parsing, redaction and storage, none of
    // which report progress — so the phase changes rather than the bar stalling
    // at 100% and looking hung.
    onUploadProgress: (event) => {
      if (event.total === undefined || event.total === 0) return;
      args.onProgress(Math.round((event.loaded / event.total) * 100));
    },
  });

  const parsed = ResumeUploadResponseSchema.safeParse(response.data);
  if (!parsed.success) throw new UnexpectedResponseError();
  return parsed.data;
}

export async function deleteAccount(): Promise<void> {
  await api.delete(PROFILE_URL);
}
