import { AUDIO } from "@/lib/audioConstants";

// Microphone capture for the interview loop.
//
// An AudioWorklet, never MediaRecorder: MediaRecorder emits WebM/Opus
// containers and the interview stream needs raw 16 kHz 16-bit PCM mono frames.
//
// The worklet runs on the audio thread, so its source cannot be bundled with
// the rest of the app — addModule() takes a URL. It is a static file served from
// this origin (src/index.ts in dev, copied into dist/ by build.ts), NOT a blob:
// URL, so the CSP's script-src needs no blob: allowance.
export const WORKLET_URL = "/pcm-capture.worklet.js";

export type CaptureHandle = {
  // Real measured amplitude, 0..1, read from the analyser. The level meter is
  // driven by this rather than by a state flag, so an indicator can never
  // animate while the microphone is muted at OS level.
  readLevel: () => number;
  stop: () => void;
};

export type CaptureArgs = {
  onFrame: (frame: ArrayBuffer) => void;
};

export async function startCapture(args: CaptureArgs): Promise<CaptureHandle> {
  // Echo cancellation is mandatory, not a nicety. The microphone stays open
  // while the interviewer speaks so the candidate can interrupt, which means
  // without AEC the model hears its own voice and answers itself — a failure
  // that is nearly invisible in a bug report.
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: AUDIO.CHANNELS,
    },
  });

  // Asking for the context at 16 kHz makes the browser's own resampler produce
  // exactly what Sonic expects. Decimating 48 kHz by hand in the worklet would
  // be more code and worse audio.
  const context = new AudioContext({ sampleRate: AUDIO.INPUT_SAMPLE_RATE });

  await context.audioWorklet.addModule(WORKLET_URL);

  const source = context.createMediaStreamSource(stream);
  const worklet = new AudioWorkletNode(context, AUDIO.WORKLET_NAME, {
    processorOptions: { frameSamples: AUDIO.FRAME_SAMPLES },
  });
  const analyser = context.createAnalyser();
  analyser.fftSize = AUDIO.ANALYSER_FFT_SIZE;
  const samples = new Float32Array(analyser.fftSize);

  worklet.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
    args.onFrame(event.data);
  };

  source.connect(analyser);
  source.connect(worklet);
  // Deliberately not connected to context.destination. Routing the microphone
  // to the speakers would put the candidate's own voice in their ears and feed
  // the echo canceller a signal it did not originate.

  return {
    readLevel: () => {
      analyser.getFloatTimeDomainData(samples);
      // Peak, not RMS. A meter should track the loudest moment in the window,
      // which is what a speaker recognises as "it heard me".
      let peak = 0;
      for (const sample of samples) {
        const magnitude = Math.abs(sample);
        if (magnitude > peak) peak = magnitude;
      }
      return Math.min(1, peak);
    },
    stop: () => {
      worklet.port.onmessage = null;
      worklet.disconnect();
      analyser.disconnect();
      source.disconnect();
      // Every track must be stopped explicitly, or the browser keeps showing
      // the recording indicator after the interview ends.
      for (const track of stream.getTracks()) track.stop();
      void context.close();
    },
  };
}
