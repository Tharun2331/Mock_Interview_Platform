import { AUDIO } from "@/lib/audioConstants";

// Playback for the interviewer's voice: 24 kHz signed 16-bit LPCM arriving as
// binary WebSocket frames.
//
// Scheduled through Web Audio rather than handed to an <audio> element. There
// is no container and no blob — chunks arrive faster than real time and must be
// queued end to end, which only the audio clock can do without gaps.
export class InterviewerVoice {
  private context: AudioContext | null = null;
  // Every chunk is routed through this bus rather than straight to the
  // destination, so one analyser can measure the interviewer's voice the same
  // way capture.ts measures the candidate's. It is still an ordinary path to
  // context.destination — the browser recognises it as output, which is what
  // keeps echo cancellation working.
  private bus: AnalyserNode | null = null;
  // Explicitly backed by ArrayBuffer, not ArrayBufferLike: getFloatTimeDomainData
  // will not accept a view that might sit on a SharedArrayBuffer.
  private samples: Float32Array<ArrayBuffer> | null = null;
  // When the next chunk should start, on the AudioContext clock. Ahead of
  // currentTime whenever audio is queued.
  private playheadAt = 0;
  private readonly playing = new Set<AudioBufferSourceNode>();
  private onEndedCallback: (() => void) | null = null;

  // Created lazily and on a user gesture. An AudioContext constructed before
  // the candidate has interacted with the page starts suspended, and audio
  // would silently never play.
  private ensureContext(): AudioContext {
    if (this.context === null) {
      this.context = new AudioContext({
        sampleRate: AUDIO.OUTPUT_SAMPLE_RATE,
      });
      const bus = this.context.createAnalyser();
      bus.fftSize = AUDIO.ANALYSER_FFT_SIZE;
      bus.connect(this.context.destination);
      this.bus = bus;
      this.samples = new Float32Array(bus.fftSize);
    }
    return this.context;
  }

  // Real measured amplitude of what is actually reaching the speakers, 0..1.
  //
  // Read from the analyser rather than inferred from "the interviewer is
  // speaking", for the same reason the microphone meter is: a flag-driven
  // indicator keeps moving through a gap in the audio, or through a stall, and
  // an indicator that moves when nothing is playing is worse than none.
  readLevel(): number {
    const bus = this.bus;
    const samples = this.samples;
    if (bus === null || samples === null || this.playing.size === 0) return 0;

    bus.getFloatTimeDomainData(samples);
    // Peak, not RMS — matches the capture meter, so the two read at the same
    // scale and the orb does not jump in size when the floor changes hands.
    let peak = 0;
    for (const sample of samples) {
      const magnitude = Math.abs(sample);
      if (magnitude > peak) peak = magnitude;
    }
    return Math.min(1, peak);
  }

  async resume(): Promise<void> {
    const context = this.ensureContext();
    if (context.state === "suspended") await context.resume();
  }

  set onEnded(callback: (() => void) | null) {
    this.onEndedCallback = callback;
  }

  get isPlaying(): boolean {
    return this.playing.size > 0;
  }

  enqueue(pcm: ArrayBuffer): void {
    const context = this.ensureContext();
    const samples = new Int16Array(pcm);
    if (samples.length === 0) return;

    const buffer = context.createBuffer(
      AUDIO.CHANNELS,
      samples.length,
      AUDIO.OUTPUT_SAMPLE_RATE
    );
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i += 1) {
      // Signed 16-bit back to Float32 [-1, 1). Asymmetric divisor because the
      // negative range extends one further than the positive.
      const sample = samples[i] ?? 0;
      channel[i] = sample < 0 ? sample / 0x8000 : sample / 0x7fff;
    }

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.bus ?? context.destination);

    // A small lead the first time, so the first chunk is not scheduled in the
    // past. After that each chunk starts exactly where the previous one ended.
    const startAt = Math.max(
      context.currentTime + AUDIO.PLAYBACK_LEAD_S,
      this.playheadAt
    );
    source.start(startAt);
    this.playheadAt = startAt + buffer.duration;

    this.playing.add(source);
    source.onended = () => {
      this.playing.delete(source);
      if (this.playing.size === 0) this.onEndedCallback?.();
    };
  }

  // Barge-in. Every scheduled chunk is stopped immediately, including audio
  // that has been queued but not yet reached the speakers.
  //
  // This has to be synchronous and total. Sonic generates faster than real
  // time, so by the time the candidate interrupts, several seconds of speech
  // may already be scheduled — letting it drain would have the interviewer
  // talking over someone who already took the floor, and people stop and
  // apologise to a machine that does that.
  interrupt(): void {
    for (const source of this.playing) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // Already finished between the check and the call. Nothing to do.
      }
      source.disconnect();
    }
    this.playing.clear();
    // Reset so the next chunk schedules from now, not from the abandoned tail.
    this.playheadAt = this.context?.currentTime ?? 0;
  }

  close(): void {
    this.interrupt();
    this.bus?.disconnect();
    this.bus = null;
    this.samples = null;
    void this.context?.close();
    this.context = null;
  }
}
