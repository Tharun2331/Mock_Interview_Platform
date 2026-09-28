import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangleIcon,
  ChartLineIcon,
  RefreshCwIcon,
  ShieldIcon,
} from "lucide-react";
import {
  INTERVIEW_QUOTA,
  METRICS_WINDOW,
  resolveSessionAllowance,
  type AdminMetricsResponse,
  type AdminUserRow,
  type MetricsWindowHours,
} from "@repo/shared";

import { Eyebrow } from "@/components/Eyebrow";
import { MetricChart } from "@/components/MetricChart";
import { PresenceOrb } from "@/components/PresenceOrb";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  fetchAdminMetrics,
  fetchAdminUsers,
  setUnlimitedAccess,
} from "@/lib/adminApi";
import {
  ambiguousUsernames,
  serverMessage,
  transportMessage,
} from "@/lib/httpErrors";
import { useIsAdmin } from "@/lib/useIsAdmin";
import {
  MESSAGES,
  adminAccountsLoaded,
  adminInterviewsUsed,
  adminWindowLabel,
} from "@/lib/messages";

// The admin surface: grant interview access, see who has what, watch the service.
//
// Mode B by the frontend skill's routing — an app surface, where legibility of
// system state outranks distinctiveness. It is also the one screen in this app
// whose reader is not a candidate, which changes what may be said out loud: the
// CloudWatch namespace and the ingestion mechanism appear in the copy, because the
// operator is exactly who needs them when a chart is empty.
//
// **Three independent regions, three independent states.** The grant form, the
// account table and the metrics each load and fail on their own. A single page
// state would mean a CloudWatch outage hides the account table and a Cognito
// outage hides the charts — and on an admin page, the half that still works is the
// half you need during an incident.

// ---------------------------------------------------------------------------
// Grant form
// ---------------------------------------------------------------------------

// Three modes rather than a boolean and a number, matching the three states the
// stored grant actually has — ungranted, a number, unlimited. A checkbox plus a
// text field cannot express "reset to default" distinctly from "set it to 3": the
// first removes the override, the second pins a number that stops tracking the
// default if it ever changes.
type GrantMode = "default" | "limit" | "unlimited";

type GrantState =
  | { status: "idle" }
  | { status: "saving" }
  // `username`, not just the email: on a pool where a federated sign-in can mint a
  // second account on an existing address, confirming the email confirms nothing
  // about which identity was written.
  | { status: "saved"; username: string; summary: string }
  | { status: "error"; message: string }
  // Its own state rather than a plain error, because it is the one failure with a
  // concrete next action: pick one of these usernames and retry by username.
  | { status: "ambiguous"; message: string; usernames: string[] };

