import {
  AdminDeleteUserCommand,
  CognitoIdentityProviderClient,
  UserNotFoundException,
} from "@aws-sdk/client-cognito-identity-provider";
import { config } from "./config";
import { ServiceError } from "./errors";
import { MESSAGES } from "./messages";

// Admin-side Cognito, separate from lib/cognitoAuth.ts on purpose. That module
// verifies tokens against a public JWKS and needs no AWS credentials at all;
// this one calls the management API as the task role. Same service, entirely
// different trust boundary — and keeping them apart is what stops the verifier
// quietly acquiring the ability to delete the users it authenticates.
export const cognitoAdminClient = new CognitoIdentityProviderClient({
  region: config.awsRegion,
});

// Removes the identity itself, closing out an erasure request.
//
// Takes the Cognito *username*, not the `sub`. They are the same string for a
// plain sign-up and very much not for a federated one, where the username looks
// like `google_10937...`. The access token carries both — AuthMiddleware puts
// the sub on `req.user.id` and the username on `req.user.username` — so the
// caller has to pass the right one rather than reusing the id that keys every
// DynamoDB item.
//
// A user who is already gone is a success, not a failure: erasure has to be
// safe to retry, and the second attempt should not fail on the step the first
// one completed.
export async function deleteCognitoUser(username: string): Promise<void> {
  try {
    await cognitoAdminClient.send(
      new AdminDeleteUserCommand({
        UserPoolId: config.cognitoUserPoolId,
        Username: username,
      })
    );
  } catch (error) {
    if (error instanceof UserNotFoundException) return;
    throw new ServiceError(
      `${MESSAGES.COGNITO_DELETE_FAILED} — ${
        error instanceof Error ? error.message : "unknown"
      }`
    );
  }
}
