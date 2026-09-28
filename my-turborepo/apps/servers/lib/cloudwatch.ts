import {
  CloudWatchClient,
  GetMetricDataCommand,
  ListMetricsCommand,
  type MetricDataQuery,
} from "@aws-sdk/client-cloudwatch";
import type { MetricSeries } from "@repo/shared";
import { config } from "./config";
import { METRICS } from "./constants";
import { ServiceError } from "./errors";
import { MESSAGES } from "./messages";

// Reads metrics back out. The other half of lib/metrics.ts, which writes them.
//
// Two modules rather than one because they share nothing but the metric names:
// the writer emits EMF on stdout and needs no AWS client and no credentials at
// all, while this one is an ordinary AWS SDK caller. Putting them together would
// give the emitter — which runs on every single request — a CloudWatch client it
// never uses.
//
// **This reads nothing until the service runs somewhere with a log group.**
// EMF metrics are extracted by CloudWatch Logs at ingestion, so on a laptop the
// emitted lines never become metrics and every query here correctly returns
// empty. The `empty` and `noData` flags exist so the dashboard can say that
// rather than draw zero.
//
// The SDK is pinned to an exact version in package.json rather than a caret
// range. `@aws-sdk/client-cloudwatch@3.1130.0` declares `@smithy/types@^4.17.2`,
// which matches the root `overrides` pin and every other AWS SDK here. The next
// minor declares `^4.19.0`, which the override forces down to 4.17.2 and which
// then produces structural type errors the moment the client is mocked — the
// exact failure CLAUDE.md records for `client-bedrock-runtime`, and it is
// type-only, so `bun test` stays green and CI is what breaks. Do not loosen the
// pin without realigning the override and every other `@aws-sdk/*` with it.

export const cloudWatchClient = new CloudWatchClient({
  region: config.awsRegion,
});

type Statistic = "Sum" | "Average" | "p95";

type SeriesDefinition = {
  // GetMetricData requires an id matching /^[a-z][a-zA-Z0-9_]*$/ — it is an
  // expression identifier, not a label, and a violation is a validation error for
  // the whole request rather than for the one query.
  id: string;
  metricName: string;
  label: string;
  stat: Statistic;
  unit: MetricSeries["unit"];
};

// What the dashboard shows, and why each statistic is what it is.
//
// The choice of statistic is not cosmetic. `Average` on latency is the classic
// way to miss an outage: a route where one request in twenty takes nine seconds
// has a perfectly healthy mean, and that one request in twenty is a person
// staring at a spinner. p95 is what a latency alarm should watch and therefore
// what the graph beside it should show.
//
// Counts are `Sum` because a rate is what they mean — "how many 5xx in this
// period" — and an average count per datapoint is a number with no
// interpretation. `SonicStreamDuration` is a Sum for the same reason inverted: it
// is the billed quantity, and the total is the bill.
const SERIES: readonly SeriesDefinition[] = [
  {
    id: "requestCount",
    metricName: METRICS.REQUEST_COUNT,
    label: "Requests",
    stat: "Sum",
    unit: "Count",
  },
  {
    id: "requestLatencyP95",
    metricName: METRICS.REQUEST_LATENCY,
    label: "Request latency (p95)",
    stat: "p95",
    unit: "Milliseconds",
  },
  {
    id: "requests4xx",
    metricName: METRICS.REQUEST_4XX,
    label: "4xx responses",
    stat: "Sum",
    unit: "Count",
  },
  {
    id: "requests5xx",
    metricName: METRICS.REQUEST_5XX,
    label: "5xx responses",
    stat: "Sum",
    unit: "Count",
  },
  {
    id: "sonicStreamLatency",
    metricName: METRICS.SONIC_STREAM_LATENCY,
    label: "Sonic stream open latency (avg)",
    stat: "Average",
    unit: "Milliseconds",
  },
  {
    id: "sonicStreamDuration",
    metricName: METRICS.SONIC_STREAM_DURATION,
    // Named as spend rather than as duration, because that is what it is for.
    label: "Sonic billed stream time (total)",
    stat: "Sum",
    unit: "Milliseconds",
  },
  {
    id: "sonicInputTokens",
    metricName: METRICS.SONIC_INPUT_TOKENS,
    label: "Sonic input tokens",
    stat: "Sum",
    unit: "Count",
  },
  {
    id: "sonicOutputTokens",
    metricName: METRICS.SONIC_OUTPUT_TOKENS,
    label: "Sonic output tokens",
    stat: "Sum",
    unit: "Count",
  },
  {
    id: "sonicStreamErrors",
    metricName: METRICS.SONIC_STREAM_ERRORS,
    label: "Sonic stream errors",
    stat: "Sum",
    unit: "Count",
  },
  {
    id: "sonicStreamRenewals",
    metricName: METRICS.SONIC_STREAM_RENEWALS,
    label: "Sonic stream renewals",
    stat: "Sum",
    unit: "Count",
  },
  {
    id: "interviewsStarted",
    metricName: METRICS.INTERVIEW_SESSIONS_STARTED,
    label: "Interviews started",
    stat: "Sum",
    unit: "Count",
  },
  {
    id: "interviewsRefused",
    metricName: METRICS.INTERVIEW_SESSIONS_REFUSED,
    label: "Interviews refused (quota)",
    stat: "Sum",
    unit: "Count",
  },
];

