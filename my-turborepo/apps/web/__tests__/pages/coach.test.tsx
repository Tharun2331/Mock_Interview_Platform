import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import type { CoachReport } from "@repo/shared";

let nextResult: CoachReport | Error = { trends: [], roadmap: [] };

const fetchCoachReport = mock(async () => {
  if (nextResult instanceof Error) throw nextResult;
  return nextResult;
});

mock.module("@/lib/coachApi", () => ({ fetchCoachReport }));

const { Coach } = await import("@/pages/coach");
const { MESSAGES } = await import("@/lib/messages");
const { MemoryRouter, Route, Routes } = await import("react-router");

function report(overrides: Partial<CoachReport> = {}): CoachReport {
  return {
    trends: [
      {
        topic: "Backend Engineer",
        direction: "improving",
        scoreHistory: [
          { date: "2026-09-01T10:00:00.000Z", avgScore: 3 },
          { date: "2026-09-10T10:00:00.000Z", avgScore: 8 },
        ],
        summary: "You are getting steadier at explaining your own systems.",
      },
    ],
    roadmap: [
      {
        topic: "Backend Engineer",
        avgScore: 4.2,
        track: "communication",
        confidence: "confident",
        focusPoints: ["Name the tradeoff before the solution."],
        priority: 1,
      },
      {
        topic: "Backend Engineer",
        avgScore: 5.5,
        track: "technical",
        confidence: "tentative",
        focusPoints: ["Read up on consistent hashing."],
        priority: 2,
      },
    ],
    ...overrides,
  };
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/coach"]}>
      <Routes>
        <Route path="/coach" element={<Coach />} />
        <Route path="/start" element={<p>start page</p>} />
      </Routes>
    </MemoryRouter>
  );
}

/** The page fetches on mount, so every assertion waits for the first paint
 *  after that resolves rather than racing the loading state. */
async function settle(): Promise<void> {
  await screen.findByRole("heading", { level: 2 }, { timeout: 2000 });
}

beforeEach(() => {
  fetchCoachReport.mockClear();
  nextResult = report();
});

afterEach(cleanup);

describe("a candidate with nothing to coach", () => {
  // The most common first-run screen. Written as an invitation rather than an
  // apology for empty data — finishing nothing yet is not a failure.
  it("invites them to start rather than reporting emptiness", async () => {
    nextResult = { trends: [], roadmap: [] };
    renderPage();
    await settle();

    expect(screen.getByText(MESSAGES.COACH_EMPTY_TITLE)).toBeDefined();
    expect(
      screen.getByRole("button", { name: MESSAGES.COACH_EMPTY_ACTION })
    ).toBeDefined();
  });

  it("does not render an empty roadmap list", async () => {
    nextResult = { trends: [], roadmap: [] };
    renderPage();
    await settle();

    expect(screen.queryByRole("list")).toBeNull();
  });
});

describe("a candidate with one interview", () => {
  // A trend needs two points. Saying so beats drawing a lonely dot and calling
  // it a chart — and it tells them exactly what produces one.
  it("says why there is no trend yet instead of showing an empty chart", async () => {
    nextResult = report({ trends: [] });
    renderPage();
    await settle();

    expect(screen.getByText(MESSAGES.COACH_TRENDS_NEEDS_MORE)).toBeDefined();
    expect(screen.queryByRole("img")).toBeNull();
  });

  // The roadmap is the more useful half, and one interview is enough for it.
  it("still shows the roadmap", async () => {
    nextResult = report({ trends: [] });
    renderPage();
    await settle();

    // Named on both tracks, so this is getAllByText rather than getByText.
    expect(screen.getAllByText("Backend Engineer").length).toBeGreaterThan(0);
    expect(
      screen.getByText("Name the tradeoff before the solution.")
    ).toBeDefined();
  });
});

describe("the trend cards", () => {
  it("renders a chart per topic", async () => {
    renderPage();
    await settle();

    expect(screen.getByRole("img")).toBeDefined();
  });

  // A screen reader cannot read an SVG path and this chart has no hover to
  // fall back on, so the whole series has to be in the accessible name.
  it("describes the whole series for a screen reader", async () => {
    renderPage();
    await settle();

    const chart = screen.getByRole("img");
    expect(chart.getAttribute("aria-labelledby")).toBeTruthy();
    expect(chart.textContent).toContain("Backend Engineer");
    expect(chart.textContent).toContain("3");
    expect(chart.textContent).toContain("8");
  });

  // Colour is never the only channel: the direction is a word as well.
  it("states the direction in words, not colour alone", async () => {
    renderPage();
    await settle();

    expect(screen.getByText(MESSAGES.COACH_DIRECTION_IMPROVING)).toBeDefined();
  });

  it.each([
    ["improving", MESSAGES.COACH_DIRECTION_IMPROVING],
    ["declining", MESSAGES.COACH_DIRECTION_DECLINING],
    ["flat", MESSAGES.COACH_DIRECTION_FLAT],
  ] as const)("labels a %s trend", async (direction, label) => {
    const base = report();
    nextResult = {
      ...base,
      trends: base.trends.map((trend) => ({ ...trend, direction })),
    };
    renderPage();
    await settle();

    expect(screen.getByText(label)).toBeDefined();
  });

  it("shows the coach's summary sentence", async () => {
    renderPage();
    await settle();

    expect(
      screen.getByText("You are getting steadier at explaining your own systems.")
    ).toBeDefined();
  });
});

