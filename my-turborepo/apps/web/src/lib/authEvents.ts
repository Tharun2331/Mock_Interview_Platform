// What changed about the session, for AuthProvider to follow (ADR-0011).
//
// The role Amplify's Hub played: pages sign in and out through lib/authApi,
// and the provider learns of it here rather than every page reaching into a
// context. `expired` comes from the API client when a refresh fails mid-session.

export type AuthEvent = "signedIn" | "signedOut" | "expired";

type Listener = (event: AuthEvent) => void;

const listeners = new Set<Listener>();

export function onAuthEvent(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function emitAuthEvent(event: AuthEvent): void {
  for (const listener of listeners) listener(event);
}
