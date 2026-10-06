import { describe, expect, it } from "bun:test";
import type { GuardrailTraceAssessment } from "@aws-sdk/client-bedrock-runtime";
import {
  guardrailConfiguration,
  guardrailFindings,
  resolveGuardrail,
  userTurnContent,
  wasGuardrailBlocked,
} from "../../lib/guardrail";
import { BedrockError, GuardrailBlockedError } from "../../lib/errors";

describe("resolveGuardrail", () => {
  it("returns settings only when both id and version are set", () => {
    expect(resolveGuardrail("gr-123", "1")).toEqual({
      id: "gr-123",
      version: "1",
    });
  });

  // An id with no version would call DRAFT, which can change under a running
  // service. ADR-0010 pins a number, so half a configuration is no guardrail.
  it("returns undefined when either half is missing", () => {
    expect(resolveGuardrail("gr-123", "")).toBeUndefined();
    expect(resolveGuardrail("", "1")).toBeUndefined();
    expect(resolveGuardrail("", "")).toBeUndefined();
  });
});

describe("guardrailConfiguration", () => {
  // Detect mode reports only through the trace; without it, findings vanish.
  it("always asks for the trace", () => {
    expect(guardrailConfiguration({ id: "gr-123", version: "2" })).toEqual({
      guardrailIdentifier: "gr-123",
      guardrailVersion: "2",
      trace: "enabled",
    });
  });
});

describe("userTurnContent", () => {
  it("is a plain text block when no guardrail is attached", () => {
    expect(userTurnContent("hello", false)).toEqual([{ text: "hello" }]);
  });

  // Once any guardContent is present Converse assesses only that, which is
  // what keeps the system prompt and the exemplars out of the scan.
  it("wraps the turn in guardContent when guarded", () => {
    expect(userTurnContent("hello", true)).toEqual([
      { guardContent: { text: { text: "hello" } } },
    ]);
  });
});

describe("wasGuardrailBlocked", () => {
  it("recognises the intervention stop reason and nothing else", () => {
    expect(wasGuardrailBlocked("guardrail_intervened")).toBe(true);
    expect(wasGuardrailBlocked("end_turn")).toBe(false);
    expect(wasGuardrailBlocked("tool_use")).toBe(false);
    expect(wasGuardrailBlocked(undefined)).toBe(false);
  });
});

describe("guardrailFindings", () => {
  it("is empty without a trace", () => {
    expect(guardrailFindings(undefined)).toEqual([]);
  });

  // Detect mode: action NONE, detected true. The finding still has to be
  // reported, or detect mode tells nobody anything.
  it("reports a detect-mode hit whose action is NONE", () => {
    const trace: GuardrailTraceAssessment = {
      inputAssessment: {
        "gr-123": {
          contentPolicy: {
            filters: [
              {
                type: "PROMPT_ATTACK",
                confidence: "HIGH",
                action: "NONE",
                detected: true,
              },
            ],
          },
        },
      },
    };

    expect(guardrailFindings(trace)).toEqual([
      "input content:PROMPT_ATTACK=NONE",
    ]);
  });

  it("ignores filters that were evaluated but found nothing", () => {
    const trace: GuardrailTraceAssessment = {
      inputAssessment: {
        "gr-123": {
          contentPolicy: {
            filters: [
              {
                type: "VIOLENCE",
                confidence: "NONE",
                action: "NONE",
                detected: false,
              },
            ],
          },
        },
      },
    };

    expect(guardrailFindings(trace)).toEqual([]);
  });

  it("reports blocks, topics and PII across input and output", () => {
    const trace: GuardrailTraceAssessment = {
      inputAssessment: {
        "gr-123": {
          topicPolicy: {
            topics: [{ name: "Legal advice", type: "DENY", action: "BLOCKED" }],
          },
        },
      },
      outputAssessments: {
        "gr-123": [
          {
            contentPolicy: {
              filters: [
                { type: "INSULTS", confidence: "MEDIUM", action: "BLOCKED" },
              ],
            },
            sensitiveInformationPolicy: {
              piiEntities: [
                {
                  match: "jane@example.com",
                  type: "EMAIL",
                  action: "ANONYMIZED",
                  detected: true,
                },
              ],
              regexes: [],
            },
          },
        ],
      },
    };

    expect(guardrailFindings(trace)).toEqual([
      "input topic:Legal advice=BLOCKED",
      "output content:INSULTS=BLOCKED",
      "output pii:EMAIL=ANONYMIZED",
    ]);
  });

  // A PII finding's `match` IS the personal data. It must never reach a log.
  it("never includes the matched text", () => {
    const trace: GuardrailTraceAssessment = {
      outputAssessments: {
        "gr-123": [
          {
            sensitiveInformationPolicy: {
              piiEntities: [
                {
                  match: "416-555-0199",
                  type: "PHONE",
                  action: "NONE",
                  detected: true,
                },
              ],
              regexes: [],
            },
          },
        ],
      },
    };

    const findings = guardrailFindings(trace).join(" ");
    expect(findings).toContain("pii:PHONE");
    expect(findings).not.toContain("416-555-0199");
  });
});

describe("GuardrailBlockedError", () => {
  // Routes map BedrockError to a generic failure; a block must land there too.
  it("is a BedrockError, so existing route handling applies", () => {
    const error = new GuardrailBlockedError("blocked", ["model-a"]);
    expect(error).toBeInstanceOf(BedrockError);
    expect(error.name).toBe("GuardrailBlockedError");
    expect(error.modelsTried).toEqual(["model-a"]);
  });
});