describe("the roadmap", () => {
  // An <ol>, not a <ul>: priority 1 is where to start, so the order carries
  // meaning a screen reader should be told about rather than left to infer
  // from a decorative number. Asserted on the tag because the focus points
  // inside each item are a list too, and only one of the two is ordered.
  it("is an ordered list, because the order is the content", async () => {
    renderPage();
    await settle();

    const lists = screen.getAllByRole("list");
    expect(lists.some((list) => list.tagName.toLowerCase() === "ol")).toBe(true);
  });

  it("renders the items in priority order", async () => {
    nextResult = report({
      roadmap: [
        {
          topic: "Weakest",
          avgScore: 2,
          track: "communication",
          confidence: "confident",
          focusPoints: [],
          priority: 1,
        },
        {
          topic: "Strongest",
          avgScore: 9,
          track: "technical",
          confidence: "tentative",
          focusPoints: [],
          priority: 2,
        },
      ],
      trends: [],
    });
    renderPage();
    await settle();

    const items = screen.getAllByRole("listitem");
    expect(items[0]?.textContent).toContain("Weakest");
    expect(items[1]?.textContent).toContain("Strongest");
  });

  // A track name on its own teaches nothing. The anchor is what makes the
  // focus points read as a consequence rather than as unrelated advice.
  it("explains what each track actually means", async () => {
    renderPage();
    await settle();

    expect(screen.getByText(MESSAGES.COACH_TRACK_LABEL.communication)).toBeDefined();
    expect(screen.getByText(MESSAGES.COACH_TRACK_ANCHOR.communication)).toBeDefined();
    expect(screen.getByText(MESSAGES.COACH_TRACK_LABEL.technical)).toBeDefined();
  });

  // The honest half of the design, and it has to be visible rather than buried
  // in the prose: one of these rests on a number scored on every answer, the
  // other on a pattern read off whichever questions came up.
  it("marks which advice is measured and which is inferred", async () => {
    renderPage();
    await settle();

    expect(screen.getByText(MESSAGES.COACH_CONFIDENCE_LABEL.confident)).toBeDefined();
    expect(screen.getByText(MESSAGES.COACH_CONFIDENCE_LABEL.tentative)).toBeDefined();
  });

  // A tooltip is invisible on a touch screen, so the sentence is on the page
  // too — it is what stops "Inferred" reading as a criticism.
  it("spells out what inferred means, not only in a tooltip", async () => {
    renderPage();
    await settle();

    expect(
      screen.getByText(MESSAGES.COACH_CONFIDENCE_ANCHOR.tentative)
    ).toBeDefined();
  });

  it("shows both tracks for one topic", async () => {
    renderPage();
    await settle();

    // Counted off the <ol> rather than every listitem on the page: the focus
    // points inside each card are list items too.
    const ordered = screen
      .getAllByRole("list")
      .find((list) => list.tagName.toLowerCase() === "ol");
    expect(ordered?.children.length).toBe(2);
  });

  it("shows the average to one decimal", async () => {
    renderPage();
    await settle();

    expect(screen.getByText("5.5")).toBeDefined();
  });

  // The generation failed and the numbers survived. An empty gap would read as
  // a loading state that never resolved.
  it("says so when there are no suggestions rather than leaving a gap", async () => {
    const base = report();
    nextResult = {
      ...base,
      roadmap: base.roadmap.map((item) => ({ ...item, focusPoints: [] })),
    };
    renderPage();
    await settle();

    // Once per track, since both were emptied.
    expect(screen.getAllByText(MESSAGES.COACH_NO_FOCUS_POINTS)).toHaveLength(2);
  });
});

describe("a failed load", () => {
  it("shows the cause and a retry", async () => {
    nextResult = new Error("Network unreachable");
    renderPage();
    await settle();

    expect(screen.getByText(MESSAGES.COACH_LOAD_FAILED)).toBeDefined();
    expect(
      screen.getByRole("button", { name: new RegExp(MESSAGES.RETRY, "i") })
    ).toBeDefined();
  });

  it("refetches when retry is pressed", async () => {
    nextResult = new Error("Network unreachable");
    renderPage();
    await settle();

    fetchCoachReport.mockClear();
    screen
      .getByRole("button", { name: new RegExp(MESSAGES.RETRY, "i") })
      .click();

    expect(fetchCoachReport).toHaveBeenCalledTimes(1);
  });

  // A failure is its own screen, never mistaken for "nothing to coach" — one
  // says try again, the other says go and do an interview.
  it("is never mistaken for an empty report", async () => {
    nextResult = new Error("Network unreachable");
    renderPage();
    await settle();

    expect(screen.queryByText(MESSAGES.COACH_EMPTY_TITLE)).toBeNull();
  });
});
