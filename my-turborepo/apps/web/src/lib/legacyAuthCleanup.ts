// Removes what Amplify left in localStorage before ADR-0011.
//
// A candidate who signed in before the move to cookies still has Amplify's
// tokens here — a refresh token among them, valid for up to 7 days — and
// nothing reads them any more. Left alone they are exactly what the move
// exists to stop: tokens a script injection could read. Deleting the old
// public app client (ADR-0011, Phase 4) makes them worthless; this makes them
// gone, on the first load of the new bundle.
//
// Amplify v6 keys every entry under one of these prefixes. Nothing else this
// app stores uses them.
const LEGACY_PREFIXES = ["CognitoIdentityServiceProvider.", "amplify-"];

export function clearLegacyAuthStorage(): void {
  try {
    const stale = Object.keys(localStorage).filter((key) =>
      LEGACY_PREFIXES.some((prefix) => key.startsWith(prefix)),
    );
    for (const key of stale) localStorage.removeItem(key);
  } catch {
    // Storage blocked (private mode, a strict browser setting): there is
    // nothing of ours in it to clear.
  }
}
