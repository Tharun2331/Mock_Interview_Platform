import { describe, expect, it } from "bun:test";
import { AUDIO } from "@/lib/audioConstants";

// The worklet file cannot import AUDIO, so its registered name is a literal.
// A mismatch does not fail to compile — `new AudioWorkletNode` throws at the
// moment the candidate presses start — so pin it here.
const source = await Bun.file(
  new URL("../../src/lib/audio/pcmCaptureWorklet.js", import.meta.url),
).text();

describe("pcmCaptureWorklet.js", () => {
  it("registers the processor under AUDIO.WORKLET_NAME", () => {
    expect(source).toContain(`registerProcessor("${AUDIO.WORKLET_NAME}"`);
  });

  it("takes its frame size from processorOptions, not a literal", () => {
    expect(source).toContain("processorOptions.frameSamples");
    expect(source).not.toContain(String(AUDIO.FRAME_SAMPLES));
  });
});
