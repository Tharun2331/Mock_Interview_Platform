import { useNavigate } from "react-router";

import { Button } from "@/components/ui/button";
import { MESSAGES } from "@/lib/messages";

// Feedback lands here once the Evaluator and Coach are wired. Until they are,
// this says so plainly.
//
// The alternative was a skeleton of score cards, which would be a lie in the
// shape of a loading state: it promises data that is seconds away when in fact
// nothing is coming yet. A skeleton is for content whose shape is known *and*
// on its way — this is neither.
export function Result() {
  const navigate = useNavigate();

  return (
    <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col items-center justify-center gap-6 p-6 text-center">
      <span className="font-mono text-[0.7rem] uppercase tracking-[0.14em] text-ink-faint">
        {MESSAGES.RESULT_TITLE}
      </span>
      <h2 className="font-display text-3xl text-ink">
        {MESSAGES.RESULT_PENDING_TITLE}
      </h2>
      <p className="max-w-md text-sm leading-relaxed text-ink-muted">
        {MESSAGES.RESULT_PENDING_BODY}
      </p>
      <Button
        variant="outline"
        className="cursor-pointer"
        onClick={() => void navigate("/form")}
      >
        {MESSAGES.RESULT_BACK}
      </Button>
    </div>
  );
}
