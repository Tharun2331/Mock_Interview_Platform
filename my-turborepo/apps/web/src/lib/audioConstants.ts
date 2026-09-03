// Audio constants for the interview loop.
//
// The sample rates are not preferences. They are fixed by what Nova 2 Sonic
// accepts and emits, and they must match `SONIC` in apps/servers/lib/constants.ts
// exactly — a mismatch does not error, it just plays back at the wrong pitch,
// which is a confusing bug to trace from a user report.
export const AUDIO = {
  INPUT_SAMPLE_RATE: 16000,
  OUTPUT_SAMPLE_RATE: 24000,
  CHANNELS: 1,

  WORKLET_NAME: "pcm-capture",
  // 512 samples at 16 kHz is 32ms, the frame size the Nova docs describe.
  // Smaller frames mean more postMessage traffic for no benefit; larger ones
  // add latency to the candidate's first word.
  FRAME_SAMPLES: 512,

  // Level-meter window. 1024 samples at 16 kHz is 64ms — long enough to be
  // stable, short enough to feel immediate.
  ANALYSER_FFT_SIZE: 1024,
  // How often the meter re-reads the analyser. Faster than this is wasted on a
  // bar the eye cannot follow.
  LEVEL_POLL_MS: 100,

  // Playback is scheduled slightly ahead of the clock so consecutive chunks
  // butt up against each other without an audible gap between them.
  PLAYBACK_LEAD_S: 0.08,
} as const;
