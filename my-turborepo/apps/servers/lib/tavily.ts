import { z } from "zod";
import { INTEL_LIMITS } from "@repo/shared";
import { config } from "./config";
import { getSecret } from "./ssm";
import { SearchError } from "./errors";

// ============================================================================
// THIS IS THE ONLY NON-AWS EXTERNAL CALL IN THE SERVICE.
//
// It is a deliberate exception to the all-AI-through-AWS rule in CLAUDE.md,
// and it does not weaken that rule: search is retrieval, not inference. No
// model runs here and no candidate material is generated, summarised, or
// scored by anything outside AWS. Bedrock remains the only inference path.
//
// What leaves the VPC is a company name and two fixed English phrases —
// "<company> interview process" and "<company> engineering blog tech stack".
// Never the resume, never the redacted resume text, never the transcript,
// never the GitHub summary, never a user id. That constraint is the reason
// this module takes a company name and nothing else: it cannot leak candidate
// material because it is never handed any.
// ============================================================================

// What we read back. Tavily returns more than this; the extra fields are
// dropped at the boundary rather than carried inward, so a change to their
// response shape cannot reach the agent.
const TavilyResultSchema = z.object({
  title: z.string().optional(),
  url: z.string().optional(),
  content: z.string().optional(),
});

const TavilyResponseSchema = z.object({
  results: z.array(TavilyResultSchema).optional(),
});

export type SearchSnippet = {
  title: string;
  content: string;
};

/** The two queries, fixed. Exactly two, by specification: each one is a paid
 *  call, and a third would buy vocabulary rather than signal. */
export function intelQueries(company: string): [string, string] {
  return [
    `${company} interview process`,
    `${company} engineering blog tech stack`,
  ];
}

async function runQuery(
  apiKey: string,
  query: string
): Promise<SearchSnippet[]> {
  // Its own timeout, like the GitHub call. An external dependency without one
  // holds a request open for as long as it likes, and this one sits in front of
  // a candidate waiting on a plan.
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), config.tavilyTimeoutMs);

  let response: Response;
  try {
    response = await fetch(`${config.tavilyApiBase}/search`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        query,
        // Cleaned snippets are the whole reason for using Tavily over a raw
        // search API — no HTML to strip and no page to fetch ourselves.
        search_depth: "basic",
        max_results: 3,
        include_answer: false,
        include_raw_content: false,
      }),
      signal: abort.signal,
    });
  } catch (error) {
    // An abort lands here too, which is what we want: a timeout and a refused
    // connection are the same thing to the caller — no snippets.
    throw new SearchError(
      `Tavily request failed — ${
        error instanceof Error ? error.message : "unknown"
      }`
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    // Status only. A Tavily error body can echo the query back, and while the
    // query is only a company name, logs are the wrong place to habitually
    // paste upstream response bodies.
    throw new SearchError(`Tavily responded ${response.status}`);
  }

  const parsed = TavilyResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new SearchError("Tavily response did not parse");

  return (parsed.data.results ?? [])
    .map((result) => ({
      title: (result.title ?? "").trim(),
      content: (result.content ?? "").slice(0, INTEL_LIMITS.MAX_SNIPPET_CHARS).trim(),
    }))
    .filter((snippet) => snippet.content.length > 0);
}

/**
 * Which source the key comes from.
 *
 * Pure and exported so the precedence is testable without rebuilding `config`
 * from the environment — the production gate itself lives in config.ts, which
 * blanks the direct key there before this is ever consulted.
 */
export function keySource(
  directKey: string,
  _parameterName: string
): "direct" | "ssm" {
  // Trimmed, so clearing the variable by deleting the key and leaving a space
  // falls through to SSM rather than sending " " as a bearer token — a 401
  // that reads like a bad key rather than an unset one.
  return directKey.trim().length > 0 ? "direct" : "ssm";
}

// Said once per process rather than per search. Which source answered is the
// first thing worth knowing when a local run behaves differently from a
// deployed one, and it is noise on every subsequent call.
let announced = false;

async function resolveApiKey(): Promise<string> {
  const source = keySource(config.tavilyApiKey, config.tavilySsmParameterName);

  if (!announced) {
    announced = true;
    console.log(
      source === "direct"
        ? "[tavily] using TAVILY_API_KEY from the environment (non-production only)"
        : `[tavily] reading the API key from SSM: ${config.tavilySsmParameterName}`
    );
  }

  // The direct key never exists in production — config.ts blanks it there — so
  // this branch is unreachable on a deployed task by construction rather than
  // by discipline.
  return source === "direct"
    ? config.tavilyApiKey
    : getSecret(config.tavilySsmParameterName);
}

/**
 * Both queries, capped.
 *
 * Runs them in parallel and keeps whichever returned: one query failing is not
 * a reason to discard the other's snippets, and an empty array is a valid
 * result the agent already knows how to handle.
 *
 * Throws only when BOTH failed, so the caller can tell "the company has no
 * public writing" (empty) from "search is down" (thrown) — they read the same
 * to a candidate, but not in a log.
 */
export async function searchCompany(company: string): Promise<SearchSnippet[]> {
  const apiKey = await resolveApiKey();
  const [first, second] = await Promise.allSettled(
    intelQueries(company).map((query) => runQuery(apiKey, query))
  );

  const snippets: SearchSnippet[] = [];
  for (const settled of [first, second]) {
    if (settled?.status === "fulfilled") snippets.push(...settled.value);
  }

  const bothFailed =
    first?.status === "rejected" && second?.status === "rejected";
  if (bothFailed) {
    throw new SearchError(
      `Both company searches failed — ${
        first.reason instanceof Error ? first.reason.message : "unknown"
      }`
    );
  }

  return snippets.slice(0, INTEL_LIMITS.MAX_SNIPPETS);
}
