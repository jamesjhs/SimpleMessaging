'use strict';

class TlsAudioRecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(2048);
    this.offset = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input?.length) return true;

    let inputOffset = 0;
    while (inputOffset < input.length) {
      const copyLength = Math.min(input.length - inputOffset, this.buffer.length - this.offset);
      this.buffer.set(input.subarray(inputOffset, inputOffset + copyLength), this.offset);
      this.offset += copyLength;
      inputOffset += copyLength;
      if (this.offset === this.buffer.length) {
        const completed = this.buffer;
        this.port.postMessage(completed.buffer, [completed.buffer]);
        this.buffer = new Float32Array(2048);
        this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor('tls-audio-recorder', TlsAudioRecorderProcessor);
