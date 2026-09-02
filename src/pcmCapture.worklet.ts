declare const AudioWorkletProcessor: {
  new (): { readonly port: MessagePort };
};
declare function registerProcessor(
  name: string,
  processorCtor: new () => { process(inputs: Float32Array[][]): boolean }
): void;

const CHUNK_SAMPLES = 1600;

class PcmCaptureProcessor extends AudioWorkletProcessor {
  private readonly chunk = new Int16Array(CHUNK_SAMPLES);
  private count = 0;

  process(inputs: Float32Array[][]): boolean {
    const channels = inputs[0];
    if (!channels?.length) return true;

    for (let sample = 0; sample < channels[0].length; sample++) {
      let mono = 0;
      for (const channel of channels) mono += channel[sample] ?? 0;
      mono = Math.max(-1, Math.min(1, mono / channels.length));
      this.chunk[this.count++] = mono < 0 ? mono * 0x8000 : mono * 0x7fff;

      if (this.count === CHUNK_SAMPLES) {
        const buffer = this.chunk.buffer.slice(0);
        this.port.postMessage(buffer, [buffer]);
        this.count = 0;
      }
    }
    return true;
  }
}

registerProcessor("pcm-capture", PcmCaptureProcessor);

