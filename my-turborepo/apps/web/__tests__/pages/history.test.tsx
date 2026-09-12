import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import type { SessionHistoryItem } from "@repo/shared";

let nextResult: SessionHistoryItem[] | Error = [];

const fetchSessionHistory = mock(async () => {
  if (nextResult instanceof Error) throw nextResult;
  return nextResult;
});

mock.module("@/lib/historyApi", () => ({ fetchSessionHistory }));

const { SessionHistory } = await import("@/pages/history");
const { MESSAGES } = await import("@/lib/messages");
const { MemoryRouter, Route, Routes } = await import("react-router");

function session(overrides: Partial<SessionHistoryItem> = {}): SessionHistoryItem {
  return {
    sessionId: "01J000000000000000000001",
    completedAt: "2026-09-12T10:00:00.000Z",
    role: "Backend Engineer",
    overallScore: 6.4,
    topStrength: "depth",
    topWeakness: "clarity",
    questionCount: 6,
    ...overrides,
  };
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/history"]}>
      <Routes>
        <Route path="/history" element={<SessionHistory />} />
        <Route path="/start" element={<p>start page</p>} />
        <Route path="/results/:sessionId" element={<p>detail page</p>} />
      </Routes>
    </MemoryRouter>
  );
}

async function settle() {
  await screen.findByText(
    (_content, element) => element?.tagName.toLowerCase() === "h2",
    {},
    { timeout: 2000 }
  );
}

beforeEach(() => {
  fetchSessionHistory.mockClear();
  nextResult = [];
});

afterEach(cleanup);

describe("the card list", () => {
  it("renders one card per finished interview", async () => {
    nextResult = [
      session({ sessionId: "s2", role: "Backend Engineer" }),
      session({ sessionId: "s1", role: "Platform Engineer" }),
    ];
    renderPage();

    expect(await screen.findByText("Backend Engineer")).toBeDefined();
    expect(screen.getByText("Platform Engineer")).toBeDefined();
  });

  it("shows the score and how many answers it came from", async () => {
    nextResult = [session({ overallScore: 7.2, questionCount: 9 })];
    renderPage();

    expect(await screen.findByText("7.2")).toBeDefined();
    expect(screen.getByText(/9 answers scored/)).toBeDefined();
  });

  // Named dimensions rather than coloured chips: the band palette fails the
  // normal-vision separation floor on the light surface, so a word carries it.
  it("names the strongest and weakest dimension in words", async () => {
    nextResult = [session({ topStrength: "depth", topWeakness: "clarity" })];
    renderPage();

    await screen.findByText(/Strongest/);
    expect(screen.getByText("Depth")).toBeDefined();
    expect(screen.getByText("Clarity")).toBeDefined();
  });

  it("links each card to the existing detail view", async () => {
    nextResult = [session({ sessionId: "abc123" })];
    renderPage();

    const link = await screen.findByRole("link");
    expect(link.getAttribute("href")).toBe("/results/abc123");
  });

  // One call feeds the chart and the cards. Fetching per session would be N+1
  // reads that grow with a candidate's history.
  it("fetches once for the whole page", async () => {
    nextResult = [session({ sessionId: "s1" }), session({ sessionId: "s2" })];
    renderPage();

    await screen.findByText(/interviews so far/);
    expect(fetchSessionHistory).toHaveBeenCalledTimes(1);
  });
});

describe("the trend chart", () => {
  // A trend needs two points. Saying so beats drawing a lonely dot and calling
  // it a chart.
  it("explains itself rather than plotting a single point", async () => {
    nextResult = [session()];
    renderPage();

    expect(
      await screen.findByText(MESSAGES.HISTORY_TREND_NEEDS_MORE)
    ).toBeDefined();
  });

  it("plots once there are two interviews", async () => {
    nextResult = [
      session({ sessionId: "s2", completedAt: "2026-09-12T10:00:00.000Z" }),
      session({ sessionId: "s1", completedAt: "2026-09-11T10:00:00.000Z" }),
    ];
    renderPage();

    expect(await screen.findByRole("img")).toBeDefined();
    expect(screen.queryByText(MESSAGES.HISTORY_TREND_NEEDS_MORE)).toBeNull();
  });

  // A screen reader cannot read a path, so the series goes in one sentence.
  it("describes the whole series for a screen reader", async () => {
    nextResult = [
      session({ sessionId: "s2", overallScore: 8 }),
      session({ sessionId: "s1", overallScore: 4 }),
    ];
    renderPage();

    const chart = await screen.findByRole("img");
    // Oldest first in the chart, so the description runs 4 -> 8 even though the
    // API returned newest first.
    expect(chart.getAttribute("aria-labelledby")).toBeTruthy();
    expect(chart.textContent).toContain("4 out of 10 to 8 out of 10");
  });

  // A single series needs no legend — the heading names it.
  it("has no legend", async () => {
    nextResult = [session({ sessionId: "s2" }), session({ sessionId: "s1" })];
    renderPage();

    await screen.findByRole("img");
    expect(screen.queryByText(/legend/i)).toBeNull();
  });
});

// These are primary screens, not edge cases.
describe("states with nothing to show", () => {
  it("invites a first interview rather than apologising for empty data", async () => {
    nextResult = [];
    renderPage();

    expect(await screen.findByText(MESSAGES.HISTORY_EMPTY_TITLE)).toBeDefined();
    expect(screen.getByText(MESSAGES.HISTORY_EMPTY_ACTION)).toBeDefined();
  });

  it("offers a retry when the request fails", async () => {
    nextResult = new Error("network down");
    renderPage();

    expect(await screen.findByText(MESSAGES.HISTORY_LOAD_FAILED)).toBeDefined();
    expect(
      screen.getByRole("button", { name: new RegExp(MESSAGES.RETRY, "i") })
    ).toBeDefined();
  });
});