// How many route templates the per-route latency breakdown will chart.
//
// Bounded because the query count is what GetMetricData bills on, and because a
// chart with forty lines communicates nothing. The routes are discovered rather
// than listed, so this cap is the only thing between "a route was added" and "the
// dashboard silently got more expensive".
const MAX_ROUTE_SERIES = 12;

const environmentDimension = [
  { Name: METRICS.DIMENSION_ENVIRONMENT, Value: config.appEnvironment },
];

// Turns a route template into a valid GetMetricData query id.
//
// `/api/v1/sessions/:sessionId` contains slashes and a colon, none of which the
// id grammar allows, and an invalid id fails the entire request rather than the
// one query. The result only has to be unique and stable within one request —
// the human-readable form travels in `Label`.
function routeQueryId(index: number): string {
  return `routeLatency${index}`;
}

// Discovers which route templates have actually reported latency.
//
// ListMetrics rather than a hardcoded route list, because a hardcoded list drifts
// the moment a route is added or renamed and the failure is a silently missing
// line on a chart. ListMetrics is not billed per call, so this costs a round trip
// and nothing else.
//
// A failure here degrades to no per-route breakdown rather than failing the whole
// request: the aggregate series are the more important half, and losing the
// breakdown is visibly incomplete rather than quietly wrong.
async function discoverRoutes(): Promise<string[]> {
  try {
    const response = await cloudWatchClient.send(
      new ListMetricsCommand({
        Namespace: config.metricsNamespace,
        MetricName: METRICS.REQUEST_LATENCY,
        // Only the two-dimension variant. Without this the Environment-only
        // aggregate comes back too, with no Route value, and would become a
        // nameless series.
        Dimensions: [
          { Name: METRICS.DIMENSION_ENVIRONMENT, Value: config.appEnvironment },
          { Name: METRICS.DIMENSION_ROUTE },
        ],
      }),
    );

    const routes = (response.Metrics ?? [])
      .map(
        (metric) =>
          metric.Dimensions?.find(
            (dimension) => dimension.Name === METRICS.DIMENSION_ROUTE,
          )?.Value,
      )
      .filter((value): value is string => value !== undefined);

    // Sorted so the chart's line order is stable between loads. ListMetrics does
    // not promise an order, and an unstable one makes colours shuffle on every
    // refresh — which reads as the data changing.
    return [...new Set(routes)].sort().slice(0, MAX_ROUTE_SERIES);
  } catch (error) {
    console.warn(
      `[metrics] route discovery failed, charting aggregates only — ${
        error instanceof Error ? error.message : error
      }`,
    );
    return [];
  }
}

