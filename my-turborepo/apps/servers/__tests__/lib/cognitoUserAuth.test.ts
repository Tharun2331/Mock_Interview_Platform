import { describe, expect, it } from "bun:test";
import {
  mapCognitoError,
  pkceChallenge,
  totpSetupUri,
  usernameFromAccessToken,
} from "../../lib/cognitoUserAuth";

function cognitoError(name: string, message = "detail"): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

describe("mapCognitoError", () => {
  // One exception, three meanings. A shared table is how a settings screen
  // ends up telling someone their password was wrong when they typed none.
  it("reads NotAuthorizedException by the step that raised it", () => {
    const error = cognitoError("NotAuthorizedException");
    expect(mapCognitoError(error, "signin")).toMatchObject({
      code: "INVALID_CREDENTIALS",
      status: 401,
    });
    expect(mapCognitoError(error, "totp").code).toBe("SIGNIN_EXPIRED");
    expect(mapCognitoError(error, "session").code).toBe("UNAUTHENTICATED");
  });

  // The enumeration oracle: an unknown email and a wrong password must be
  // indistinguishable from the outside.
  it("answers an unknown user exactly like a wrong password at sign-in", () => {
    const unknown = mapCognitoError(
      cognitoError("UserNotFoundException"),
      "signin",
    );
    const wrong = mapCognitoError(
      cognitoError("NotAuthorizedException"),
      "signin",
    );
    expect([unknown.code, unknown.status]).toEqual([wrong.code, wrong.status]);
  });

  it("tells a failed human check from a refused address", () => {
    expect(
      mapCognitoError(
        cognitoError(
          "UserLambdaValidationException",
          "PreSignUp failed with error We could not confirm you are a person. Please try again..",
        ),
        "signup",
      ).code,
    ).toBe("HUMAN_CHECK_FAILED");
    expect(
      mapCognitoError(
        cognitoError("UserLambdaValidationException", "disposable domain"),
        "signup",
      ).code,
    ).toBe("EMAIL_NOT_ALLOWED");
  });

  it("maps throttling to TOO_MANY_ATTEMPTS", () => {
    for (const name of [
      "LimitExceededException",
      "TooManyRequestsException",
      "TooManyFailedAttemptsException",
    ]) {
      expect(mapCognitoError(cognitoError(name), "signin")).toMatchObject({
        code: "TOO_MANY_ATTEMPTS",
        status: 429,
      });
    }
  });

  // Never Cognito's text to the client: the message is for the log only.
  it("maps anything unrecognised to FAILED, keeping detail for the log", () => {
    const mapped = mapCognitoError(
      cognitoError("InternalErrorException", "pool us-east-1_x exploded"),
      "signin",
    );
    expect(mapped).toMatchObject({ code: "FAILED", status: 502 });
    expect(mapped.message).toContain("InternalErrorException");
  });
});

describe("pkceChallenge", () => {
  // RFC 7636, appendix B.
  it("matches the RFC's S256 test vector", () => {
    expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });
});

describe("totpSetupUri", () => {
  it("builds the otpauth URI authenticator apps scan", () => {
    expect(totpSetupUri("ada@example.com", "SECRET234")).toBe(
      "otpauth://totp/PrepPilot:ada%40example.com?secret=SECRET234&issuer=PrepPilot",
    );
  });
});

describe("usernameFromAccessToken", () => {
  const token = (claims: object) =>
    `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;

  // Federated users' usernames differ from their sub, and a refresh must be
  // signed with the username — so it is the claim that is kept.
  it("reads the username claim, not the sub", () => {
    expect(
      usernameFromAccessToken(token({ sub: "abc", username: "google_123" })),
    ).toBe("google_123");
  });

  it("refuses a token without the claims", () => {
    expect(() => usernameFromAccessToken(token({ sub: "abc" }))).toThrow();
    expect(() => usernameFromAccessToken("not-a-jwt")).toThrow();
  });
});
