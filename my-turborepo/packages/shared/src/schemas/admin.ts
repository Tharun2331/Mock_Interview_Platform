import z from "zod";

// The admin surface: the interview quota, the grant that lifts it, and the wire
// shapes for the three /api/v1/admin routes.
//
// Everything here is operator-facing rather than candidate-facing, which changes
// one habit: these responses may name a real email address and a real Cognito
// subject, because the only caller is someone already trusted with the Cognito
// console. Every other view schema in this package exists to strip identifiers;
// this one deliberately carries them, and that is why it is a separate file
// rather than an extension of profile.ts.

// ---------------------------------------------------------------------------
// The quota
// ---------------------------------------------------------------------------

export const INTERVIEW_QUOTA = {
  // What a new account gets without anyone granting anything. Each session is a
  // live Nova 2 Sonic stream billed by open duration plus one Evaluator call per
  // answer, so this number is a spend control first and a product decision
  // second — it is the only thing standing between one sign-up and an unbounded
  // bill.
  DEFAULT_SESSIONS: 3,
  // Ceiling on what a single grant may set. Not a business rule — it is a
  // fat-finger guard. An admin typing 10000 where they meant 10 should be
  // refused by validation rather than discovered on a bill, and nobody has a
  // real reason to grant a four-figure session count when `unlimited` exists
  // and says what it means.
  MAX_GRANTABLE_SESSIONS: 100,
} as const;

// What an admin is allowed to write onto an account.
//
// Two fields rather than one, and the redundancy is deliberate. A single
// `sessionLimit: number | null` with null meaning unlimited would be tighter,
// but "unlimited" then has to be spelled as an absence, and absence already
// means "no grant, use the default" on the stored item. Three states —
// ungranted, granted a number, granted unlimited — need two fields to stay
// distinguishable, and `resolveSessionAllowance` is the one place that collapses
// them.
export const AccessGrantSchema = z.object({
  // Bypasses the cap entirely. Separate from a very large `sessionLimit` because
  // it means something different operationally: a number is a budget an admin
  // expects to be consumed and asked about again, unlimited is a decision not to
  // count. The admin table shows them differently for that reason.
  unlimitedAccess: z.boolean(),
  // Replaces INTERVIEW_QUOTA.DEFAULT_SESSIONS for this account. Absent means no
  // override has been granted, NOT a limit of zero — see the note on the two
  // fields above. Zero is a legal grant and means "this account may start no
  // interviews", which is the only way to suspend someone without deleting them.
  sessionLimit: z
    .number()
    .int()
    .min(0)
    .max(INTERVIEW_QUOTA.MAX_GRANTABLE_SESSIONS)
    .optional(),
});

export type AccessGrant = z.infer<typeof AccessGrantSchema>;

// The resolved answer to "may this account start another interview".
//
// `remaining` is null rather than Infinity for an unlimited account. Infinity
// survives neither JSON nor DynamoDB — it serialises to null and re-reads as a
// parse failure — so a type that cannot represent it is better than one that
// represents it once and loses it on the way out.
export type SessionAllowance = {
  unlimited: boolean;
  // The cap that applies, whether granted or defaulted. Still populated when
  // `unlimited` is true, because the admin table shows what the cap WOULD be if
  // the grant were revoked, and recomputing that in the UI would be a second
  // implementation of this function.
  limit: number;
  used: number;
  remaining: number | null;
  // The single boolean the enforcement point reads. Derived here so the route
  // that refuses an interview and the table that displays the quota cannot
  // disagree about who is out of sessions — the failure that would produce is a
  // candidate shown "2 remaining" being refused, which reads as a broken product
  // rather than as a quota.
  exhausted: boolean;
};

// The one place the three grant states collapse into a decision.
//
// Pure, and takes the stored fields rather than a profile, so the enforcement
// point, the admin table and the tests all call the same function with no
// DynamoDB and no mocks.
//
// `sessionsConducted` is a monotonic counter on the profile item — NOT a count of
// SESSION# rows, which carry a TTL and would let the quota silently reset as a
// candidate's history aged out. It counts interviews actually CONDUCTED, claimed
// atomically when the Sonic stream opens (and refunded if the interview ends at
// once with nothing scoreable); sessions merely minted are counted separately by
// `sessionsCreated` and meter nothing.
//
// Mostly "monotonic": the one decrement is that refund, which can only undo a
// claim this same connection made.
export function resolveSessionAllowance(args: {
  unlimitedAccess: boolean;
  sessionLimit: number | undefined;
  sessionsConducted: number;
}): SessionAllowance {
  const limit = args.sessionLimit ?? INTERVIEW_QUOTA.DEFAULT_SESSIONS;
  const used = args.sessionsConducted;

  if (args.unlimitedAccess) {
    return { unlimited: true, limit, used, remaining: null, exhausted: false };
  }

  // Clamped at zero. A grant lowered below what someone has already used —
  // 3 sessions started, limit revised to 1 — is a real sequence, and a negative
  // "remaining" would render as "-2 left" in the admin table and could sign-flip
  // any arithmetic downstream. Exhausted is the honest reading of that state.
  const remaining = Math.max(0, limit - used);

  return {
    unlimited: false,
    limit,
    used,
    remaining,
    exhausted: remaining === 0,
  };
}

