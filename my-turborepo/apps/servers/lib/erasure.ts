import { deleteCognitoUser } from "./cognitoAdmin";
import { deleteProfileItems, markProfileDeleting } from "./profile";
import { deleteResume } from "./s3";
import {
  deleteSessionData,
  deleteUserSessionRefs,
  listUserSessionIds,
} from "./sessions";

// Account erasure, spanning four stores: DynamoDB, S3, the profile item itself
// and Cognito. It lives here rather than in any one of their modules because it
// belongs to none of them — profile.ts owns the profile's key layout, and this
// owns the order the stores are touched in.
//
// That order is the entire design. Erasure is not atomic and cannot be, so it is
// built to be *resumable* instead: a marker goes down first, everything
// destructive is idempotent, and the marker comes up last. A sweep that dies
// halfway leaves an account that is already locked out and a marker saying the
// job is unfinished, and running it again simply completes it.
//
// It runs synchronously inside the request. At this product's scale a candidate
// has a handful of sessions and this is a few hundred milliseconds; the mark /
// unmark ordering is what makes that safe, because a timeout degrades to "retry
// later" rather than to a half-deleted account. Moving the sweep onto the
// Phase 5 SQS worker later changes where it runs, not how it is ordered.

export type ErasureSummary = {
  hadProfile: boolean;
  sessionsDeleted: number;
  itemsDeleted: number;
};

export async function eraseUserAccount(args: {
  userId: string;
  username: string;
}): Promise<ErasureSummary> {
  // 1. Mark. Nothing has been destroyed yet, and from this point every mutating
  //    path refuses the account — including a request that was already in flight
  //    when this one arrived.
  const hadProfile = await markProfileDeleting({ userId: args.userId });

  // 2. Sweep the sessions. Read before deleting, because the refs under
  //    USER#<uid> are the only index of which sessions exist — destroying them
  //    first would strand every SESSION#<sid> partition they point at.
  const sessionIds = await listUserSessionIds({ userId: args.userId });

  let itemsDeleted = 0;
  for (const sessionId of sessionIds) {
    itemsDeleted += await deleteSessionData({ sessionId });
  }

  // The refs live in the user's partition, not the session's, so the loop above
  // did not touch them. Deleted only now that every partition they point at is
  // gone: while a ref survives, the sweep can still find its way back to a
  // session it has not finished with.
  itemsDeleted += await deleteUserSessionRefs({
    userId: args.userId,
    sessionIds,
  });

  // 3. The S3 archive. One object, because the resume moved to a stable
  //    per-user key — this is the whole of a candidate's object storage.
  await deleteResume(args.userId);

  // 4. Remove the marker and the cached plan. After this the candidate's data
  //    is gone; only the identity remains.
  await deleteProfileItems({ userId: args.userId });

  // 5. Cognito last, because it is the one step that cannot be undone by
  //    retrying. If it fails, the data is already gone and the candidate can
  //    still sign in — they land on onboarding with an empty profile, which is
  //    a recoverable state. Deleting the identity first would instead leave any
  //    surviving data unreachable, with no way to authenticate a retry.
  await deleteCognitoUser(args.username);

  return {
    hadProfile,
    sessionsDeleted: sessionIds.length,
    itemsDeleted,
  };
}
