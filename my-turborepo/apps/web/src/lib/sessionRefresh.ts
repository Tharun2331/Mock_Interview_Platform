import type {
  AxiosError,
  AxiosInstance,
  InternalAxiosRequestConfig,
} from "axios";

// Refresh-on-401 for the cookie session (ADR-0011).
//
// The access token lives in an httpOnly cookie for an hour. When it lapses, the
// next API call answers 401; this asks the server to renew it (POST
// /auth/refresh, which reads the refresh cookie this page cannot see) and
// replays the request once. A candidate mid-session never notices.
//
// Three rules, each guarding a real failure:
//
// - **One refresh at a time.** A page that fires four requests when the token
//   lapses would otherwise send four refreshes. They all share one in-flight
//   promise.
// - **One replay per request.** A request that 401s AFTER a successful refresh
//   is refused for some other reason, and retrying it again would loop.
// - **A failed refresh ends the session,** loudly, through `onExpired`, so the
//   auth state flips to signed out and the guards route to sign-in, rather than
//   every later call failing one by one.
//
// Kept apart from api.ts and free of module state beyond the in-flight promise,
// so it is tested against a fake adapter with no module mocks.

type RetriableConfig = InternalAxiosRequestConfig & { _sessionRetried?: true };

export function attachSessionRefresh(
  instance: AxiosInstance,
  args: {
    refresh: () => Promise<void>;
    onExpired: () => void;
  },
): void {
  let inFlight: Promise<boolean> | null = null;

  const refreshOnce = (): Promise<boolean> => {
    inFlight ??= args
      .refresh()
      .then(() => true)
      .catch(() => false)
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  instance.interceptors.response.use(undefined, async (error: AxiosError) => {
    const original = error.config as RetriableConfig | undefined;

    if (
      error.response?.status !== 401 ||
      original === undefined ||
      original._sessionRetried === true
    ) {
      throw error;
    }

    const renewed = await refreshOnce();
    if (!renewed) {
      args.onExpired();
      throw error;
    }

    original._sessionRetried = true;
    return instance.request(original);
  });
}
