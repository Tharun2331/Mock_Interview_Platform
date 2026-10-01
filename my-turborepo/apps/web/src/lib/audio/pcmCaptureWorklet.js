// Runs on the audio thread, so it cannot be bundled with the app and cannot
// import anything. It is served as a static file from this origin — by
// src/index.ts in dev and copied into dist/ by build.ts — so the CSP's
// script-src can stay 'self' with no blob: allowance.
//
// Two values are duplicated from the app and must stay in step: the registered
// name (AUDIO.WORKLET_NAME in lib/audioConstants.ts, asserted by
// __tests__/lib/pcmCaptureWorklet.test.ts) and the frame size, which arrives
// through processorOptions instead of being written here.
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const frameSamples = options.processorOptions.frameSamples;
    this._frameSamples = frameSamples;
    this._buffer = new Int16Array(frameSamples);
    this._offset = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    // No input yet, or the track ended. Returning true keeps the node alive.
    if (!channel) return true;

    for (let i = 0; i < channel.length; i += 1) {
      // Float32 [-1, 1] to signed 16-bit. Clamped first: values slightly
      // outside the range are legal in Web Audio and would wrap to the
      // opposite sign, which is audible as a click.
      const clamped = Math.max(-1, Math.min(1, channel[i]));
      this._buffer[this._offset] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
      this._offset += 1;

      if (this._offset === this._buffer.length) {
        // Transferred, not copied — the buffer is handed to the main thread and
        // a fresh one allocated, so no frame is ever seen half-written.
        this.port.postMessage(this._buffer.buffer, [this._buffer.buffer]);
        this._buffer = new Int16Array(this._frameSamples);
        this._offset = 0;
      }
    }
    return true;
  }
}
registerProcessor("pcm-capture", PcmCaptureProcessor);
