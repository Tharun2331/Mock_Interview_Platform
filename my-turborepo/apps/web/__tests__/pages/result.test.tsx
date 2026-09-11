import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { EvaluationResponse } from "@repo/shared";

// The API client is the boundary. Mocked before the page is imported, because
// the page captures the binding on import.
let nextResult: EvaluationResponse | Error = {
  status: "evaluating",
  completed: 0,
  total: 2,
  evaluations: [],
};

const fetchEvaluation = mock(async (_sessionId: string) => {
  if (nextResult instanceof Error) throw nextResult;
  return nextResult;
});

mock.module("@/lib/resultsApi", () => ({
  fetchEvaluation,
  isEvaluationFinished: (result: EvaluationResponse) =>
    result.averages !== undefined || result.status === "failed",
}));

const { Result } = await import("@/pages/result");
const { MESSAGES } = await import("@/lib/messages");
const { MemoryRouter, Route, Routes } = await import("react-router");

const SESSION_ID = "01J000000000000000000000";

function evaluation(overrides: Record<string, unknown> = {}) {
  return {
    questionId: "01M000000000000000000001",
    questionText: "How do you choose between a queue and a direct call?",
    questionType: "technical" as const,
    transcript: "Queues are good when you want things asynchronous.",
    interrupted: false,
    durationMs: 48_000,
    correctness: 7,
    clarity: 6,
    depth: 3,
    rationale: "Naming one queue you have run in production would help.",
    evaluatedAt: "2026-09-10T12:00:00.000Z",
    ...overrides,
  };
}

function renderAt(path = `/results/${SESSION_ID}`) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/results/:sessionId" element={<Result />} />
        <Route path="/results" element={<Result />} />
        <Route path="/start" element={<p>start page</p>} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  fetchEvaluation.mockClear();
  nextResult = { status: "evaluating", completed: 0, total: 2, evaluations: [] };
});

afterEach(cleanup);

describe("while answers are still being scored", () => {
  // An unlabelled spinner is indistinguishable from a stuck one. The count is
  // what makes the wait legible.
  it("shows how many of how many have been scored", async () => {
    nextResult = {
      status: "evaluating",
      completed: 2,
      total: 6,
      evaluations: [evaluation()],
    };
    renderAt();

    await waitFor(() =>
      expect(screen.getByText(MESSAGES.RESULT_PROGRESS(2, 6))).toBeDefined()
    );
  });

  // Partial results as they land — the whole point of scoring asynchronously.
  it("renders the answers that have arrived already", async () => {
    nextResult = {
      status: "evaluating",
      completed: 1,
      total: 6,
      evaluations: [evaluation()],
    };
    renderAt();

    await waitFor(() =>
      expect(
        screen.getByText("How do you choose between a queue and a direct call?")
      ).toBeDefined()
    );
  });

  it("does not show whole-interview averages before they exist", async () => {
    nextResult = {
      status: "evaluating",
      completed: 1,
      total: 6,
      evaluations: [evaluation()],
    };
    renderAt();

    await waitFor(() => expect(fetchEvaluation).toHaveBeenCalled());
    expect(screen.queryByText(MESSAGES.RESULT_OVERALL)).toBeNull();
  });
});

describe("once the round is finished", () => {
  const finished: EvaluationResponse = {
    status: "complete",
    completed: 1,
    total: 1,
    averages: { correctness: 7, clarity: 6, depth: 3 },
    evaluations: [evaluation()],
    role: "Backend Engineer",
  };

  it("shows the whole-interview averages", async () => {
    nextResult = finished;
    renderAt();

    await waitFor(() =>
      expect(screen.getByText(MESSAGES.RESULT_OVERALL)).toBeDefined()
    );
  });

  it("stops polling, so a page left open does not keep asking", async () => {
    nextResult = finished;
    renderAt();

    await waitFor(() => expect(fetchEvaluation).toHaveBeenCalledTimes(1));

    // Well past the poll interval. A finished round must not schedule another
    // request.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(fetchEvaluation).toHaveBeenCalledTimes(1);
  });

  // A rating with no visible answer is unreadable as feedback.
  it("shows the candidate's own words beside the score", async () => {
    nextResult = finished;
    renderAt();

    await waitFor(() =>
      expect(
        screen.getByText("Queues are good when you want things asynchronous.")
      ).toBeDefined()
    );
  });

  // A bare "3/10 depth" teaches nothing — the rationale is the coaching.
  it("shows what would have made the answer stronger", async () => {
    nextResult = finished;
    renderAt();

    await waitFor(() =>
      expect(
        screen.getByText("Naming one queue you have run in production would help.")
      ).toBeDefined()
    );
  });

  // The frontend contract: a candidate is talking to "the interviewer", never
  // to a named service.
  it("never names a model", async () => {
    nextResult = finished;
    const { container } = renderAt();

    await waitFor(() => expect(screen.getByText(MESSAGES.RESULT_OVERALL)).toBeDefined());
    expect(container.textContent).not.toContain("ministral");
    expect(container.textContent).not.toContain("Bedrock");
    expect(container.textContent).not.toContain("Sonic");
  });

  // A score on a half-heard question needs its context, or it reads as an
  // unexplained penalty.
  it("says when an answer was given over an interrupted question", async () => {
    nextResult = { ...finished, evaluations: [evaluation({ interrupted: true })] };
    renderAt();

    await waitFor(() =>
      expect(screen.getByText(MESSAGES.RESULT_INTERRUPTED)).toBeDefined()
    );
  });

  it("does not say so when the question was heard in full", async () => {
    nextResult = finished;
    renderAt();

    await waitFor(() => expect(screen.getByText(MESSAGES.RESULT_OVERALL)).toBeDefined());
    expect(screen.queryByText(MESSAGES.RESULT_INTERRUPTED)).toBeNull();
  });
});

// These are primary screens, not edge cases.
describe("states with nothing to show", () => {
  it("explains an interview that recorded nothing, rather than spinning", async () => {
    nextResult = { status: "complete", completed: 0, total: 0, evaluations: [] };
    renderAt();

    await waitFor(() =>
      expect(screen.getByText(MESSAGES.RESULT_EMPTY_TITLE)).toBeDefined()
    );
  });

  it("explains an interview that failed before it could be scored", async () => {
    nextResult = { status: "failed", completed: 0, total: 3, evaluations: [] };
    renderAt();

    await waitFor(() =>
      expect(screen.getByText(MESSAGES.RESULT_FAILED_TITLE)).toBeDefined()
    );
  });

  it("offers a retry when the request fails", async () => {
    nextResult = new Error("network down");
    renderAt();

    await waitFor(() =>
      expect(screen.getByText(MESSAGES.RESULT_LOAD_FAILED)).toBeDefined()
    );
    expect(
      screen.getByRole("button", { name: new RegExp(MESSAGES.RETRY, "i") })
    ).toBeDefined();
  });

  it("stops polling after a failure instead of retrying forever", async () => {
    nextResult = new Error("network down");
    renderAt();

    await waitFor(() => expect(fetchEvaluation).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(fetchEvaluation).toHaveBeenCalledTimes(1);
  });

  // Arriving with no session named is a real screen, not a crash — and it must
  // not fetch anything.
  it("explains a missing session id without calling the API", async () => {
    renderAt("/results");

    await waitFor(() =>
      expect(screen.getByText(MESSAGES.RESULT_MISSING_SESSION)).toBeDefined()
    );
    expect(fetchEvaluation).not.toHaveBeenCalled();
  });
});
