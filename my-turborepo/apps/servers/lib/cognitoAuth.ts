import { CognitoJwtVerifier } from "aws-jwt-verify";
import type { NextFunction, Request, Response } from "express";
import { readAccessToken } from "./authCookies";
import { config } from "./config";
import { MESSAGES } from "./messages";
import { recordAuthFailure } from "./metrics";

// Exported so the WebSocket upgrade handler verifies against the same JWKS
// cache rather than standing up a second verifier. Same trust decision, read
// from the handshake's cookie instead of a request's.
//
// Two client ids while the web app moves to cookies (ADR-0011): the public
// Amplify client's tokens and the confidential server client's. The public id
// goes when that client is deleted.
export const verifier = CognitoJwtVerifier.create({
  userPoolId: config.cognitoUserPoolId,
  tokenUse: "access",
  clientId: [
    config.cognitoUserPoolClientId,
    config.cognitoServerClientId,
  ].filter((id) => id.length > 0),
});

export const AuthMiddleware = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  // 1. The access token: the httpOnly cookie, else (until the web app has
  //    moved over) an `Authorization: Bearer` header. See readAccessToken.
  const token = readAccessToken(req);
  if (token === undefined) {
    recordAuthFailure();
    res.status(401).json({ error: MESSAGES.UNAUTHORIZED_MISSING_TOKEN });
    return;
  }

  try {
    // 2. Verify the token
    const payload = await verifier.verify(token);

    // 3. Attach the user context to the request object.
    // `scope` is optional on the payload type, and reading `.split` off an
    // absent claim would throw here — caught below and turned into a 401, which
    // would reject a perfectly valid user. Absent scope means no scopes.
    //
    // `cognito:groups` is read here rather than in the admin middleware so the
    // token is the single source of group membership: every route sees the same
    // value, and a second reader could not re-verify a token it never held.
    // Cognito omits the claim entirely for a user in no groups — which is every
    // candidate — so absence is the normal case and means no groups.
    req.user = {
      id: payload.sub,
      username: payload.username,
      scopes: payload.scope?.split(" ") ?? [],
      groups: payload["cognito:groups"] ?? [],
    };

    next();
  } catch (e: unknown) {
    if (e instanceof Error) {
      console.error(e.message);
    } else {
      console.error("Unknown error", e);
    }
    recordAuthFailure();
    res.status(401).json({ error: MESSAGES.UNAUTHORIZED_INVALID_TOKEN });
  }
};
