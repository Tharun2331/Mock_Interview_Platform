import { Router } from "express";
import {
  AdminMetricsQuery,
  METRICS_WINDOW,
  type AdminMetricsResponse,
} from "@repo/shared";
import { requireAdminId } from "../lib/adminAuth";
import { readMetrics } from "../lib/cloudwatch";
import { config } from "../lib/config";
import { ServiceError } from "../lib/errors";
import { MESSAGES } from "../lib/messages";

// GET /api/v1/admin/metrics?hours=24
//
// Its own router rather than a third route in routes/admin.ts, mounted on the
// same path behind the same guard. Split because the two have nothing in common
// below the auth check: this one talks to CloudWatch and knows nothing about
// users, that one talks to Cognito and DynamoDB and knows nothing about metrics.
//
// **This returns empty series until the service runs with a CloudWatch log
// group.** Metrics are emitted as EMF on stdout and extracted at log ingestion, so
// there is nothing to read back while the app runs on a laptop. `noData` says so
// explicitly, which is why the page can distinguish "not wired up yet" from "no
// traffic" — a distinction the charts alone cannot make. There is no `ecs` module
// yet, so today this always answers `noData: true`, correctly.

export const adminMetricsRouter = Router();

adminMetricsRouter.get("/", async (req, res) => {
  const adminId = requireAdminId(req, res);
  if (adminId === null) return;

  const parsed = AdminMetricsQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({
      message: MESSAGES.INVALID_ADMIN_BODY,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
    return;
  }

  const windowHours = parsed.data.hours ?? METRICS_WINDOW.DEFAULT_HOURS;

  // A total lookup, not a cast. `windowHours` is a literal union by the time it
  // gets here — AdminMetricsQuery pipes into `z.literal(METRICS_WINDOW.HOURS)` —
  // so TypeScript proves every branch has a period. That is the whole reason the
  // window is a closed set rather than a number with bounds: an arbitrary window
  // needs a period derived at runtime, and getting that wrong means either a
  // truncated chart or a GetMetricData bill nobody chose. Adding an hours value
  // without a period is now a compile error here.
  const periodSeconds = METRICS_WINDOW.PERIOD_SECONDS[windowHours];

  try {
    const { series, noData } = await readMetrics({
      windowHours,
      periodSeconds,
    });

    const body: AdminMetricsResponse = {
      windowHours,
      periodSeconds,
      // Echoed so the page can name what it is showing. When every series is
      // empty, the namespace is the single most useful thing to display: the
      // usual cause is that the emitter and the reader disagree about it.
      namespace: config.metricsNamespace,
      series,
      noData,
    };
    res.json(body);
  } catch (error) {
    if (error instanceof ServiceError) {
      console.error(`[admin] ${error.message}`);
      res.status(500).json({ message: MESSAGES.METRICS_UNAVAILABLE });
      return;
    }

    console.error(`[admin] ${error instanceof Error ? error.message : error}`);
    res.status(500).json({ message: MESSAGES.UNEXPECTED_FAILED });
  }
});