function GrantForm({ onSaved }: { onSaved: () => void }) {
  const [email, setEmail] = useState("");
  // Empty unless the operator is disambiguating. When set it REPLACES the email as
  // the identifier — the server accepts exactly one of the two, because accepting
  // both would mean resolving a disagreement by guessing.
  const [username, setUsername] = useState("");
  const [mode, setMode] = useState<GrantMode>("limit");
  const [limit, setLimit] = useState(String(INTERVIEW_QUOTA.DEFAULT_SESSIONS));
  const [state, setState] = useState<GrantState>({ status: "idle" });

  const submit = async (): Promise<void> => {
    setState({ status: "saving" });

    // Parsed here rather than trusted from the input's `valueAsNumber`, which is
    // NaN for an empty field and would reach the server as a missing value — i.e.
    // as "reset to default", silently doing something other than what was asked.
    const parsedLimit = Number.parseInt(limit, 10);
    if (mode === "limit" && !Number.isInteger(parsedLimit)) {
      setState({ status: "error", message: MESSAGES.ADMIN_GRANT_FAILED });
      return;
    }

    try {
      const typedUsername = username.trim();
      const result = await setUnlimitedAccess({
        // Exactly one identifier. Username wins when present, because it is only
        // ever filled in deliberately, to resolve an ambiguity the email caused.
        email: typedUsername.length > 0 ? undefined : email.trim(),
        username: typedUsername.length > 0 ? typedUsername : undefined,
        unlimitedAccess: mode === "unlimited",
        // Omitted for both other modes, which is what clears a numeric grant on
        // the server. `unlimited` carries no number on purpose: leaving a stale
        // limit behind would resurface the moment the unlimited flag was revoked.
        sessionLimit: mode === "limit" ? parsedLimit : undefined,
      });

      setState({
        status: "saved",
        username: result.username,
        // The resolved allowance, echoed back from the server rather than
        // recomputed from what was typed. If a lowered limit just made an account
        // exhausted, that is the single most important thing to show and it is not
        // derivable from the form's own inputs.
        summary: adminInterviewsUsed(
          result.allowance.used,
          result.allowance.limit,
          result.allowance.unlimited,
        ),
      });
      onSaved();
    } catch (error) {
      // The ambiguous case is lifted out of the generic error path so the
      // candidate usernames survive into the UI. Reported as a 409 with a
      // `usernames` array; anything else falls through to a plain message.
      const candidates = ambiguousUsernames(error);
      if (candidates !== null) {
        setState({
          status: "ambiguous",
          message:
            serverMessage(error) ?? MESSAGES.ADMIN_GRANT_AMBIGUOUS_FALLBACK,
          usernames: candidates,
        });
        return;
      }

      setState({
        status: "error",
        // The server's own message first. This route's failures are specific and
        // actionable for an operator — "no account with that email", "that account
        // has not onboarded" — and replacing them with generic copy would throw
        // away the only thing that says which of the two happened.
        message:
          serverMessage(error) ??
          transportMessage(error, MESSAGES.ADMIN_GRANT_FAILED),
      });
    }
  };

  const saving = state.status === "saving";

  return (
    <section className="flex flex-col gap-5 rounded-lg border border-border bg-surface-2 p-5">
      <div className="flex flex-col gap-1">
        <Eyebrow as="h2">{MESSAGES.ADMIN_GRANT_TITLE}</Eyebrow>
        <p className="text-sm leading-relaxed text-ink-subtle">
          {MESSAGES.ADMIN_GRANT_BODY}
        </p>
      </div>

      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="flex flex-col gap-2">
          <Label htmlFor="admin-email">
            {MESSAGES.ADMIN_GRANT_EMAIL_LABEL}
          </Label>
          <Input
            id="admin-email"
            // `type="email"` so a phone shows the right keyboard and the browser
            // catches an obvious malformation before a round trip. The server
            // validates properly regardless — this is convenience, not validation.
            type="email"
            // Not required once a username is being used instead: the server takes
            // exactly one identifier, and a `required` email would block the very
            // retry the ambiguity prompt is asking for.
            required={username.trim().length === 0}
            disabled={username.trim().length > 0}
            autoComplete="off"
            placeholder={MESSAGES.ADMIN_GRANT_EMAIL_PLACEHOLDER}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>

        {/* Progressive disclosure: hidden until an email turns out to name more
            than one account, because on a pool with no duplicates it is a field
            nobody ever needs and every operator would have to reason about. Once
            shown it stays, so the retry is a paste and a click. */}
        {state.status === "ambiguous" || username.trim().length > 0 ? (
          <div className="flex flex-col gap-2">
            <Label htmlFor="admin-username">
              {MESSAGES.ADMIN_GRANT_USERNAME_LABEL}
            </Label>
            <Input
              id="admin-username"
              autoComplete="off"
              placeholder={MESSAGES.ADMIN_GRANT_USERNAME_PLACEHOLDER}
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
            <p className="text-xs text-ink-faint">
              {MESSAGES.ADMIN_GRANT_USERNAME_HINT}
            </p>
          </div>
        ) : null}

        <fieldset className="flex flex-col gap-2">
          {/* A fieldset with a legend rather than a Select, because these are three
              mutually exclusive choices whose differences need explaining — a
              collapsed dropdown hides the distinction between "reset to default"
              and "set a number", which is the one an operator gets wrong. */}
          <legend className="mb-2 text-sm text-ink">
            {MESSAGES.ADMIN_GRANT_MODE_LABEL}
          </legend>

          {(
            [
              ["limit", MESSAGES.ADMIN_GRANT_MODE_LIMIT],
              ["unlimited", MESSAGES.ADMIN_GRANT_MODE_UNLIMITED],
              ["default", MESSAGES.ADMIN_GRANT_MODE_DEFAULT],
            ] as const
          ).map(([value, label]) => (
            <label
              key={value}
              className="flex cursor-pointer items-center gap-2 text-sm text-ink-subtle"
            >
              <input
                type="radio"
                name="grant-mode"
                value={value}
                checked={mode === value}
                onChange={() => setMode(value)}
                className="accent-cue"
              />
              {label}
            </label>
          ))}
        </fieldset>

        {/* Rendered only in `limit` mode rather than disabled, so there is never a
            greyed number on screen that looks like it is in effect. */}
        {mode === "limit" ? (
          <div className="flex flex-col gap-2">
            <Label htmlFor="admin-limit">
              {MESSAGES.ADMIN_GRANT_LIMIT_LABEL}
            </Label>
            <Input
              id="admin-limit"
              type="number"
              inputMode="numeric"
              min={0}
              // The server's ceiling, quoted from the shared constant rather than
              // repeated as a literal — so the browser refuses exactly what the
              // server would refuse, and raising one raises both.
              max={INTERVIEW_QUOTA.MAX_GRANTABLE_SESSIONS}
              required
              className="max-w-32 tabular-nums"
              value={limit}
              onChange={(event) => setLimit(event.target.value)}
            />
          </div>
        ) : null}

        <div className="flex items-center gap-4">
          <Button type="submit" className="cursor-pointer" disabled={saving}>
            {saving
              ? MESSAGES.ADMIN_GRANT_SUBMIT_PENDING
              : MESSAGES.ADMIN_GRANT_SUBMIT}
          </Button>

          {/* A polite live region, so the outcome is announced rather than only
              appearing. An operator who just changed someone's access needs
              confirmation of what it became, not just that something happened. */}
          <p aria-live="polite" className="text-xs text-ink-subtle">
            {state.status === "saved"
              ? `${state.username} — ${state.summary}`
              : state.status === "error" || state.status === "ambiguous"
                ? state.message
                : null}
          </p>
        </div>

        {/* The candidates, as buttons rather than text.
            Copying a `Google_103317099236673291025` by hand is exactly the step
            where an operator picks the wrong one, which is the mistake this whole
            branch exists to prevent — so the list fills the field instead. */}
        {state.status === "ambiguous" ? (
          <ul className="flex flex-col gap-1.5 rounded-lg border border-border p-3">
            {state.usernames.map((candidate) => (
              <li key={candidate}>
                <button
                  type="button"
                  className="cursor-pointer text-left font-mono text-xs text-cue-ink hover:underline"
                  onClick={() => {
                    setUsername(candidate);
                    // Back to idle so the prompt clears the moment a choice is
                    // made; leaving it up would read as the error persisting.
                    setState({ status: "idle" });
                  }}
                >
                  {candidate}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </form>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Account table
// ---------------------------------------------------------------------------

function accessLabel(row: AdminUserRow): string {
  if (row.profile === null) return "—";
  if (row.profile.unlimitedAccess) return MESSAGES.ADMIN_ACCESS_UNLIMITED;
  return row.profile.sessionLimit === undefined
    ? MESSAGES.ADMIN_ACCESS_DEFAULT
    : MESSAGES.ADMIN_ACCESS_GRANTED;
}

function interviewsLabel(row: AdminUserRow): string {
  if (row.profile === null) return "—";

  // The same resolver the server enforces with, called on the row's raw fields.
  // Not a reimplementation: a table that computed "2 of 3" independently would
  // eventually disagree with the route that refuses the third interview, and the
  // operator would be reading a number nothing acts on.
  const allowance = resolveSessionAllowance({
    unlimitedAccess: row.profile.unlimitedAccess,
    sessionLimit: row.profile.sessionLimit,
    sessionsConducted: row.profile.sessionsConducted,
  });

  return adminInterviewsUsed(
    allowance.used,
    allowance.limit,
    allowance.unlimited,
    // Sessions minted. Shown beside the quota rather than instead of it: the gap
    // is the diagnostic — someone with 1 conducted and 12 created is repeatedly
    // bouncing off the interview screen, and collapsing the two into one number
    // is exactly what hid the bug where abandoning a session spent an interview.
    row.profile.sessionsCreated,
  );
}

type UsersState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      rows: AdminUserRow[];
      cursor: string | null;
      loadingMore: boolean;
    };

function AccountTable({ reloadKey }: { reloadKey: number }) {
  const [state, setState] = useState<UsersState>({ status: "loading" });

  const load = useCallback(async (): Promise<void> => {
    setState({ status: "loading" });
    try {
      const page = await fetchAdminUsers();
      setState({
        status: "ready",
        rows: page.users,
        cursor: page.nextCursor,
        loadingMore: false,
      });
    } catch (error) {
      setState({
        status: "error",
        message: transportMessage(error, MESSAGES.ADMIN_USERS_LOAD_FAILED),
      });
    }
  }, []);

  // Reloads when the grant form saves, so a change is visible in the table
  // without a manual refresh. Keyed on a counter rather than on the saved email:
  // the page does not know which row moved, and re-fetching the first page is one
  // call against reconciling a row by hand.
  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  const loadMore = async (): Promise<void> => {
    if (state.status !== "ready" || state.cursor === null) return;

    const cursor = state.cursor;
    setState({ ...state, loadingMore: true });

    try {
      const page = await fetchAdminUsers(cursor);
      setState({
        status: "ready",
        // Appended, because this is server-side cursor pagination against
        // Cognito — the frontend skill is explicit that pages come from the
        // cursor rather than from fetching everything and slicing.
        rows: [...state.rows, ...page.users],
        cursor: page.nextCursor,
        loadingMore: false,
      });
    } catch (error) {
      // The rows already on screen are kept. Replacing a loaded table with an
      // error because page two failed throws away data that is still correct.
      setState({
        status: "error",
        message: transportMessage(error, MESSAGES.ADMIN_USERS_LOAD_FAILED),
      });
    }
  };

  if (state.status === "loading") {
    return (
      <div className="flex min-h-[120px] items-center justify-center rounded-lg border border-border">
        <p className="text-sm text-ink-subtle">{MESSAGES.LOADING}</p>
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="flex min-h-[120px] flex-col items-center justify-center gap-3 rounded-lg border border-border p-5 text-center">
        <AlertTriangleIcon aria-hidden className="size-4 text-ink-subtle" />
        <p className="text-sm text-ink-subtle">{state.message}</p>
        <Button
          variant="outline"
          size="sm"
          className="cursor-pointer"
          onClick={() => void load()}
        >
          <RefreshCwIcon aria-hidden className="size-3.5" />
          {MESSAGES.RETRY}
        </Button>
      </div>
    );
  }

  if (state.rows.length === 0) {
    return (
      <div className="flex min-h-[120px] items-center justify-center rounded-lg border border-border">
        <p className="text-sm text-ink-subtle">{MESSAGES.ADMIN_USERS_EMPTY}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* A real table, not a grid of divs. This is tabular data with headers, and
          the semantics are what let a screen reader announce "Access, column 5"
          while navigating cells. `overflow-x-auto` because five columns do not fit
          at 375px and the page itself must never scroll sideways. */}
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[34rem] border-collapse text-sm">
          <thead>
            <tr className="border-b border-border bg-surface-2 text-left">
              {[
                MESSAGES.ADMIN_COL_EMAIL,
                MESSAGES.ADMIN_COL_STATUS,
                MESSAGES.ADMIN_COL_ONBOARDED,
                MESSAGES.ADMIN_COL_INTERVIEWS,
                MESSAGES.ADMIN_COL_ACCESS,
              ].map((heading) => (
                <th key={heading} scope="col" className="px-4 py-2.5">
                  <Eyebrow size="sm">{heading}</Eyebrow>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {state.rows.map((row) => (
              <tr
                key={row.userId}
                className="border-b border-border last:border-0"
              >
                <th
                  scope="row"
                  className="px-4 py-3 text-left font-normal text-ink"
                >
                  {row.email}
                </th>
                <td className="px-4 py-3 text-ink-subtle">
                  {/* Cognito's own lifecycle word, plus a disabled marker. Both,
                      because a CONFIRMED account can still be disabled and
                      showing only one of the two would read as healthy. */}
                  {row.enabled ? row.status : MESSAGES.ADMIN_DISABLED}
                </td>
                <td className="px-4 py-3 text-ink-subtle">
                  {row.profile === null || !row.profile.complete
                    ? MESSAGES.ADMIN_ONBOARDED_NO
                    : MESSAGES.ADMIN_ONBOARDED_YES}
                </td>
                {/* Tabular numerals, so a column of counts does not shimmer as
                    it updates and stays aligned down the list. */}
                <td className="px-4 py-3 font-mono tabular-nums text-ink">
                  {interviewsLabel(row)}
                </td>
                <td className="px-4 py-3 text-ink-subtle">
                  {accessLabel(row)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between gap-4">
        <p className="font-mono text-xs text-ink-faint">
          {adminAccountsLoaded(state.rows.length)}
        </p>
        {state.cursor !== null ? (
          <Button
            variant="outline"
            size="sm"
            className="cursor-pointer"
            disabled={state.loadingMore}
            onClick={() => void loadMore()}
          >
            {state.loadingMore
              ? MESSAGES.ADMIN_USERS_MORE_PENDING
              : MESSAGES.ADMIN_USERS_MORE}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

type MetricsState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: AdminMetricsResponse };

function ServiceHealth() {
  const [hours, setHours] = useState<MetricsWindowHours>(
    METRICS_WINDOW.DEFAULT_HOURS,
  );
  const [state, setState] = useState<MetricsState>({ status: "loading" });

  const load = useCallback(
    async (window: MetricsWindowHours): Promise<void> => {
      setState({ status: "loading" });
      try {
        setState({ status: "ready", data: await fetchAdminMetrics(window) });
      } catch (error) {
        setState({
          status: "error",
          message: transportMessage(error, MESSAGES.ADMIN_METRICS_LOAD_FAILED),
        });
      }
    },
    [],
  );

  // Loads on mount and on a window change, and NOTHING ELSE.
  //
  // Deliberately no polling. GetMetricData bills per metric-datapoint returned and
  // this page asks for a dozen-plus series at once, so a dashboard left open in a
  // background tab with a 5-second interval is a standing charge for a chart nobody
  // is reading. The refresh is a button, which is also the honest interaction: the
  // periods here are 1 to 60 minutes, so a 5-second poll would redraw the same
  // points hundreds of times.
  useEffect(() => {
    void load(hours);
  }, [load, hours]);

  return (
    <section className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Eyebrow as="h2">{MESSAGES.ADMIN_METRICS_TITLE}</Eyebrow>

        <div className="flex items-center gap-1.5">
          {METRICS_WINDOW.HOURS.map((option) => (
            <Button
              key={option}
              variant={option === hours ? "default" : "outline"}
              size="sm"
              className="cursor-pointer"
              aria-pressed={option === hours}
              onClick={() => setHours(option)}
            >
              {adminWindowLabel(option)}
            </Button>
          ))}
          <Button
            variant="outline"
            size="sm"
            className="cursor-pointer"
            aria-label={MESSAGES.RETRY}
            onClick={() => void load(hours)}
          >
            <RefreshCwIcon aria-hidden className="size-3.5" />
          </Button>
        </div>
      </div>

      {state.status === "loading" ? (
        <div className="flex min-h-[160px] items-center justify-center rounded-lg border border-border">
          <p className="text-sm text-ink-subtle">{MESSAGES.LOADING}</p>
        </div>
      ) : state.status === "error" ? (
        <div className="flex min-h-[160px] flex-col items-center justify-center gap-3 rounded-lg border border-border p-5 text-center">
          <AlertTriangleIcon aria-hidden className="size-4 text-ink-subtle" />
          <p className="text-sm text-ink-subtle">{state.message}</p>
          <Button
            variant="outline"
            size="sm"
            className="cursor-pointer"
            onClick={() => void load(hours)}
          >
            <RefreshCwIcon aria-hidden className="size-3.5" />
            {MESSAGES.RETRY}
          </Button>
        </div>
      ) : state.data.noData ? (
        // Every series empty. Its own screen rather than a grid of empty charts,
        // and worded as the mechanism rather than as an absence: the cause is that
        // nothing ingests the emitted log lines yet, and a bare "no data" would
        // send an operator debugging an emitter that is working correctly.
        <div className="flex flex-col items-center gap-3 rounded-lg border border-border bg-surface-2 p-8 text-center">
          <ChartLineIcon aria-hidden className="size-5 text-ink-faint" />
          <h3 className="font-display text-xl text-ink">
            {MESSAGES.ADMIN_METRICS_NO_DATA_TITLE}
          </h3>
          <p className="max-w-lg text-sm leading-relaxed text-ink-subtle">
            {MESSAGES.ADMIN_METRICS_NO_DATA_BODY}
          </p>
          {/* The namespace, because when a chart is unexpectedly empty the usual
              cause is that the emitter and the reader disagree about it — and this
              is the one place an operator can see which one is being queried. */}
          <p className="font-mono text-xs text-ink-faint">
            {state.data.namespace}
          </p>
        </div>
      ) : (
        <div className="grid gap-6 sm:grid-cols-2">
          {state.data.series.map((series) => (
            <MetricChart key={series.id} series={series} />
          ))}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------

export function Admin() {
  // Bumped when a grant saves, which re-fetches the account table's first page.
  const [savedAt, setSavedAt] = useState(0);

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-10 p-6 pb-16">
      <header className="flex flex-col gap-2">
        <Eyebrow>{MESSAGES.ADMIN_TITLE}</Eyebrow>
        <h1 className="font-display text-4xl leading-[1.1] text-ink sm:text-5xl">
          {MESSAGES.ADMIN_SUBTITLE}
        </h1>
      </header>

      <GrantForm onSaved={() => setSavedAt((value) => value + 1)} />

      <section className="flex flex-col gap-4">
        <Eyebrow as="h2">{MESSAGES.ADMIN_USERS_TITLE}</Eyebrow>
        <AccountTable reloadKey={savedAt} />
      </section>

      <ServiceHealth />
    </div>
  );
}

// The client-side admin gate.
//
// **Not a security control.** The server's RequireAdmin middleware is, and it
// returns 404 to anyone outside the group — every call this page makes is refused
// without it, regardless of what the browser believes. This exists for two
// rendering reasons only: so a non-admin who reaches the URL gets an explanation
// instead of three failed requests, and so the explanation can name the one cause
// the server's deliberate 404 will never reveal — that group membership is stamped
// on the access token at sign-in, so a newly added admin has to sign in again.
export function RequireAdminPage() {
  const allowed = useIsAdmin();

  if (allowed === null) {
    return (
      <div className="flex min-h-full w-full flex-col items-center justify-center gap-5 py-20">
        <PresenceOrb
          hue="var(--cue)"
          className="size-12 animate-pulse motion-reduce:animate-none"
        />
        <p className="text-sm text-ink-subtle">{MESSAGES.LOADING}</p>
      </div>
    );
  }

  if (!allowed) {
    return (
      <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col items-center justify-center gap-5 p-6 text-center">
        <ShieldIcon aria-hidden className="size-5 text-ink-subtle" />
        <h1 className="font-display text-3xl text-ink">
          {MESSAGES.ADMIN_DENIED_TITLE}
        </h1>
        <p className="max-w-md text-sm leading-relaxed text-ink-subtle">
          {MESSAGES.ADMIN_DENIED_BODY}
        </p>
      </div>
    );
  }

  return <Admin />;
}
