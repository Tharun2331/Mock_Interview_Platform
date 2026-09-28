import type { NextFunction, Request, RequestHandler, Response } from "express";
import { config } from "./config";
import { METRICS } from "./constants";

// Custom metrics, emitted as CloudWatch Embedded Metric Format on stdout.
//
// **Why EMF and not PutMetricData.** PutMetricData is a synchronous AWS API call.
// Putting one in the request path buys an extra network round trip per request, or
// an in-process buffer and a flush timer to avoid it — and either way it needs
// IAM, it can fail, and it can throttle. EMF is a structured line on stdout that
// the CloudWatch Logs agent already ships: no API call, no added latency, no
// retry logic, and the only permission involved is the log-writing one an ECS task
// has regardless.
//
// **The consequence, stated plainly: this emits nothing usable until the service
// runs somewhere with a CloudWatch log group.** Metric extraction happens
// log-side, so on a laptop these lines are just JSON on the terminal. There is no
// `ecs` module yet, so until Phase 7 lands one, `GET /api/v1/admin/metrics` reads
// back empty series — correctly, because nothing has been ingested. That is a
// known gap in this build rather than a bug to hunt: the emitter is right, the
// pipe does not exist yet.
//
// Nothing here may throw. A metrics failure must not fail a request — the whole
// point of instrumentation is that it is invisible when it breaks — so every
// public function in this module is wrapped and swallows its own errors.

type MetricUnit = "Milliseconds" | "Count" | "None";

type MetricDatum = {
  name: string;
  value: number;
  unit: MetricUnit;
};

// EMF's wire shape. Written out as a type rather than assembled loosely so the
// field names — which are AWS's, capitalised and exact — cannot drift into
// something CloudWatch ignores without complaint. A malformed `_aws` block does
// not error: the line is stored as a plain log event and the metrics silently
// never appear.
type EmfEvent = {
  _aws: {
    Timestamp: number;
    CloudWatchMetrics: [
      {
        Namespace: string;
        Dimensions: string[][];
        Metrics: { Name: string; Unit: MetricUnit }[];
      },
    ];
  };
} & Record<string, unknown>;

// Trimmed to EMF's limit rather than dropped.
//
// An over-long dimension value invalidates the entire event, taking the metrics
// with it. Truncating loses the tail of one route template; refusing loses the
// measurement. Route templates are short by construction, so this is a guard
// against a future surprise rather than a live concern.
function dimensionValue(raw: string): string {
  return raw.length > METRICS.MAX_DIMENSION_VALUE_CHARS
    ? raw.slice(0, METRICS.MAX_DIMENSION_VALUE_CHARS)
    : raw;
}

// Builds one EMF event. Pure, and exported for exactly that reason.
//
// Separated from the write so the wire shape can be tested without capturing
// stdout and without `config.metricsEnabled` being true — config is read at module
// scope in this codebase, so a test cannot flip it, and a test that asserted on
// console output would be asserting on the one thing the suite deliberately
// silences.
//
// `dimensionSets` names which COMBINATIONS become series. Passing
// `[["Environment"], ["Environment", "Route"]]` produces both the aggregate and
// the per-route breakdown from a single event and a single set of values — which
// is the whole reason to do it in one event rather than two: the aggregate is
// derived by CloudWatch rather than computed twice and allowed to disagree.
export function buildMetricEvent(args: {
  metrics: MetricDatum[];
  dimensions: Record<string, string>;
  dimensionSets: string[][];
  namespace: string;
  timestamp: number;
}): EmfEvent {
  const event: EmfEvent = {
    _aws: {
      Timestamp: args.timestamp,
      CloudWatchMetrics: [
        {
          Namespace: args.namespace,
          Dimensions: args.dimensionSets,
          Metrics: args.metrics.map((metric) => ({
            Name: metric.name,
            Unit: metric.unit,
          })),
        },
      ],
    },
  };

  for (const [name, value] of Object.entries(args.dimensions)) {
    event[name] = dimensionValue(value);
  }
  for (const metric of args.metrics) {
    event[metric.name] = metric.value;
  }

  return event;
}

function emit(args: {
  metrics: MetricDatum[];
  dimensions: Record<string, string>;
  dimensionSets: string[][];
}): void {
  if (!config.metricsEnabled) return;
  if (args.metrics.length === 0) return;

  if (args.metrics.length > METRICS.MAX_METRICS_PER_EVENT) {
    // Refused rather than truncated. Over the limit CloudWatch drops the whole
    // event, so silently sending the first hundred would report a subset as if it
    // were everything. Unreachable today — nothing emits more than five — and it
    // is here because the failure is invisible.
    console.warn(
      `[metrics] refusing an event with ${args.metrics.length} metrics; ` +
        `the EMF limit is ${METRICS.MAX_METRICS_PER_EVENT}`,
    );
    return;
  }

  const event = buildMetricEvent({
    ...args,
    namespace: config.metricsNamespace,
    timestamp: Date.now(),
  });

  // One JSON object per line, which is what the log agent parses. `console.log`
  // rather than `process.stdout.write` so it goes through the same stream every
  // other log line in this service uses — including the human-readable ones,
  // which CloudWatch simply does not extract metrics from.
  console.log(JSON.stringify(event));
}

