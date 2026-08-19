import { CognitoJwtVerifier } from "aws-jwt-verify";
import type { NextFunction, Request, Response } from "express";
import { config } from "./config";
import { MESSAGES } from "./messages";

const verifier = CognitoJwtVerifier.create({
  userPoolId: config.cognitoUserPoolId,
  tokenUse: "access",
  clientId: config.cognitoUserPoolClientId,
});

export const AuthMiddleware = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  // 1. Extract token from the Authorization header (Format: Bearer <token>)
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: MESSAGES.UNAUTHORIZED_MISSING_TOKEN });
    return;
  }

  const token = authHeader.slice("Bearer ".length);

  try {
    // 2. Verify the token
    const payload = await verifier.verify(token);

    // 3. Attach the user context to the request object.
    // `scope` is optional on the payload type, and reading `.split` off an
    // absent claim would throw here — caught below and turned into a 401, which
    // would reject a perfectly valid user. Absent scope means no scopes.
    req.user = {
      id: payload.sub,
      username: payload.username,
      scopes: payload.scope?.split(" ") ?? [],
    };

    next();
  } catch (e: unknown) {
    if (e instanceof Error) {
      console.error(e.message);
    } else {
      console.error("Unknown error", e);
    }
    res.status(401).json({ error: MESSAGES.UNAUTHORIZED_INVALID_TOKEN });
  }
};
