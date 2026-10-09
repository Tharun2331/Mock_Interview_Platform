import { afterEach, describe, expect, it } from "bun:test";
import { clearLegacyAuthStorage } from "@/lib/legacyAuthCleanup";

afterEach(() => localStorage.clear());

describe("clearLegacyAuthStorage", () => {
  // The tokens the move to cookies exists to take out of script's reach.
  it("removes Amplify's tokens and markers", () => {
    localStorage.setItem(
      "CognitoIdentityServiceProvider.client.user.refreshToken",
      "rt",
    );
    localStorage.setItem(
      "CognitoIdentityServiceProvider.client.LastAuthUser",
      "user",
    );
    localStorage.setItem("amplify-signin-with-hostedUI", "true");

    clearLegacyAuthStorage();

    expect(localStorage.length).toBe(0);
  });

  it("leaves the app's own entries alone", () => {
    localStorage.setItem("theme", "dark");
    localStorage.setItem("CognitoIdentityServiceProvider.x.idToken", "id");

    clearLegacyAuthStorage();

    expect(localStorage.getItem("theme")).toBe("dark");
    expect(localStorage.length).toBe(1);
  });
});