// The public wrapper. Every caller goes through this, so a bug in the emitter
// cannot take down a request or an interview.
function safeEmit(args: {
  metrics: MetricDatum[];
  dimensions: Record<string, string>;
  dimensionSets: string[][];
}): void {
  try {
    emit(args);
  } catch (error) {
    // Deliberately not rethrown and deliberately not silent. An instrumentation
    // failure that nobody can see is how a dashboard goes quietly blank.
    console.warn(
      `[metrics] emit failed — ${error instanceof Error ? error.message : error}`,
    );
  }
}

const environmentOnly = (): Record<string, string> => ({
  [METRICS.DIMENSION_ENVIRONMENT]: config.appEnvironment,
});

const ENVIRONMENT_SET: string[][] = [[METRICS.DIMENSION_ENVIRONMENT]];

const ROUTE_SETS: string[][] = [
  [METRICS.DIMENSION_ENVIRONMENT],
  [METRICS.DIMENSION_ENVIRONMENT, METRICS.DIMENSION_ROUTE],
];

// The route TEMPLATE, never the requested path.
//
// `req.route` is populated by Express only after routing, which is why this is
// read in the response handler rather than when the middleware runs. `req.baseUrl`
// carries the mount prefix (`/api/v1/sessions`) and `req.route.path` the
// router-relative pattern (`/:sessionId/evaluation`), so joining them gives the
// template a dashboard can group by.
//
// **A request that never reached a handler still gets attributed, by mount
// prefix — and this is the one part of this function that was got wrong first
// time.** The original version returned UNMATCHED_ROUTE whenever `req.route` was
// absent. Running the service showed what that costs: `AuthMiddleware` refuses
// before routing completes, so `req.route` is never set on ANY 401 — and every
// auth failure, on every route, collapsed into the same bucket as a genuine 404.
// The refusals most worth watching per-route were the ones with no route.
//
// `req.baseUrl` fixes it and is still bounded, which is the whole question here.
// It is NOT the caller's path: Express sets it only to a mount path that actually
// matched, so its range is the fixed set of prefixes in index.ts plus "". A
// request to `/<garbage>` yields "", which is what UNMATCHED_ROUTE covers. So the
// cardinality stays a fixed handful either way.
//
// Suffixed with `/*` so the two cases stay distinguishable. Without it
// `/api/v1/plan` would mean both "the plan endpoint" and "something under
// /api/v1/plan that was refused before routing", which is a graph that quietly
// averages a 401 rate into a latency figure.
//
// Exported so the bucketing has a direct test. It is the one thing in this module
// whose failure is a BILL rather than a missing graph — an unbounded route
// dimension mints a billed metric per unique URL, reachable by anyone, with no
// rate limiter in front of it because an unmatched path never reaches a mounted
// router. The tests pin it directly rather than through the emitter, which the
// suite deliberately switches off.
export function routeTemplate(req: Request): string {
  // `req.baseUrl` is typed `string` by @types/express and is **undefined at
  // runtime** when no mount matched — which is every genuine 404.
  //
  // Found by running the service, not by the type checker, and it was not a
  // cosmetic bug: reading `.length` off it threw inside the `res.on("finish")`
  // handler, which is an EventEmitter callback rather than a request context, so
  // the exception escaped as an unhandled error and took the process down on any
  // 404. A `typeof` check rather than `?? ""` so the guard states what is actually
  // being defended against, since the type says this cannot happen.
  const base = typeof req.baseUrl === "string" ? req.baseUrl : "";
  const pattern = req.route?.path;

  if (typeof pattern !== "string") {
    // Nothing matched at all: no prefix, no route. The caller's path is not used.
    return base.length === 0 ? METRICS.UNMATCHED_ROUTE : `${base}/*`;
  }

  // A router mounted at a prefix reports "/" for its own root, which would render
  // as "/api/v1/plan/" — harmless but it splits one endpoint across two series if
  // anything ever reports it without the slash.
  const joined = pattern === "/" ? base : `${base}${pattern}`;
  return joined.length === 0 ? METRICS.UNMATCHED_ROUTE : joined;
}