// ---------------------------------------------------------------------------
// POST /api/v1/admin/unlimited-access
// ---------------------------------------------------------------------------

// Keyed on email, not on the Cognito subject.
//
// The subject is what every DynamoDB item uses and what the route resolves to
// internally, but it is an opaque UUID an operator has no way to obtain except by
// looking it up — so a form that asked for one would send them to the console
// first, which is the manual step this route exists to remove.
//
// Lowercased and trimmed before validation. Cognito's ListUsers filter is an
// exact string comparison, so " Foo@Example.com " and "foo@example.com" would
// otherwise be two different lookups for one account.
// **Email is NOT unique in a Cognito pool with a federated IdP.** Signing in with
// Google creates a separate user carrying the same email as an existing native
// account, and a real pool here has exactly that: two users on one address, one
// native and one `Google_...`. So an email does not always name one account, and a
// grant resolved from an ambiguous one lands on whichever Cognito happened to
// return first — silently, on a stranger's quota.
//
// Hence two ways in, exactly one per request:
//
//   email    — the normal path, and what an operator has.
//   username — the disambiguator, used when an email matches more than one
//              identity. It is what the accounts table already shows per row, and
//              what every Cognito Admin* API takes.
export const AdminAccessBody = z
  .object({
    // Lowercased and trimmed before validation. Cognito's ListUsers filter is an
    // exact string comparison, so " Foo@Example.com " and "foo@example.com" would
    // otherwise be two different lookups for one account.
    email: z
      .string()
      .trim()
      .toLowerCase()
      .pipe(z.email("Enter a valid email address."))
      .optional(),
    // NOT lowercased. Cognito usernames are case-sensitive and the federated form
    // is `Google_1033...` with a capital G — folding it breaks the lookup.
    username: z.string().trim().min(1).max(128).optional(),
  })
  .extend(AccessGrantSchema.shape)
  .refine(
    (body) => (body.email === undefined) !== (body.username === undefined),
    {
      // Both is as wrong as neither: if they disagree, the route would have to
      // pick one, and picking silently is the entire bug this exists to close.
      message: "Provide exactly one of email or username.",
      path: ["email"],
    },
  );

export type AdminAccessBody = z.infer<typeof AdminAccessBody>;

// ---------------------------------------------------------------------------
// GET /api/v1/admin/users
// ---------------------------------------------------------------------------

// One row of the admin table. A join of two sources, and which field comes from
// where matters when one of them is missing:
//
//   Cognito   — email, enabled, status, createdAt. Always present: the account
//               exists in the directory or it is not in this list at all.
//   DynamoDB  — everything under `profile`. Null for someone who signed up and
//               never onboarded, which is a real and common state.
export const AdminUserRowSchema = z.object({
  userId: z.string().min(1),
  email: z.string().min(1),
  // The Cognito username, carried because it is what AdminDeleteUser and
  // admin-add-user-to-group take — federated users have usernames like
  // `google_10937...` that are not the subject. Shown nowhere; it is here so an
  // operator copying a value out of this table copies one that works.
  username: z.string().min(1),
  enabled: z.boolean(),
  // Cognito's own lifecycle state (CONFIRMED, UNCONFIRMED, ...). Free text
  // rather than an enum: it is AWS's vocabulary, and a new value appearing would
  // fail validation on a row this table only displays.
  status: z.string().min(1),
  createdAt: z.iso.datetime(),
  profile: z
    .object({
      complete: z.boolean(),
      firstName: z.string().optional(),
      lastName: z.string().optional(),
      // Defaulted, matching the stored item and its projection.
      //
      // The server always sends these — it builds the row from an already-defaulted
      // projection — so this is not about the current server. It is about the
      // CLIENT parsing a response from an older one: the browser is a separately
      // deployed artifact, and a cached bundle validating a payload that predates
      // the quota would fail the whole page rather than the one field. Every other
      // view schema in this package defaults for the same reason.
      sessionsConducted: z.number().int().min(0).default(0),
      // Sessions minted. Shown beside `sessionsConducted` rather than instead of
      // it: the gap between the two is the diagnostic — repeated mints with no
      // conducted interview is someone bouncing off the interview screen.
      sessionsCreated: z.number().int().min(0).default(0),
      unlimitedAccess: z.boolean().default(false),
      sessionLimit: z.number().int().min(0).optional(),
    })
    .nullable(),
});

