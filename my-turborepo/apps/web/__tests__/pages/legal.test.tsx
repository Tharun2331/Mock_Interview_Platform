import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";

import { LegalNotice } from "@/components/LegalNotice";
import { LEGAL, PRIVACY_POLICY, TERMS_OF_SERVICE } from "@/lib/legal";
import { Privacy } from "@/pages/privacy";
import { Terms } from "@/pages/terms";

afterEach(cleanup);

function renderAt(ui: React.ReactNode) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe("the legal documents", () => {
  it("gives every section a unique id, so anchors cannot collide", () => {
    for (const doc of [PRIVACY_POLICY, TERMS_OF_SERVICE]) {
      const ids = doc.sections.map((section) => section.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("renders the privacy policy with its collection table and a contact link", () => {
    renderAt(<Privacy />);

    expect(
      screen.getByRole("heading", { level: 1, name: "Privacy Policy" }),
    ).toBeDefined();
    // The sign-up notice and the policy's own contents link to this anchor.
    expect(document.getElementById("collect")).not.toBeNull();

    const table = screen.getByRole("table");
    // One row per category, plus the header row.
    const collected = PRIVACY_POLICY.sections.find((s) => s.id === "collect");
    const block = collected?.blocks.find((b) => b.kind === "table");
    const rowCount = block?.kind === "table" ? block.rows.length : 0;
    expect(within(table).getAllByRole("row")).toHaveLength(rowCount + 1);

    const mail = screen.getByRole("link", { name: LEGAL.CONTACT_EMAIL });
    expect(mail.getAttribute("href")).toBe(`mailto:${LEGAL.CONTACT_EMAIL}`);
  });

  it("states that voice audio is not stored", () => {
    renderAt(<Privacy />);
    expect(screen.getByText(/discarded as the interview runs/)).toBeDefined();
  });

  it("renders the terms with a contents entry for every section", () => {
    renderAt(<Terms />);

    const contents = screen.getByRole("navigation", { name: "Contents" });
    expect(within(contents).getAllByRole("link")).toHaveLength(
      TERMS_OF_SERVICE.sections.length,
    );
  });
});

describe("the agreement notice", () => {
  it("links both documents", () => {
    renderAt(<LegalNotice />);

    expect(
      screen.getByRole("link", { name: "Terms of Service" }).getAttribute("href"),
    ).toBe("/terms");
    expect(
      screen.getByRole("link", { name: "Privacy Policy" }).getAttribute("href"),
    ).toBe("/privacy");
  });
});
