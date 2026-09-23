import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { GAP_LIMITS, type PlanResponse } from "@repo/shared";
// The SHARED profile stub. `@/lib/profile` is one module and a second
// mock.module registration replaces this one for every file loaded afterwards.
import {
  COMPLETE_PROFILE,
  resetProfileStub,
  setProfileState,
} from "../helpers/profileStub";

// `@/lib/api` is the leaf that talks to the outside world, which is the right
// thing to mock — the page itself is the subject here.
type PostCall = { url: string; body: unknown };

const posted: PostCall[] = [];
let planFailure: Error | null = null;

const PLAN: PlanResponse = {
  focusAreas: [
    { area: "Kafka", evidence: "order-service consumers", source: "github" },
  ],
  questionMix: { behavioural: 3, technical: 5, roleSpecific: 2 },
  startingDifficulty: "mid",
  targetMinutes: 30,
  reasoning: "single-service distributed work",
};

const post = mock(async (url: string, body?: unknown) => {
  posted.push({ url, body });
  if (url.endsWith("/pre-interview")) {
    return { data: { sessionId: "01J000000000000000000000" } };
  }
  if (planFailure !== null) throw planFailure;
  return { data: PLAN };
});

mock.module("@/lib/api", () => ({ api: { post } }));

const { StartInterview } = await import("@/pages/startInterview");
const { MESSAGES } = await import("@/lib/messages");
const { MemoryRouter, Route, Routes } = await import("react-router");

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/start"]}>
      <Routes>
        <Route path="/start" element={<StartInterview />} />
        <Route path="/interview" element={<p>interview page</p>} />
        <Route path="/profile" element={<p>profile page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

function jobDescriptionField(): HTMLTextAreaElement {
  const field = screen.getByLabelText(MESSAGES.START_JD_LABEL);
  if (!(field instanceof HTMLTextAreaElement)) {
    throw new Error("the job description field is not a textarea");
  }
  return field;
}

function submit() {
  fireEvent.click(screen.getByRole("button", { name: MESSAGES.START_SUBMIT }));
}

/** The body of the POST /plan call, once it has been made. */
async function planBody(): Promise<Record<string, unknown>> {
  await waitFor(() => {
    expect(posted.some((call) => call.url.endsWith("/plan"))).toBe(true);
  });
  const call = posted.find((entry) => entry.url.endsWith("/plan"));
  return (call?.body ?? {}) as Record<string, unknown>;
}

beforeEach(() => {
  posted.length = 0;
  planFailure = null;
  post.mockClear();
  resetProfileStub();
  setProfileState({ status: "ready", profile: COMPLETE_PROFILE });
});

afterEach(cleanup);

describe("the job description field", () => {
  // It was reachable from nowhere for a while: the route accepted the field and
  // no screen offered it, so the Gap agent could never run in the product.
  it("is on the page", () => {
    renderPage();

    expect(jobDescriptionField()).toBeDefined();
  });

  // Marked optional in the UI because it is optional in the schema. An
  // unmarked empty field reads as something the candidate forgot.
  it("says it is optional", () => {
    renderPage();

    expect(screen.getByText(MESSAGES.START_JD_OPTIONAL)).toBeDefined();
  });

  it("explains what pasting one changes", () => {
    renderPage();

    expect(screen.getByText(MESSAGES.START_JD_HINT)).toBeDefined();
  });
});

describe("what reaches POST /plan", () => {
  it("sends the posting when one was pasted", async () => {
    renderPage();

    fireEvent.change(screen.getByLabelText(MESSAGES.FORM_ROLE_LABEL), {
      target: { value: "Backend Engineer" },
    });
    fireEvent.change(jobDescriptionField(), {
      target: { value: "We need Kubernetes and Kafka experience." },
    });
    submit();

    expect((await planBody()).jobDescription).toBe(
      "We need Kubernetes and Kafka experience.",
    );
  });

  // Omitted, not sent empty. `""` fails the route's `.min(1)` and would 400 the
  // whole plan over a field nobody filled in.
  it("omits the key entirely when the field is untouched", async () => {
    renderPage();

    fireEvent.change(screen.getByLabelText(MESSAGES.FORM_ROLE_LABEL), {
      target: { value: "Backend Engineer" },
    });
    submit();

    expect("jobDescription" in (await planBody())).toBe(false);
  });

  // Whitespace is not a posting. Sending it would mint a Bedrock call whose
  // only possible output is noise.
  it("treats a whitespace-only posting as no posting", async () => {
    renderPage();

    fireEvent.change(screen.getByLabelText(MESSAGES.FORM_ROLE_LABEL), {
      target: { value: "Backend Engineer" },
    });
    fireEvent.change(jobDescriptionField(), { target: { value: "   \n  " } });
    submit();

    expect("jobDescription" in (await planBody())).toBe(false);
  });

  it("trims the posting rather than sending the surrounding blank lines", async () => {
    renderPage();

    fireEvent.change(screen.getByLabelText(MESSAGES.FORM_ROLE_LABEL), {
      target: { value: "Backend Engineer" },
    });
    fireEvent.change(jobDescriptionField(), {
      target: { value: "\n\n  Kubernetes and Kafka.  \n" },
    });
    submit();

    expect((await planBody()).jobDescription).toBe("Kubernetes and Kafka.");
  });

  // The posting is state on the page, not on the failed call, so retrying the
  // plan against the same session must carry it along.
  it("still carries the posting when the plan is retried", async () => {
    planFailure = new Error("model unavailable");
    renderPage();

    fireEvent.change(screen.getByLabelText(MESSAGES.FORM_ROLE_LABEL), {
      target: { value: "Backend Engineer" },
    });
    fireEvent.change(jobDescriptionField(), {
      target: { value: "Kubernetes and Kafka." },
    });
    submit();

    const retry = await screen.findByRole("button", {
      name: MESSAGES.PLAN_FAILED_RETRY,
    });
    planFailure = null;
    posted.length = 0;
    fireEvent.click(retry);

    expect((await planBody()).jobDescription).toBe("Kubernetes and Kafka.");
  });
});

describe("a posting longer than the model will read", () => {
  const TOO_LONG = "x".repeat(GAP_LIMITS.MAX_JOB_DESCRIPTION_CHARS + 1);

  // Caught here rather than by the server, so an over-long paste costs a
  // correction instead of a minted session and a 400 against it.
  it("blocks the submit rather than minting a session", () => {
    renderPage();

    fireEvent.change(screen.getByLabelText(MESSAGES.FORM_ROLE_LABEL), {
      target: { value: "Backend Engineer" },
    });
    fireEvent.change(jobDescriptionField(), { target: { value: TOO_LONG } });
    submit();

    expect(posted).toHaveLength(0);
  });

  it("says so, and says what to do about it", () => {
    renderPage();

    fireEvent.change(jobDescriptionField(), { target: { value: TOO_LONG } });

    expect(screen.getByText(MESSAGES.START_JD_TOO_LONG)).toBeDefined();
    expect(jobDescriptionField().getAttribute("aria-invalid")).toBe("true");
  });

  // The cap is the schema's, imported rather than retyped — a second copy of
  // the number is a second place for it to drift.
  it("accepts a posting exactly at the cap", async () => {
    renderPage();

    fireEvent.change(screen.getByLabelText(MESSAGES.FORM_ROLE_LABEL), {
      target: { value: "Backend Engineer" },
    });
    fireEvent.change(jobDescriptionField(), {
      target: { value: "y".repeat(GAP_LIMITS.MAX_JOB_DESCRIPTION_CHARS) },
    });
    submit();

    expect(String((await planBody()).jobDescription)).toHaveLength(
      GAP_LIMITS.MAX_JOB_DESCRIPTION_CHARS,
    );
  });
});

// Gated on the posting, exactly as the server is: without one the Company
// Intel agent never runs, so offering the input any earlier would be offering
// a field that silently does nothing.
describe("the company fields", () => {
  function fillRole() {
    fireEvent.change(screen.getByLabelText(MESSAGES.FORM_ROLE_LABEL), {
      target: { value: "Backend Engineer" },
    });
  }

  function pasteJd(value = "We need Kubernetes and Kafka experience.") {
    fireEvent.change(jobDescriptionField(), { target: { value } });
  }

  it("are hidden until a posting is pasted", () => {
    renderPage();

    expect(screen.queryByLabelText(MESSAGES.START_COMPANY_LABEL)).toBeNull();
  });

  it("appear once a posting is pasted", () => {
    renderPage();
    pasteJd();

    expect(screen.getByLabelText(MESSAGES.START_COMPANY_LABEL)).toBeDefined();
  });

  it("disappear again if the posting is cleared", () => {
    renderPage();
    pasteJd();
    pasteJd("");

    expect(screen.queryByLabelText(MESSAGES.START_COMPANY_LABEL)).toBeNull();
  });

  // Notes about nobody are notes the interview cannot attach to anything.
  it("ask for notes only once a company is named", () => {
    renderPage();
    pasteJd();

    expect(
      screen.queryByLabelText(MESSAGES.START_COMPANY_NOTES_LABEL),
    ).toBeNull();

    fireEvent.change(screen.getByLabelText(MESSAGES.START_COMPANY_LABEL), {
      target: { value: "Stripe" },
    });

    expect(
      screen.getByLabelText(MESSAGES.START_COMPANY_NOTES_LABEL),
    ).toBeDefined();
  });

  it("says the candidate's own notes are what shapes the tone", () => {
    renderPage();
    pasteJd();
    fireEvent.change(screen.getByLabelText(MESSAGES.START_COMPANY_LABEL), {
      target: { value: "Stripe" },
    });

    expect(screen.getByText(MESSAGES.START_COMPANY_NOTES_HINT)).toBeDefined();
  });

  it("sends the company and the notes when both were filled in", async () => {
    renderPage();
    fillRole();
    pasteJd();
    fireEvent.change(screen.getByLabelText(MESSAGES.START_COMPANY_LABEL), {
      target: { value: "  Stripe  " },
    });
    fireEvent.change(
      screen.getByLabelText(MESSAGES.START_COMPANY_NOTES_LABEL),
      {
        target: { value: "Recruiter said two rounds." },
      },
    );
    submit();

    const body = await planBody();
    expect(body.companyName).toBe("Stripe");
    expect(body.companyNotes).toBe("Recruiter said two rounds.");
  });

  it("omits both keys when no company was named", async () => {
    renderPage();
    fillRole();
    pasteJd();
    submit();

    const body = await planBody();
    expect("companyName" in body).toBe(false);
    expect("companyNotes" in body).toBe(false);
  });

  // The field is unreachable without a posting, but the guard is asserted on
  // the body as well: a state left behind by clearing the posting must not
  // send a company the server would then refuse to research.
  it("omits the company when the posting was cleared after typing one", async () => {
    renderPage();
    fillRole();
    pasteJd();
    fireEvent.change(screen.getByLabelText(MESSAGES.START_COMPANY_LABEL), {
      target: { value: "Stripe" },
    });
    pasteJd("");
    submit();

    expect("companyName" in (await planBody())).toBe(false);
  });
});

// The role is the only required field, and the posting must not have changed
// that — an interview with no posting is the path this product had all along.
describe("the role field it sits beside", () => {
  it("still refuses an empty role, posting or not", () => {
    renderPage();

    fireEvent.change(jobDescriptionField(), {
      target: { value: "Kubernetes and Kafka." },
    });
    submit();

    expect(posted).toHaveLength(0);
    expect(screen.getByText(MESSAGES.FORM_ROLE_REQUIRED)).toBeDefined();
  });

  it("plans a session with a role and no posting at all", async () => {
    renderPage();

    fireEvent.change(screen.getByLabelText(MESSAGES.FORM_ROLE_LABEL), {
      target: { value: "Backend Engineer" },
    });
    submit();

    expect((await planBody()).targetRole).toBe("Backend Engineer");
  });
});