export type AdminUserRow = z.infer<typeof AdminUserRowSchema>;

export const AdminUsersResponseSchema = z.object({
  users: z.array(AdminUserRowSchema),
  // Cognito's own pagination token, passed straight back. Opaque on purpose —
  // the client must not construct or decode one, only echo it.
  nextCursor: z.string().nullable(),
});

export type AdminUsersResponse = z.infer<typeof AdminUsersResponseSchema>;

export const AdminUsersQuery = z.object({
  cursor: z.string().min(1).optional(),
});

export type AdminUsersQuery = z.infer<typeof AdminUsersQuery>;

// The grant response. Returns the resolved allowance rather than an
// acknowledgement, so the admin table can update the row from the reply instead
// of refetching the whole page — and so the operator sees the effect of what
// they wrote, including the case where a lowered limit made an account exhausted.
export const AdminAccessResponseSchema = z.object({
  userId: z.string().min(1),
  email: z.string().min(1),
  // Which identity was actually written to. On a pool where a federated sign-in
  // can create a second account on an existing email, echoing the email back
  // confirms nothing — the username is the only part of the reply that says the
  // grant landed where the operator aimed it.
  username: z.string().min(1),
  allowance: z.object({
    unlimited: z.boolean(),
    limit: z.number().int().min(0),
    used: z.number().int().min(0),
    remaining: z.number().int().min(0).nullable(),
    exhausted: z.boolean(),
  }),
});

export type AdminAccessResponse = z.infer<typeof AdminAccessResponseSchema>;

// ---------------------------------------------------------------------------
// GET /api/v1/admin/metrics
// ---------------------------------------------------------------------------

export const METRICS_WINDOW = {
  // Windows the dashboard offers, in hours. Not free-form, and that is a cost
  // decision: GetMetricData bills per metric-datapoint returned, so an
  // unconstrained `?hours=` would let one request ask for a year of one-minute
  // periods. Three fixed choices keep the shape of every query known.
  HOURS: [1, 24, 168] as const,
  DEFAULT_HOURS: 24,
  // Aggregation period per window, chosen so every one returns a similar number
  // of points — roughly 60 to 170 — rather than a similar resolution. A 7-day
  // window at 5-minute periods is 2,016 points per series across nine series,
  // which is a slow chart and a bill for no extra insight.
  //
  // Sub-60-second periods are also not free in CloudWatch: high-resolution
  // metrics cost more to store and to query. Nothing here asks for one.
  PERIOD_SECONDS: {
    1: 60,
    24: 300,
    168: 3600,
  } as const,
} as const;

export type MetricsWindowHours = (typeof METRICS_WINDOW.HOURS)[number];

export const AdminMetricsQuery = z.object({
  // Coerced because it arrives as a query string, then piped into a literal union.
  //
  // `z.literal([...])` rather than `.refine()`, deliberately. A refinement
  // validates at runtime but leaves the inferred type as plain `number`, so the
  // period lookup downstream would need an `as` cast to index
  // `PERIOD_SECONDS` — which CLAUDE.md forbids outside a proven narrowing, and
  // which would be exactly the kind of cast that keeps compiling after someone
  // adds a window to HOURS and forgets its period. The literal union makes that
  // omission a type error at the lookup instead.
  hours: z.coerce
    .number()
    .int()
    .pipe(z.literal(METRICS_WINDOW.HOURS))
    .optional(),
});

export type AdminMetricsQuery = z.infer<typeof AdminMetricsQuery>;

// One time series. Timestamps and values are parallel arrays rather than an array
// of pairs, because that is the shape GetMetricData returns and the shape every
// charting library wants — converting to objects and back would be two
// allocations per point for no gain in clarity.
export const MetricSeriesSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  unit: z.enum(["Milliseconds", "Count", "None"]),
  timestamps: z.array(z.iso.datetime()),
  values: z.array(z.number()),
  // True when CloudWatch returned no data at all for the window.
  //
  // Reported explicitly rather than left as an empty array, because "no data" and
  // "zero" mean different things here and the dashboard must not draw a flat line
  // through the first. Until the `ecs` module exists there is no log group for EMF
  // to land in, so EVERY series is empty — this flag is what lets the page say
  // "not ingesting yet" instead of "your service handled no requests".
  empty: z.boolean(),
});

export type MetricSeries = z.infer<typeof MetricSeriesSchema>;

export const AdminMetricsResponseSchema = z.object({
  windowHours: z.number().int().positive(),
  periodSeconds: z.number().int().positive(),
  namespace: z.string().min(1),
  series: z.array(MetricSeriesSchema),
  // True when every series came back empty. Hoisted so the page can render one
  // explanation instead of nine empty charts.
  noData: z.boolean(),
});

export type AdminMetricsResponse = z.infer<typeof AdminMetricsResponseSchema>;
