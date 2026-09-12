'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadProcessor() {
  let Processor;
  class FakeAudioWorkletProcessor {
    constructor() {
      this.port = {
        onmessage: null,
        messages: [],
        postMessage: (message) => this.port.messages.push(message),
      };
    }
  }
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/pcm-worklet.js'), 'utf8');
  vm.runInNewContext(source, {
    AudioWorkletProcessor: FakeAudioWorkletProcessor,
    Int16Array,
    sampleRate: 16000,
    registerProcessor: (_name, implementation) => {
      Processor = implementation;
    },
  });
  return new Processor();
}

test('PCM worklet flushes the final partial buffer before capture stops', () => {
  const processor = loadProcessor();
  processor.process([[new Float32Array([0.25, -0.25, 0.5])]]);
  assert.equal(processor.port.messages.length, 0);

  assert.equal(typeof processor.port.onmessage, 'function');
  processor.port.onmessage({ data: { type: 'flush' } });

  assert.equal(processor.port.messages.length, 2);
  const pcm = new Int16Array(processor.port.messages[0]);
  assert.deepEqual(Array.from(pcm), [8191, -8192, 16383]);
  assert.deepEqual(processor.port.messages[1], { type: 'flushed' });
});
