import { useEffect } from "react";
import { Link, useLocation } from "react-router";

import { BrandMark } from "@/components/BrandMark";
import { Eyebrow } from "@/components/Eyebrow";
import { ThemeToggle } from "@/components/ThemeToggle";
import { LEGAL, type LegalBlock, type LegalDoc } from "@/lib/legal";
import { MESSAGES } from "@/lib/messages";

// One renderer for both legal documents, so the privacy policy and the terms
// cannot drift into two different reading experiences.
//
// A reading surface, not an identity one: the job is that someone deciding
// whether to trust us with a resume can find the answer quickly. So the body
// stays in the sans face at a comfortable measure, the display serif appears
// once in the title, and the table of contents is a plain list of anchors.
//
// It sits outside every auth guard and outside the AppShell. Someone has to be
// able to read the terms before they have an account, and a signed-in user
// following the footer link should not be bounced through onboarding to do it.

function Block({ block }: { block: LegalBlock }) {
  switch (block.kind) {
    case "p":
      return <p>{block.text}</p>;
    case "list":
      return (
        <ul className="list-disc space-y-2 pl-5 marker:text-ink-faint">
          {block.items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      );
    case "table":
      return (
        // The table scrolls inside its own frame rather than widening the
        // page, so the layout still holds at 375px.
        <div className="overflow-x-auto rounded-lg border border-hairline">
          <table className="w-full min-w-[36rem] border-collapse text-left text-sm">
            <caption className="sr-only">{block.caption}</caption>
            <thead>
              <tr className="border-b border-hairline bg-muted/40">
                {block.head.map((heading) => (
                  <th
                    key={heading}
                    scope="col"
                    className="px-4 py-3 font-medium text-ink"
                  >
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row) => (
                <tr
                  key={row[0]}
                  className="border-b border-hairline align-top last:border-b-0"
                >
                  {/* The first column names the row, so it is the row header
                      a screen reader announces before each cell. */}
                  <th scope="row" className="w-[38%] px-4 py-3 font-normal text-ink">
                    {row[0]}
                  </th>
                  <td className="px-4 py-3">{row[1]}</td>
                  <td className="px-4 py-3">{row[2]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "contact":
      return (
        <p>
          {MESSAGES.LEGAL_CONTACT_LEAD}{" "}
          <a
            href={`mailto:${LEGAL.CONTACT_EMAIL}`}
            className="text-cue-ink underline underline-offset-4"
          >
            {LEGAL.CONTACT_EMAIL}
          </a>
          .
        </p>
      );
  }
}

export function LegalDocument({ doc }: { doc: LegalDoc }) {
  const { hash } = useLocation();

  // The document is locked to the viewport and this page owns its own scroll
  // region, so the browser's native jump to a #fragment does not happen on
  // load. Done by hand for links like /privacy#collect.
  useEffect(() => {
    if (!hash) return;
    document.getElementById(hash.slice(1))?.scrollIntoView();
  }, [hash]);

  return (
    <div className="h-full w-full overflow-y-auto bg-background">
      <header className="mx-auto flex w-full max-w-3xl items-center justify-between px-4 pt-6 sm:px-6">
        <Link to="/" aria-label={MESSAGES.LEGAL_HOME_LABEL}>
          <BrandMark />
        </Link>
        <ThemeToggle />
      </header>

      <main className="mx-auto w-full max-w-3xl px-4 pb-20 pt-12 sm:px-6">
        <Eyebrow as="p">
          {MESSAGES.LEGAL_EFFECTIVE} {LEGAL.EFFECTIVE_DATE}
        </Eyebrow>
        <h1 className="mt-3 font-display text-5xl leading-tight text-ink">
          {doc.title}
        </h1>
        <p className="mt-5 max-w-2xl text-base leading-relaxed text-ink-muted">
          {doc.summary}
        </p>

        <nav
          aria-label={MESSAGES.LEGAL_CONTENTS}
          className="mt-10 border-y border-hairline py-6"
        >
          <Eyebrow as="h2">{MESSAGES.LEGAL_CONTENTS}</Eyebrow>
          <ol className="mt-4 grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
            {doc.sections.map((section, index) => (
              <li key={section.id} className="flex gap-3">
                <span className="font-mono text-xs text-ink-faint tabular-nums">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <a
                  href={`#${section.id}`}
                  className="text-ink-muted underline-offset-4 hover:text-ink hover:underline"
                >
                  {section.title}
                </a>
              </li>
            ))}
          </ol>
        </nav>

        <div className="mt-12 flex flex-col gap-12">
          {doc.sections.map((section, index) => (
            <section key={section.id} aria-labelledby={section.id}>
              <h2
                id={section.id}
                className="flex scroll-mt-6 items-baseline gap-3 text-xl font-medium text-ink"
              >
                <span className="font-mono text-xs text-ink-faint tabular-nums">
                  {String(index + 1).padStart(2, "0")}
                </span>
                {section.title}
              </h2>
              <div className="mt-4 flex flex-col gap-4 text-[0.95rem] leading-relaxed text-ink-muted">
                {section.blocks.map((block, blockIndex) => (
                  // Blocks are static content that never reorders, so the
                  // position is a stable key here.
                  <Block key={blockIndex} block={block} />
                ))}
              </div>
            </section>
          ))}
        </div>

        <footer className="mt-16 flex flex-wrap gap-x-6 gap-y-2 border-t border-hairline pt-6 text-sm text-ink-subtle">
          <Link to="/privacy" className="hover:text-ink">
            {MESSAGES.LEGAL_PRIVACY}
          </Link>
          <Link to="/terms" className="hover:text-ink">
            {MESSAGES.LEGAL_TERMS}
          </Link>
        </footer>
      </main>
    </div>
  );
}
