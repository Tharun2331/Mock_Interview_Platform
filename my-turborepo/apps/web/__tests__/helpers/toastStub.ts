import { mock } from "bun:test";

// The single `sonner` stub, shared by every test that needs to read a toast.
//
// One registration, in one place, for the reason `profileStub.ts` gives at length:
// `mock.module` is GLOBAL and permanent for the process, and Bun runs every test
// file in one process. Two files each registering their own `sonner` would not get
// one stub each — the later registration replaces the earlier for everybody, and
// whichever file loaded first ends up asserting against a stub whose state it
// cannot reach. That is not hypothetical here; `routes/plan.test.ts` hijacked all
// 24 tests in `agents/planner.test.ts` on Linux CI exactly this way.
//
// Safe to stub at all because `sonner` is a third-party leaf that talks to the
// DOM, not a module any test in this repo is the subject of. `AppToaster` is never
// mounted in these tests, so without this a toast goes nowhere and its message —
// which is the whole assertion for an error path — is unobservable.

export type ToastCall = {
  level: "error" | "success" | "warning";
  message: string;
};

export const toasts: ToastCall[] = [];

const record =
  (level: ToastCall["level"]) =>
  (message: unknown): void => {
    toasts.push({ level, message: String(message) });
  };

mock.module("sonner", () => ({
  toast: {
    error: record("error"),
    success: record("success"),
    warning: record("warning"),
  },
  // Rendered by AppShell in the component tests. A no-op component keeps those
  // trees mountable without pulling in the real toaster's portals and timers.
  Toaster: () => null,
}));

export function resetToasts(): void {
  toasts.length = 0;
}

/** Every message toasted at `level`, in order. */
export function messagesAt(level: ToastCall["level"]): string[] {
  return toasts
    .filter((call) => call.level === level)
    .map((call) => call.message);
}
