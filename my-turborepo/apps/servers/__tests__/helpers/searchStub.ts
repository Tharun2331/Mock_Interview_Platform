// A fake Tavily, installed over `globalThis.fetch`.
//
// Deliberately NOT a `mock.module` of lib/tavily. That module is the one piece
// of new code that talks to something outside AWS — its timeout, its
// both-queries-failed rule and its response parsing are the parts most worth
// testing, and stubbing the module would delete all three from the suite while
// only appearing to cover them.
//
// The interceptor delegates every request that is not aimed at the configured
// Tavily host straight to the real fetch. Bun runs all test files in one
// process and the route tests drive a live Express server over fetch, so a
// blanket replacement would break them from a distance if a restore was ever
// missed. Delegating makes that impossible rather than merely unlikely.

import { config } from "../../lib/config";

export type FakeResult = { title?: string; content?: string; url?: string };

type Behaviour =
  | { kind: "results"; results: FakeResult[] }
  | { kind: "status"; status: number }
  | { kind: "throw"; error: Error }
  | { kind: "hang" }
  | { kind: "malformed" };

// Per-query behaviour, so a test can fail one search and answer the other —
// which is the case the "keep whichever returned" rule exists for.
let behaviours: Behaviour[] = [];
let calls: string[] = [];

const realFetch = globalThis.fetch;

function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function installSearchStub(): void {
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();

    // Anything not aimed at Tavily is somebody else's request — the Express
    // test servers, most of the time.
    if (!url.startsWith(config.tavilyApiBase)) {
      return realFetch(input, init);
    }

    const body: unknown = init?.body === undefined ? {} : JSON.parse(String(init.body));
    const query =
      typeof body === "object" && body !== null && "query" in body
        ? String((body as { query: unknown }).query)
        : "";
    calls.push(query);

    // The last entry repeats once the queue is exhausted, so a test that wants
    // both queries to behave the same way configures one.
    const next =
      behaviours.length > 1 ? behaviours.shift() : behaviours[0];

    if (next === undefined) return respond({ results: [] });
    if (next.kind === "throw") throw next.error;
    if (next.kind === "status") return respond({ error: "nope" }, next.status);
    if (next.kind === "malformed") return respond({ results: "not an array" });
    if (next.kind === "hang") {
      // Outlives the configured timeout, so the AbortController is what ends
      // this and not the clock running out on the test.
      await new Promise((resolve) =>
        setTimeout(resolve, config.tavilyTimeoutMs + 500)
      );
      return respond({ results: [] });
    }
    return respond({ results: next.results });
  }) as typeof fetch;
}

export function restoreSearchStub(): void {
  globalThis.fetch = realFetch;
}

export function setSearchResults(...perQuery: FakeResult[][]): void {
  behaviours = perQuery.map((results) => ({ kind: "results", results }));
}

export function setSearchEmpty(): void {
  behaviours = [{ kind: "results", results: [] }];
}

export function setSearchThrows(error: Error): void {
  behaviours = [{ kind: "throw", error }];
}

export function setSearchStatus(status: number): void {
  behaviours = [{ kind: "status", status }];
}

export function setSearchMalformed(): void {
  behaviours = [{ kind: "malformed" }];
}

export function setSearchHangs(): void {
  behaviours = [{ kind: "hang" }];
}

/** One query answers, the other fails — the case the "keep whichever
 *  returned" rule exists for, and the only one needing two behaviours. */
export function setSearchPartialFailure(results: FakeResult[], error: Error): void {
  behaviours = [
    { kind: "results", results },
    { kind: "throw", error },
  ];
}

/** The queries actually sent, in order. */
export function searchQueries(): string[] {
  return [...calls];
}

export function resetSearchStub(): void {
  behaviours = [];
  calls = [];
}
