import { describe, expect, it } from "bun:test";
import type { Request } from "express";
import { METRICS } from "../../lib/constants";
import { buildMetricEvent, routeTemplate } from "../../lib/metrics";

// Two things are tested here and they are not equally important.
//
// `routeTemplate` is the one whose failure is a BILL rather than a missing graph.
// Every distinct dimension value is a separately billed CloudWatch metric, and an
// unmatched request's path is whatever the caller typed — so a route dimension
// taken verbatim from a 404 mints a new metric per unique URL, unauthenticated and
// with no rate limiter in front of it, because an unmatched path never reaches a
// mounted router. That is the guard being pinned.
//
// `buildMetricEvent` is tested for wire shape. EMF has no error path: a malformed
// `_aws` block is not rejected, it is stored as an ordinary log line and the
// metrics silently never appear. Nothing at runtime will ever tell you.

// A Request is enormous and this function reads two fields off it. Building a
// minimal object and narrowing is honest about that — the alternative is a fake
// with fifty irrelevant properties, which hides which two actually matter.
function fakeRequest(args: { baseUrl: string; routePath?: string }): Request {
  const partial = {
    baseUrl: args.baseUrl,
    route: args.routePath === undefined ? undefined : { path: args.routePath },
  };

  // Asserted immediately after construction, which is the narrowing the shape
  // above proves: `routeTemplate` reads `baseUrl` and `route?.path` and nothing
  // else, both of which are present and correctly typed here.
  return partial as unknown as Request;
}

describe("routeTemplate", () => {
  it("joins the mount prefix to the router-relative pattern", () => {
    expect(
      routeTemplate(
        fakeRequest({ baseUrl: "/api/v1/sessions", routePath: "/:sessionId" }),
      ),
    ).toBe("/api/v1/sessions/:sessionId");
  });

  it("returns the PARAMETERISED template, never a concrete id", () => {
    // The cardinality question. `/api/v1/sessions/01J8XYZ.../evaluation` as a
    // dimension value is one billed metric per session — which is one per
    // interview, forever, including for sessions long since expired by TTL.
    const template = routeTemplate(
      fakeRequest({
        baseUrl: "/api/v1/sessions",
        routePath: "/:sessionId/evaluation",
      }),
    );

    expect(template).toBe("/api/v1/sessions/:sessionId/evaluation");
    expect(template).toContain(":sessionId");
  });

  it("buckets an unmatched request rather than using its path", () => {
    // THE cost guard. `req.route` is undefined when nothing matched, and the
    // requested path is attacker-controlled. Anything other than a constant here
    // is a denial of wallet.
    expect(routeTemplate(fakeRequest({ baseUrl: "" }))).toBe(
      METRICS.UNMATCHED_ROUTE,
    );
  });

  it("attributes a request refused before routing to its mount prefix", () => {
    // The case a boot check caught, and the reason this branch exists at all.
    // AuthMiddleware refuses before routing completes, so `req.route` is unset on
    // EVERY 401 — the first version of this function sent all of them to the
    // unmatched bucket, which meant no auth failure on any route could be told
    // apart from a random 404.
    //
    // `baseUrl` is safe here because Express only sets it to a mount path that
    // actually matched, so its range is the fixed set of prefixes in index.ts. It
    // is never the caller's path.
    expect(routeTemplate(fakeRequest({ baseUrl: "/api/v1/admin" }))).toBe(
      "/api/v1/admin/*",
    );
  });

  it("keeps a prefix-only bucket distinguishable from the real endpoint", () => {
    // Without the `/*` suffix these two collapse into one series, which averages a
    // 401 rate into the latency figure for the endpoint that did serve.
    const refused = routeTemplate(fakeRequest({ baseUrl: "/api/v1/plan" }));
    const served = routeTemplate(
      fakeRequest({ baseUrl: "/api/v1/plan", routePath: "/" }),
    );

    expect(refused).not.toBe(served);
    expect(served).toBe("/api/v1/plan");
    expect(refused).toBe("/api/v1/plan/*");
  });

  it("keeps the prefix bucket independent of what the caller asked for", () => {
    // The cardinality guarantee restated: the function reads `baseUrl` and
    // `route.path` and NOTHING else, so no property of the request URL can vary
    // the dimension value. If a future version reaches for `req.path` or
    // `req.originalUrl`, this is the test that should stop it.
    const withQuery = {
      baseUrl: "/api/v1/admin",
      path: "/whatever-the-caller-typed",
      originalUrl: "/api/v1/admin/whatever-the-caller-typed?x=1",
    };

    expect(routeTemplate(withQuery as unknown as Request)).toBe(
      "/api/v1/admin/*",
    );
  });

  it("collapses a router's own root to the mount path without a trailing slash", () => {
    // `/api/v1/plan` and `/api/v1/plan/` would otherwise be two series for one
    // endpoint — two billed metrics and a graph that splits in half.
    expect(
      routeTemplate(fakeRequest({ baseUrl: "/api/v1/plan", routePath: "/" })),
    ).toBe("/api/v1/plan");
  });

  it("never returns an empty string", () => {
    // An empty dimension VALUE invalidates the whole EMF event, taking every
    // metric on it — so the one thing worse than a wrong label is no label.
    expect(routeTemplate(fakeRequest({ baseUrl: "", routePath: "/" }))).toBe(
      METRICS.UNMATCHED_ROUTE,
    );
  });

  it("ignores a route whose path is not a string", () => {
    // Express types `route` loosely enough that this is reachable through a
    // version change rather than through a bug here. Falling back to the prefix
    // bucket beats emitting "undefined" or "42" as a dimension value — the first
    // is a nonsense series, the second is a number that would look like an id and
    // raise the cardinality question all over again.
    const weird = { baseUrl: "/api/v1/plan", route: { path: 42 } };
    expect(routeTemplate(weird as unknown as Request)).toBe("/api/v1/plan/*");
  });

  it("falls all the way back when neither a prefix nor a route is known", () => {
    // Both signals absent, which is a genuine 404 on a path no mount matched.
    // This is the branch UNMATCHED_ROUTE exists for, and the only one left that
    // uses it.
    expect(routeTemplate(fakeRequest({ baseUrl: "" }))).toBe(
      METRICS.UNMATCHED_ROUTE,
    );
  });

  it("survives an UNDEFINED baseUrl, which is what a real 404 carries", () => {
    // The regression test for a crash, not a cosmetic bug.
    //
    // `@types/express` types `baseUrl` as `string`, and at runtime Express leaves
    // it undefined when no mount matched. Reading `.length` off it threw inside the
    // `res.on("finish")` listener — an EventEmitter callback that Express's error
    // middleware cannot see — so the process died on every unmatched request.
    //
    // A hand-built object rather than `fakeRequest`, because the whole point is a
    // shape the TYPES say is impossible. Only running the server found this, which
    // is why it is pinned here now.
    const noBaseUrl = { route: undefined };

    expect(() => routeTemplate(noBaseUrl as unknown as Request)).not.toThrow();
    expect(routeTemplate(noBaseUrl as unknown as Request)).toBe(
      METRICS.UNMATCHED_ROUTE,
    );
  });
});

