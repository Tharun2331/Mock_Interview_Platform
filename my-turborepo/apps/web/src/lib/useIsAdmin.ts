import { useEffect, useState } from "react";
import { isAdminSession } from "@/lib/adminApi";

// Whether this session's token carries the admin group.
//
// A hook rather than the bare async function, because two places need the answer —
// the header's nav link and the /admin page's own gate — and each doing its own
// effect is how the two end up disagreeing about what "loading" looks like.
//
// Deliberately NOT a context provider, unlike `useProfile`. That one wraps a real
// fetch whose result is shared state worth caching once; this reads a claim off a
// token Amplify already holds in memory, so the call is local and cheap and a
// provider would be ceremony around a property access. The cost of two callers is
// two reads of a cached token.
//
// `null` while the token is being read, so a caller can tell "not yet known" from
// "not an admin" — the difference between rendering nothing for an instant and
// telling someone they lack access before checking.
//
// **This is a rendering signal, never an authorisation one.** The server's
// RequireAdmin middleware is the control, and it answers 404 to everyone outside
// the group regardless of what this returns.
export function useIsAdmin(): boolean | null {
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);

  useEffect(() => {
    let active = true;

    void (async () => {
      const result = await isAdminSession();
      // Guarded against resolving after unmount. Reachable in the header, which
      // unmounts on sign-out while this read is in flight — and setting state on a
      // dead component is a warning that looks like a bug in the auth flow.
      if (active) setIsAdmin(result);
    })();

    return () => {
      active = false;
    };
  }, []);

  return isAdmin;
}