// Reads every series for one window.
//
// One GetMetricData call for all of them rather than a call per metric.
// GetMetricData bills per metric-datapoint returned, not per request, so batching
// is free in cost terms and saves a dozen round trips — but it also means every
// series shares one period, which is why the period is chosen per window rather
// than per metric.
export async function readMetrics(args: {
  windowHours: number;
  periodSeconds: number;
}): Promise<{ series: MetricSeries[]; noData: boolean }> {
  const end = new Date();
  const start = new Date(end.getTime() - args.windowHours * 60 * 60 * 1000);

  const routes = await discoverRoutes();

  const queries: MetricDataQuery[] = [
    ...SERIES.map((definition) => ({
      Id: definition.id,
      Label: definition.label,
      MetricStat: {
        Metric: {
          Namespace: config.metricsNamespace,
          MetricName: definition.metricName,
          Dimensions: environmentDimension,
        },
        Period: args.periodSeconds,
        Stat: definition.stat,
      },
      ReturnData: true,
    })),
    ...routes.map((route, index) => ({
      Id: routeQueryId(index),
      Label: `${route} (p95)`,
      MetricStat: {
        Metric: {
          Namespace: config.metricsNamespace,
          MetricName: METRICS.REQUEST_LATENCY,
          Dimensions: [
            ...environmentDimension,
            { Name: METRICS.DIMENSION_ROUTE, Value: route },
          ],
        },
        Period: args.periodSeconds,
        Stat: "p95",
      },
      ReturnData: true,
    })),
  ];

  let response;
  try {
    response = await cloudWatchClient.send(
      new GetMetricDataCommand({
        MetricDataQueries: queries,
        StartTime: start,
        EndTime: end,
        // Ascending, so the chart receives points in the order it draws them.
        // CloudWatch's default is TimestampDescending, which renders as a chart
        // running backwards and is the kind of bug that gets blamed on the data.
        ScanBy: "TimestampAscending",
      }),
    );
  } catch (error) {
    throw new ServiceError(
      `${MESSAGES.METRICS_READ_FAILED} — ${
        error instanceof Error ? error.message : "unknown"
      }`,
    );
  }

  // A NextToken means CloudWatch truncated the result. Not followed: the periods
  // in METRICS_WINDOW are chosen so each series is well under two hundred points,
  // so this should be unreachable — and a paging loop here would be an unbounded
  // number of billed calls behind one page load. Logged rather than ignored,
  // because a truncated chart that looks complete is worse than a slow one.
  if (response.NextToken !== undefined) {
    console.warn(
      `[metrics] GetMetricData returned a NextToken for a ` +
        `${args.windowHours}h/${args.periodSeconds}s window — the chart is truncated`,
    );
  }

  const byId = new Map(
    (response.MetricDataResults ?? []).map((result) => [result.Id, result]),
  );

  // Built from the definitions rather than from the response, so a series
  // CloudWatch returned nothing for is still present and flagged empty. Iterating
  // the response instead would make an un-ingested metric vanish from the payload,
  // and the page would render eleven charts one day and nine the next.
  const toSeries = (
    id: string,
    label: string,
    unit: MetricSeries["unit"],
  ): MetricSeries => {
    const result = byId.get(id);
    const timestamps = result?.Timestamps ?? [];
    const values = result?.Values ?? [];

    // Zipped defensively. The two arrays are parallel by contract, and a mismatch
    // would silently pair a value with the wrong instant — so the shorter one
    // wins rather than producing points with an undefined half.
    const length = Math.min(timestamps.length, values.length);

    return {
      id,
      label: result?.Label ?? label,
      unit,
      timestamps: timestamps
        .slice(0, length)
        .map((timestamp) => timestamp.toISOString()),
      values: values.slice(0, length),
      empty: length === 0,
    };
  };

  const series: MetricSeries[] = [
    ...SERIES.map((definition) =>
      toSeries(definition.id, definition.label, definition.unit),
    ),
    ...routes.map((route, index) =>
      toSeries(routeQueryId(index), `${route} (p95)`, "Milliseconds"),
    ),
  ];

  return {
    series,
    // Every series empty is the "not ingesting" case, which is the expected state
    // until an ECS task ships logs. One series empty is just a metric nothing has
    // triggered yet — a 5xx count on a healthy day — and must not read the same.
    noData: series.every((entry) => entry.empty),
  };
}