// Per-request latency, count and error class.
//
// Mounted FIRST in index.ts, before helmet and before auth, so the timer covers
// the whole request including work done by middleware — a slow JSON parse or a
// throttled request is exactly the latency worth seeing, and a timer started after
// the chain would hide it. It also means refused requests are counted, which is
// the point: a spike of 429s is a signal, and one measured only on requests that
// got through is not.
//
// Hooks `res.on("finish")` rather than wrapping `res.end`. Finish fires once the
// response has been handed to the OS, which is the honest end of the request, and
// it does not fire for an aborted connection — so a client that hangs up mid-
// download is not recorded as a fast success.
export const metricsMiddleware: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  const startedAt = performance.now();

  // The WHOLE handler is wrapped, not just the emit inside it.
  //
  // `safeEmit` already swallows its own failures, and that was not enough: this
  // callback also builds the dimensions, and `routeTemplate` threw there while
  // computing one. A `finish` listener is an EventEmitter callback, not a request
  // context — Express's error middleware cannot see it — so the exception escaped
  // as an unhandled error and killed the process on every 404. The instrumentation
  // took down the service it was measuring.
  //
  // So the boundary belongs here, around everything that runs per response. The
  // rule this module opens with — nothing here may throw — has to hold at the
  // outermost point where this module regains control, not at a convenient inner
  // one.
  res.on("finish", () => {
    try {
      const latency = performance.now() - startedAt;
      const status = res.statusCode;

      // Always emitted, both classes, including as zero.
      //
      // A metric that is only written when it is non-zero has no zero data points,
      // and CloudWatch cannot distinguish "no errors" from "no data" — so an alarm
      // on it sits in INSUFFICIENT_DATA during healthy traffic and a graph shows
      // gaps where the good news was. Writing 0 costs nothing extra: the metric
      // already exists for this dimension set either way.
      safeEmit({
        metrics: [
          { name: METRICS.REQUEST_COUNT, value: 1, unit: "Count" },
          {
            name: METRICS.REQUEST_LATENCY,
            value: latency,
            unit: "Milliseconds",
          },
          {
            name: METRICS.REQUEST_4XX,
            value: status >= 400 && status < 500 ? 1 : 0,
            unit: "Count",
          },
          {
            name: METRICS.REQUEST_5XX,
            value: status >= 500 ? 1 : 0,
            unit: "Count",
          },
        ],
        dimensions: {
          ...environmentOnly(),
          [METRICS.DIMENSION_ROUTE]: routeTemplate(req),
        },
        dimensionSets: ROUTE_SETS,
      });
    } catch (error) {
      console.warn(
        `[metrics] request metric failed — ${
          error instanceof Error ? error.message : error
        }`,
      );
    }
  });

  next();
};

// One completed Sonic stream.
//
// Called on stream close rather than per turn, because the billable unit is the
// stream's open duration and a per-turn emission would report it many times over.
// Token counts are cumulative for the stream for the same reason.
//
// `durationMs` is the cost number on this whole service. Nova 2 Sonic bills for as
// long as the stream is open whether or not anyone is speaking, so a leaked stream
// shows up here and nowhere else — CLAUDE.md's "treat a leaked stream like a
// leaked NAT Gateway" is what this metric exists to make visible, and it is what
// the Terraform alarm watches.
export function recordSonicStream(args: {
  // Time from opening the request to the first usable event. The latency a
  // candidate experiences as silence after they finish speaking.
  openLatencyMs: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  // Renewals are counted because a long interview legitimately has several and a
  // short one having several is a fault. Without the count, a renewal storm looks
  // like a long interview in every other metric here.
  renewals: number;
}): void {
  safeEmit({
    metrics: [
      {
        name: METRICS.SONIC_STREAM_LATENCY,
        value: args.openLatencyMs,
        unit: "Milliseconds",
      },
      {
        name: METRICS.SONIC_STREAM_DURATION,
        value: args.durationMs,
        unit: "Milliseconds",
      },
      {
        name: METRICS.SONIC_INPUT_TOKENS,
        value: args.inputTokens,
        unit: "Count",
      },
      {
        name: METRICS.SONIC_OUTPUT_TOKENS,
        value: args.outputTokens,
        unit: "Count",
      },
      {
        name: METRICS.SONIC_STREAM_RENEWALS,
        value: args.renewals,
        unit: "Count",
      },
    ],
    dimensions: environmentOnly(),
    dimensionSets: ENVIRONMENT_SET,
  });
}

// A Sonic stream that failed rather than finished.
//
// Its own metric rather than a dimension on the one above, so an alarm can watch
// it without also matching healthy streams — and so a failure that produced no
// duration and no tokens is not averaged into the numbers that describe working
// interviews.
export function recordSonicError(): void {
  safeEmit({
    metrics: [{ name: METRICS.SONIC_STREAM_ERRORS, value: 1, unit: "Count" }],
    dimensions: environmentOnly(),
    dimensionSets: ENVIRONMENT_SET,
  });
}

// Interview session counts, emitted at the quota decision in
// routes/preInterview.ts.
//
// Both outcomes, because the pair is the interesting number: refusals climbing
// while starts stay flat means the default quota is too tight, and neither series
// says that alone.
export function recordInterviewSession(args: { started: boolean }): void {
  safeEmit({
    metrics: [
      {
        name: args.started
          ? METRICS.INTERVIEW_SESSIONS_STARTED
          : METRICS.INTERVIEW_SESSIONS_REFUSED,
        value: 1,
        unit: "Count",
      },
    ],
    dimensions: environmentOnly(),
    dimensionSets: ENVIRONMENT_SET,
  });
}