describe("buildMetricEvent", () => {
  const event = buildMetricEvent({
    metrics: [
      { name: METRICS.REQUEST_COUNT, value: 1, unit: "Count" },
      { name: METRICS.REQUEST_LATENCY, value: 142.5, unit: "Milliseconds" },
    ],
    dimensions: {
      [METRICS.DIMENSION_ENVIRONMENT]: "test",
      [METRICS.DIMENSION_ROUTE]: "/api/v1/plan",
    },
    dimensionSets: [
      [METRICS.DIMENSION_ENVIRONMENT],
      [METRICS.DIMENSION_ENVIRONMENT, METRICS.DIMENSION_ROUTE],
    ],
    namespace: "PrepPilot/Test",
    timestamp: 1_800_000_000_000,
  });

  it("puts every metric value at the ROOT, keyed by its own name", () => {
    // The part of EMF that is easy to get wrong by nesting the values under the
    // `_aws` block, where they look organised and are ignored. The declaration
    // names the metric; the root property carries its value, and both are needed.
    expect(event[METRICS.REQUEST_COUNT]).toBe(1);
    expect(event[METRICS.REQUEST_LATENCY]).toBe(142.5);
  });

  it("declares every emitted value in the metric list", () => {
    // Structural rather than a literal comparison, so a metric added to one half
    // and not the other fails here. A value with no declaration is ignored by
    // CloudWatch and a declaration with no value is a gap in the series — and both
    // are silent.
    const declared = event._aws.CloudWatchMetrics[0].Metrics.map((m) => m.Name);

    expect(declared).toEqual([METRICS.REQUEST_COUNT, METRICS.REQUEST_LATENCY]);
    for (const name of declared) {
      expect(event[name]).toBeDefined();
    }
  });

  it("puts every dimension value at the root too", () => {
    // Same trap as the metrics: a dimension NAMED in a set but with no root
    // property is a set CloudWatch cannot resolve, and it drops the series
    // without complaint.
    for (const set of event._aws.CloudWatchMetrics[0].Dimensions) {
      for (const name of set) {
        expect(typeof event[name]).toBe("string");
      }
    }
  });

  it("carries both dimension sets from one event", () => {
    // The aggregate and the per-route breakdown come from a single emission, so
    // CloudWatch derives the aggregate rather than the service computing it twice
    // and letting the two disagree.
    expect(event._aws.CloudWatchMetrics[0].Dimensions).toEqual([
      ["Environment"],
      ["Environment", "Route"],
    ]);
  });

  it("uses the supplied timestamp in epoch milliseconds", () => {
    // Seconds instead of milliseconds is the classic EMF mistake: the event is
    // accepted and the datapoint lands in 1970, so the chart is empty and nothing
    // reports an error.
    expect(event._aws.Timestamp).toBe(1_800_000_000_000);
  });

  it("truncates an over-long dimension value rather than dropping the event", () => {
    // Over EMF's limit the whole event is invalid, taking the metrics with it.
    // Losing the tail of one route template beats losing the measurement.
    const long = "/x".repeat(400);
    const truncated = buildMetricEvent({
      metrics: [{ name: METRICS.REQUEST_COUNT, value: 1, unit: "Count" }],
      dimensions: { [METRICS.DIMENSION_ROUTE]: long },
      dimensionSets: [[METRICS.DIMENSION_ROUTE]],
      namespace: "PrepPilot/Test",
      timestamp: 1,
    });

    expect(truncated[METRICS.DIMENSION_ROUTE]).toHaveLength(
      METRICS.MAX_DIMENSION_VALUE_CHARS,
    );
  });

  it("survives a JSON round trip, which is how it actually travels", () => {
    // It is written with JSON.stringify and read by a log parser, so anything
    // non-serialisable — undefined, Infinity, NaN — is lost or corrupted in
    // transit rather than at construction.
    const parsed: unknown = JSON.parse(JSON.stringify(event));
    expect(parsed).toEqual(event);
  });
});
