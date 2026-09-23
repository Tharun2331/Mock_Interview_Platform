import { describe, expect, it } from "bun:test";
import type { GapRequirement } from "@repo/shared";
import { repairRequirements } from "../../agents/gap";

// Every fixture here is real output, copied from analyses the dev table already
// holds. The model was told both rules in its system prompt and broke them
// anyway, which is why this pass is deterministic rather than a second attempt.

describe("evidence that names an absence", () => {
  // The one that mattered most. Bucketed `strong`, so the interview would have
  // spent a question CONFIRMING a build tool the resume never names.
  it("demotes a 'strong' whose evidence says the thing was not mentioned", () => {
    const [repaired] = repairRequirements([
      {
        requirement:
          "Familiarity with build tools such as Webpack, Rspack, or Vite.",
        bucket: "strong",
        evidence:
          "Webpack, Rspack, or Vite not explicitly mentioned, but strong DevOps experience.",
      },
    ]);

    expect(repaired?.bucket).toBe("none");
  });

  it.each([
    ["not mentioned"],
    ["not mentioned anywhere"],
    ["No explicit mention of DOM manipulation or HTTP protocol deep dive."],
    ["No direct evidence of CSS expertise beyond HTML5/CSS3."],
    ["No explicit evidence of cross-functional platform improvements."],
    ["Vite is never named in the resume."],
    ["Resume lacks any reference to accessibility work."],
  ])("reads %p as an absence", (evidence) => {
    const [repaired] = repairRequirements([
      { requirement: "Some requirement", bucket: "strong", evidence },
    ]);

    expect(repaired?.bucket).toBe("none");
  });

  // Deliberately narrow. A note can contain "no" and still be evidence FOR the
  // requirement, and demoting those would invent gaps the candidate does not
  // have — the same error in the other direction.
  it.each([
    ["React, Redux, TypeScript, and Jest experience."],
    ["Three years of React at EY, no gaps in the timeline."],
    ["Node.js and Express across two production services."],
    ["Master's in Computer Science and Bachelor's in Information Science."],
  ])("leaves %p alone", (evidence) => {
    const [repaired] = repairRequirements([
      { requirement: "Some requirement", bucket: "strong", evidence },
    ]);

    expect(repaired?.bucket).toBe("strong");
  });

  it("does not touch a bucket that was already 'none'", () => {
    const items: GapRequirement[] = [
      { requirement: "Kubernetes", bucket: "none", evidence: "not mentioned" },
    ];

    expect(repairRequirements(items)).toEqual(items);
  });
});

describe("a requirement emitted twice", () => {
  // Straight from session 01M2NP7D…: the same build-tools line appears alone as
  // `none` and folded into a longer line as `strong`. One requirement cannot be
  // both answered and unanswered.
  it("collapses a line that restates a longer one", () => {
    const repaired = repairRequirements([
      {
        requirement:
          "Familiarity with build tools such as Webpack, Rspack, or Vite and exposure to Node.js, server-side rendering techniques, or frameworks such as Next.js or Remix.",
        bucket: "strong",
        evidence: "Next.js experience in projects and resume.",
      },
      {
        requirement:
          "Familiarity with build tools such as Webpack, Rspack, or Vite.",
        bucket: "none",
        evidence: "No explicit mention of Webpack, Rspack, or Vite in resume.",
      },
    ]);

    expect(repaired).toHaveLength(1);
  });

  // The weaker bucket wins: a false `none` costs a question the candidate
  // answers well, a false `strong` costs the gap the interview existed to find.
  it("resolves the conflict to the weaker bucket and its evidence", () => {
    const [repaired] = repairRequirements([
      {
        requirement:
          "Minimum 3 years of experience in Web development and a solid understanding of JavaScript, CSS, DOM, and HTTP protocol.",
        bucket: "strong",
        evidence: "3 years of web development, React, TypeScript, and Jest.",
      },
      {
        requirement:
          "Solid understanding of JavaScript, CSS, DOM, and HTTP protocol.",
        bucket: "none",
        evidence: "No explicit mention of HTTP protocol or DOM manipulation.",
      },
    ]);

    expect(repaired?.bucket).toBe("none");
    expect(repaired?.evidence).toContain("HTTP protocol");
  });

  // The shorter wording survives, because it is the one an interviewer can
  // actually ask a single question about.
  it("keeps the more discrete wording", () => {
    const [repaired] = repairRequirements([
      {
        requirement:
          "Familiarity with build tools such as Webpack, Rspack, or Vite and exposure to Node.js and server-side rendering.",
        bucket: "strong",
        evidence: "Next.js experience.",
      },
      {
        requirement:
          "Familiarity with build tools such as Webpack, Rspack, or Vite.",
        bucket: "none",
        evidence: "Not named in the resume.",
      },
    ]);

    expect(repaired?.requirement).toBe(
      "Familiarity with build tools such as Webpack, Rspack, or Vite.",
    );
  });

  it("collapses the pair whichever order they arrive in", () => {
    const short: GapRequirement = {
      requirement:
        "Solid understanding of JavaScript, CSS, DOM, and HTTP protocol.",
      bucket: "none",
      evidence: "No explicit mention of HTTP protocol.",
    };
    const long: GapRequirement = {
      requirement:
        "Minimum 3 years of Web development and a solid understanding of JavaScript, CSS, DOM, and HTTP protocol.",
      bucket: "strong",
      evidence: "Three years of React and Node.",
    };

    expect(repairRequirements([short, long])).toHaveLength(1);
    expect(repairRequirements([long, short])).toHaveLength(1);
  });
});

describe("requirements that only look alike", () => {
  // The hazard the length floor exists for: "experience with react" sits inside
  // "experience with react native", and those are two different requirements.
  it("keeps two short requirements where one is a substring of the other", () => {
    const repaired = repairRequirements([
      {
        requirement: "Experience with React",
        bucket: "strong",
        evidence: "3 years",
      },
      {
        requirement: "Experience with React Native",
        bucket: "weak",
        evidence: "one Expo project",
      },
    ]);

    expect(repaired).toHaveLength(2);
  });

  it("keeps requirements that merely share vocabulary", () => {
    const repaired = repairRequirements([
      {
        requirement:
          "Solid understanding of CSS and responsive layout systems.",
        bucket: "weak",
        evidence: "Tailwind in two projects.",
      },
      {
        requirement: "Solid understanding of the DOM and the HTTP protocol.",
        bucket: "none",
        evidence: "No explicit mention.",
      },
    ]);

    expect(repaired).toHaveLength(2);
  });

  it("leaves a clean analysis untouched", () => {
    const items: GapRequirement[] = [
      { requirement: "Kubernetes", bucket: "none", evidence: "not mentioned" },
      {
        requirement: "Kafka",
        bucket: "strong",
        evidence: "order-service consumers",
      },
      {
        requirement: "Terraform",
        bucket: "weak",
        evidence: "cloud work, no IaC named",
      },
    ];

    // The Terraform note says "no IaC named" — an absence, so it earns the
    // demotion. Everything else survives as written.
    const repaired = repairRequirements(items);
    expect(repaired).toHaveLength(3);
    expect(repaired[0]?.bucket).toBe("none");
    expect(repaired[1]?.bucket).toBe("strong");
  });

  it("returns an empty list for an empty analysis", () => {
    expect(repairRequirements([])).toEqual([]);
  });
});
