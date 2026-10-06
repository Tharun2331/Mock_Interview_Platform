import type {
  ContentBlock,
  GuardrailAssessment,
  GuardrailConfiguration,
  GuardrailTraceAssessment,
} from "@aws-sdk/client-bedrock-runtime";
import { GUARDRAIL } from "./constants";

// The text agents' Bedrock Guardrail, as the Converse calls in lib/bedrock.ts
// use it. ADR-0010 holds the reasoning; this file holds the mechanics.
//
// Its own module, and pure, rather than part of lib/bedrock.ts. Tests replace
// lib/bedrock wholesale (`__tests__/helpers/bedrockStub.ts`), so anything
// living there is unreachable to a test — and the mock.module rule forbids
// working around that by importing it under a different stub.

export type GuardrailSettings = { id: string; version: string };

// Both or nothing. A guardrail id with no version would send DRAFT, which is
// the one version that can change under a running service; ADR-0010 pins a
// number. Neither set is the normal local-development case.
export function resolveGuardrail(
  id: string,
  version: string,
): GuardrailSettings | undefined {
  if (id.length === 0 || version.length === 0) return undefined;
  return { id, version };
}

export function guardrailConfiguration(
  settings: GuardrailSettings,
): GuardrailConfiguration {
  return {
    guardrailIdentifier: settings.id,
    guardrailVersion: settings.version,
    // The trace is what detect mode exists for: it is the only place a
    // non-blocking finding appears.
    trace: "enabled",
  };
}

// The user turn's content. Guarded, it is wrapped in guardContent — and once
// any guardContent is present Converse assesses only that, so the system
// prompt and the few-shot exemplars, which this codebase wrote, are not
// scanned. The model's output is assessed either way.
export function userTurnContent(
  text: string,
  guarded: boolean,
): ContentBlock[] {
  if (!guarded) return [{ text }];
  return [{ guardContent: { text: { text } } }];
}

export function wasGuardrailBlocked(stopReason: string | undefined): boolean {
  return stopReason === GUARDRAIL.INTERVENED_STOP_REASON;
}

// One line per finding, as "<where> <policy>:<type>=<action>".
//
// Never includes what matched. A PII finding's `match` is the personal data
// itself, and a content finding's context is the candidate's own words; a log
// line is not the place for either. The type and the action are what tuning
// needs.
export function guardrailFindings(
  trace: GuardrailTraceAssessment | undefined,
): string[] {
  if (trace === undefined) return [];

  const findings: string[] = [];

  for (const assessment of Object.values(trace.inputAssessment ?? {})) {
    findings.push(...assessmentFindings("input", assessment));
  }
  for (const assessments of Object.values(trace.outputAssessments ?? {})) {
    for (const assessment of assessments) {
      findings.push(...assessmentFindings("output", assessment));
    }
  }

  return findings;
}

// A policy entry counts as a finding when it either acted or, in detect mode,
// would have. `detected` is how a NONE action still reports a hit.
function isFinding(action: string | undefined, detected?: boolean): boolean {
  return detected === true || (action !== undefined && action !== "NONE");
}

function assessmentFindings(
  where: "input" | "output",
  assessment: GuardrailAssessment,
): string[] {
  const findings: string[] = [];

  for (const filter of assessment.contentPolicy?.filters ?? []) {
    if (isFinding(filter.action, filter.detected)) {
      findings.push(`${where} content:${filter.type}=${filter.action}`);
    }
  }
  for (const topic of assessment.topicPolicy?.topics ?? []) {
    if (isFinding(topic.action, topic.detected)) {
      findings.push(`${where} topic:${topic.name}=${topic.action}`);
    }
  }
  for (const entity of assessment.sensitiveInformationPolicy?.piiEntities ??
    []) {
    if (isFinding(entity.action, entity.detected)) {
      findings.push(`${where} pii:${entity.type}=${entity.action}`);
    }
  }

  return findings;
}
