import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import type { ProfileView } from "@repo/shared";
import { fetchProfile } from "@/lib/profileApi";
import { transportMessage } from "@/lib/httpErrors";
import { MESSAGES } from "@/lib/messages";

// The candidate's profile, fetched once per session and shared by everything
// that needs it: the onboarding guard, the profile page, and the interview
// setup screen's "planned from your resume" line.
//
// Modelled the same way as AuthProvider — a discriminated union rather than
// `profile` plus `isLoading` plus `error`, so "loading and errored at once" is
// unrepresentable instead of merely unlikely.
//
// `error` is a real state, not a toast. This gates the whole app: a failed fetch
// must not be mistaken for "no profile yet" and silently push a returning user
// back through onboarding they already finished.
export type ProfileState =
  | { status: "loading" }
  | { status: "ready"; profile: ProfileView | null }
  | { status: "error"; message: string };

type ProfileContextValue = ProfileState & {
  // Called after any successful write so the guard and the header see the new
  // value without a refetch. Handed the server's response rather than
  // re-reading, because the write already returned the updated profile.
  setProfile: (profile: ProfileView) => void;
  reload: () => void;
  // After erasure there is no profile and no account — distinct from `null`,
  // which means "signed in, nothing saved yet".
  clear: () => void;
};

const ProfileContext = createContext<ProfileContextValue | undefined>(undefined);

export function ProfileProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ProfileState>({ status: "loading" });

  const load = useCallback(() => {
    let cancelled = false;
    setState({ status: "loading" });

    fetchProfile()
      .then((profile) => {
        if (!cancelled) setState({ status: "ready", profile });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({
          status: "error",
          message: transportMessage(error, MESSAGES.PROFILE_LOAD_FAILED),
        });
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => load(), [load]);

  return (
    <ProfileContext.Provider
      value={{
        ...state,
        setProfile: (profile) => setState({ status: "ready", profile }),
        reload: () => load(),
        clear: () => setState({ status: "ready", profile: null }),
      }}
    >
      {children}
    </ProfileContext.Provider>
  );
}

export function useProfile(): ProfileContextValue {
  const value = useContext(ProfileContext);
  if (value === undefined) {
    throw new Error("useProfile must be used within a ProfileProvider");
  }
  return value;
}
