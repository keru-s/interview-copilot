'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { gzipSync, gunzipSync } = require('node:zlib');
const { DoubaoAsrSession, _protocol } = require('../src/main/doubaoAsr');

function fakeServerResponse(payload, { seq = 1, last = false } = {}) {
  const body = gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'));
  const header = Buffer.from([0x11, 0x90 | (last ? 0x03 : 0x01), 0x11, 0x00]);
  const seqBuf = Buffer.alloc(4);
  seqBuf.writeInt32BE(last ? -Math.abs(seq) : seq, 0);
  const sizeBuf = Buffer.alloc(4);
  sizeBuf.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, seqBuf, sizeBuf, body]);
}

test('Doubao full request is Seed JSON + gzip with positive sequence', () => {
  const frame = _protocol.buildFullClientRequest(1, {
    audio: { format: 'pcm', rate: 16000 },
    request: { model_name: 'bigmodel' },
  });
  assert.equal(frame[0], 0x11);
  assert.equal(frame[1], 0x11);
  assert.equal(frame[2], 0x11);
  assert.equal(frame.readInt32BE(4), 1);
  const size = frame.readUInt32BE(8);
  const json = JSON.parse(gunzipSync(frame.subarray(12, 12 + size)).toString('utf8'));
  assert.equal(json.audio.rate, 16000);
  assert.equal(json.request.model_name, 'bigmodel');
});

test('Doubao final audio packet uses a negative sequence', () => {
  const frame = _protocol.buildAudioOnlyRequest(7, Buffer.from([1, 2, 3, 4]), true);
  assert.equal(frame[0], 0x11);
  assert.equal(frame[1], 0x23);
  assert.equal(frame.readInt32BE(4), -7);
});

test('Doubao server response parser decodes gzipped transcript JSON', () => {
  const frame = fakeServerResponse({
    result: {
      text: '为什么 WebSocket 可以双向通信？',
      utterances: [{ text: '为什么 WebSocket 可以双向通信？', definite: true }],
    },
  });
  const parsed = _protocol.parseServerFrame(frame);
  assert.equal(parsed.messageType, 0b1001);
  assert.equal(parsed.payload.result.text, '为什么 WebSocket 可以双向通信？');
  assert.equal(parsed.payload.result.utterances[0].definite, true);
});

test('Doubao auth prefers modern API Key and supports legacy app credentials', () => {
  const modern = _protocol.buildAuthHeaders({
    apiKey: 'api-key',
    resourceId: 'volc.seedasr.sauc.duration',
  });
  assert.equal(modern['X-Api-Key'], 'api-key');
  assert.equal(modern['X-Api-Resource-Id'], 'volc.seedasr.sauc.duration');
  assert.equal(modern['X-Api-Sequence'], '-1');
  assert.ok(modern['X-Api-Request-Id']);
  assert.equal(modern['X-Api-App-Key'], undefined);

  const legacy = _protocol.buildAuthHeaders({
    appKey: 'app-id',
    accessKey: 'access-token',
    resourceId: 'volc.seedasr.sauc.duration',
  });
  assert.equal(legacy['X-Api-App-Key'], 'app-id');
  assert.equal(legacy['X-Api-Access-Key'], 'access-token');
  assert.equal(legacy['X-Api-Key'], undefined);
});

test('WebSocket client frame is masked as required by RFC6455', () => {
  const frame = _protocol.encodeClientWsFrame(Buffer.from('abc'));
  assert.equal(frame[0], 0x82);
  assert.ok(frame[1] & 0x80);
  assert.equal(frame[1] & 0x7f, 3);
  const mask = frame.subarray(2, 6);
  const masked = frame.subarray(6);
  const decoded = Buffer.alloc(masked.length);
  for (let i = 0; i < masked.length; i += 1) decoded[i] = masked[i] ^ mask[i % 4];
  assert.equal(decoded.toString('utf8'), 'abc');
});

test('Doubao close waits for the server final response before closing the socket', async () => {
  const sent = [];
  let socketClosed = false;
  const transcripts = [];
  const session = new DoubaoAsrSession({
    onTranscript: (result) => transcripts.push(result),
  });
  session.connected = true;
  session.pending = Buffer.from([1, 2, 3, 4]);
  session.ws = {
    open: true,
    send: (frame) => {
      sent.push(frame);
      return true;
    },
    close: () => {
      socketClosed = true;
    },
  };

  const closing = session.close();
  assert.ok(closing instanceof Promise, 'close must expose finalization completion');
  assert.equal(socketClosed, false);
  assert.equal(sent.length, 1);
  assert.equal(sent[0][1], 0x23);
  assert.deepEqual(gunzipSync(sent[0].subarray(12)), Buffer.from([1, 2, 3, 4]));

  session._handleMessage(
    fakeServerResponse(
      {
        result: {
          text: '最后几个字不能丢',
          utterances: [{ text: '最后几个字不能丢', definite: true }],
        },
      },
      { last: true },
    ),
  );
  await closing;

  assert.equal(socketClosed, true);
  assert.deepEqual(transcripts, [{ text: '最后几个字不能丢', isFinal: true }]);
});

test('Doubao final response promotes unchanged interim text to final', () => {
  const transcripts = [];
  const session = new DoubaoAsrSession({
    onTranscript: (result) => transcripts.push(result),
  });
  session.lastInterim = '完整问题';

  session._handleMessage(fakeServerResponse({ result: { text: '完整问题' } }, { last: true }));

  assert.deepEqual(transcripts, [{ text: '完整问题', isFinal: true }]);
});

test('Doubao final response without text still completes finalization', async () => {
  const session = new DoubaoAsrSession();
  session.connected = true;
  session.ws = {
    open: true,
    send: () => true,
    close: () => {},
  };

  const closing = session.close();
  session._handleMessage(fakeServerResponse({}, { last: true }));
  await closing;
});

test('Doubao finalization times out and closes an unresponsive socket', async () => {
  let socketClosed = false;
  const states = [];
  const session = new DoubaoAsrSession({
    finalTimeoutMs: 10,
    onState: (state, info) => states.push({ state, info }),
  });
  session.connected = true;
  session.ws = {
    open: true,
    send: () => true,
    close: () => {
      socketClosed = true;
    },
  };

  await assert.rejects(session.close(), /timed out after 10ms/);
  assert.equal(socketClosed, true);
  assert.ok(states.some(({ state }) => state === 'error'));
});
