import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
// The SHARED profile stub — Header calls useProfile to decide whether to show
// the history link. See the helper's header for why it is not registered here.
import {
  COMPLETE_PROFILE,
  resetProfileStub,
  setProfileState,
} from "../helpers/profileStub";

const { AppShell } = await import("@/components/layout/AppShell");
const { MemoryRouter, Route, Routes } = await import("react-router");

// Class assertions, which is unusual and deliberate. happy-dom has no layout
// engine, so there is no scrollHeight to measure — but the shell's behaviour is
// entirely carried by four utilities, and this has now broken twice: once with
// the footer floating above the bottom, once with the whole document scrolling
// past it into empty background. Pinning the contract is worth more than
// nothing, and the comment says which pixels each class buys.

function renderShell() {
  return render(
    <MemoryRouter initialEntries={["/start"]}>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/start" element={<p>page content</p>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

function shellRoot(): HTMLElement {
  const main = screen.getByRole("main");
  const root = main.parentElement;
  if (root === null) throw new Error("the shell has no root element");
  return root;
}

beforeEach(() => {
  resetProfileStub();
  setProfileState({ status: "ready", profile: COMPLETE_PROFILE });
});

afterEach(cleanup);

describe("the app shell", () => {
  it("renders the routed page between the header and the footer", () => {
    renderShell();

    expect(screen.getByText("page content")).toBeDefined();
    expect(screen.getByRole("banner")).toBeDefined();
    expect(screen.getByRole("contentinfo")).toBeDefined();
  });

  // `h-full`, not `h-screen`. Both are the viewport now that the document is
  // locked, but 100vh counts the horizontal scrollbar's strip as page height,
  // which leaves the shell taller than the box it sits in.
  it("is exactly as tall as what it sits in", () => {
    renderShell();

    expect(shellRoot().className).toContain("h-full");
    expect(shellRoot().className).not.toContain("h-screen");
  });

  // The frame does not scroll — only the region inside it does. Without this
  // the footer travels with the content and the page carries on past it.
  it("does not scroll as a whole", () => {
    renderShell();

    expect(shellRoot().className).toContain("overflow-hidden");
  });

  // min-h-0 is the one that is easy to drop and hard to spot: without it the
  // flex child refuses to shrink below its content, so the scroll escapes to
  // the document and the interview's stop control leaves the screen exactly
  // when someone needs it.
  it("puts the scroll in `main` and lets it shrink", () => {
    renderShell();

    const main = screen.getByRole("main");
    expect(main.className).toContain("overflow-y-auto");
    expect(main.className).toContain("min-h-0");
    expect(main.className).toContain("flex-1");
  });

  // The two bars are fixed by being unshrinkable in a flex column, not by
  // `position: fixed` — so they never overlap the content they frame.
  it("keeps the header and the footer at their full height", () => {
    renderShell();

    expect(screen.getByRole("banner").className).toContain("shrink-0");
    expect(screen.getByRole("contentinfo").className).toContain("shrink-0");
  });
});
