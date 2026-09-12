'use strict';

// 豆包语音 / 火山引擎 ASR 2.0 流式客户端。
// 不引入额外 npm 依赖：用 Node TLS 实现最小 RFC6455 WebSocket 客户端，
// 这样才能在握手时携带 X-Api-* 自定义 Header（浏览器 WebSocket 做不到）。

const tls = require('tls');
const { EventEmitter } = require('events');
const { randomBytes, randomUUID, createHash } = require('crypto');
const { gzipSync, gunzipSync } = require('zlib');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const MSG_TYPE = {
  CLIENT_FULL_REQUEST: 0b0001,
  CLIENT_AUDIO_ONLY_REQUEST: 0b0010,
  SERVER_FULL_RESPONSE: 0b1001,
  SERVER_ERROR_RESPONSE: 0b1111,
};

const FLAGS = {
  POS_SEQUENCE: 0b0001,
  NEG_WITH_SEQUENCE: 0b0011,
};

const SERIALIZATION = { NONE: 0, JSON: 1 };
const COMPRESSION = { NONE: 0, GZIP: 1 };
const VERSION = 1;

function buildHeader(messageType, flags, serialization, compression) {
  return Buffer.from([
    (VERSION << 4) | 0b0001,
    (messageType << 4) | flags,
    (serialization << 4) | compression,
    0,
  ]);
}

function buildFullClientRequest(seq, payload) {
  const body = gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'));
  const seqBuf = Buffer.alloc(4);
  seqBuf.writeInt32BE(seq, 0);
  const sizeBuf = Buffer.alloc(4);
  sizeBuf.writeUInt32BE(body.length, 0);
  return Buffer.concat([
    buildHeader(
      MSG_TYPE.CLIENT_FULL_REQUEST,
      FLAGS.POS_SEQUENCE,
      SERIALIZATION.JSON,
      COMPRESSION.GZIP,
    ),
    seqBuf,
    sizeBuf,
    body,
  ]);
}

function buildAudioOnlyRequest(seq, audio, isLast) {
  const body = gzipSync(audio);
  const seqBuf = Buffer.alloc(4);
  seqBuf.writeInt32BE(isLast ? -Math.abs(seq) : seq, 0);
  const sizeBuf = Buffer.alloc(4);
  sizeBuf.writeUInt32BE(body.length, 0);
  return Buffer.concat([
    buildHeader(
      MSG_TYPE.CLIENT_AUDIO_ONLY_REQUEST,
      isLast ? FLAGS.NEG_WITH_SEQUENCE : FLAGS.POS_SEQUENCE,
      SERIALIZATION.NONE,
      COMPRESSION.GZIP,
    ),
    seqBuf,
    sizeBuf,
    body,
  ]);
}

function parseServerFrame(frame) {
  const msg = Buffer.isBuffer(frame) ? frame : Buffer.from(frame);
  if (msg.length < 4) throw new Error('Doubao frame header is too short');

  const headerSize = (msg[0] & 0x0f) * 4;
  const messageType = msg[1] >> 4;
  const flags = msg[1] & 0x0f;
  const serialization = msg[2] >> 4;
  const compression = msg[2] & 0x0f;
  let offset = headerSize;
  let sequence = null;

  if (flags & 0b0001) {
    if (offset + 4 > msg.length) throw new Error('Doubao frame sequence is truncated');
    sequence = msg.readInt32BE(offset);
    offset += 4;
  }

  if (flags & 0b0100) {
    if (offset + 4 > msg.length) throw new Error('Doubao frame event is truncated');
    offset += 4;
  }

  if (messageType === MSG_TYPE.SERVER_ERROR_RESPONSE) {
    if (offset + 8 > msg.length) throw new Error('Doubao error frame is truncated');
    const errorCode = msg.readUInt32BE(offset);
    offset += 4;
    const size = msg.readUInt32BE(offset);
    offset += 4;
    const raw = msg.subarray(offset, offset + size);
    const decoded = compression === COMPRESSION.GZIP ? gunzipSync(raw) : raw;
    return {
      messageType,
      errorCode,
      error: decoded.toString('utf8'),
      sequence,
      isLast: !!(flags & 0b0010),
    };
  }

  if (messageType !== MSG_TYPE.SERVER_FULL_RESPONSE) {
    return { messageType, sequence, isLast: !!(flags & 0b0010), payload: null };
  }

  if (offset + 4 > msg.length) throw new Error('Doubao response payload size is missing');
  const size = msg.readUInt32BE(offset);
  offset += 4;
  const raw = msg.subarray(offset, offset + size);
  const decoded = compression === COMPRESSION.GZIP ? gunzipSync(raw) : raw;
  let payload = decoded;
  if (serialization === SERIALIZATION.JSON) {
    payload = JSON.parse(decoded.toString('utf8'));
  }
  return {
    messageType,
    sequence,
    isLast: !!(flags & 0b0010),
    payload,
  };
}

function encodeClientWsFrame(payload, opcode = 0x2) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const mask = randomBytes(4);
  let header;
  if (body.length < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | body.length;
  } else if (body.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  header[0] = 0x80 | opcode;

  const masked = Buffer.alloc(body.length);
  for (let i = 0; i < body.length; i += 1) masked[i] = body[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

class HeaderWebSocket extends EventEmitter {
  constructor(url, headers = {}) {
    super();
    this.url = new URL(url);
    this.headers = headers;
    this.socket = null;
    this.open = false;
    this.closed = false;
    this.buffer = Buffer.alloc(0);
    this.handshakeBuffer = Buffer.alloc(0);
    this.fragmentOpcode = null;
    this.fragments = [];
  }

  connect() {
    return new Promise((resolve, reject) => {
      const host = this.url.hostname;
      const port = Number(this.url.port || 443);
      const key = randomBytes(16).toString('base64');
      const expectedAccept = createHash('sha1')
        .update(key + WS_GUID)
        .digest('base64');
      let settled = false;

      const fail = (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
        this.emit('error', err);
      };

      const socket = tls.connect({ host, port, servername: host });
      this.socket = socket;

      socket.once('secureConnect', () => {
        const path = `${this.url.pathname || '/'}${this.url.search || ''}`;
        const lines = [
          `GET ${path} HTTP/1.1`,
          `Host: ${this.url.host}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${key}`,
          'Sec-WebSocket-Version: 13',
          ...Object.entries(this.headers).map(([k, v]) => `${k}: ${v}`),
          '',
          '',
        ];
        socket.write(lines.join('\r\n'));
      });

      socket.on('data', (chunk) => {
        try {
          if (!this.open) {
            this.handshakeBuffer = Buffer.concat([this.handshakeBuffer, chunk]);
            const end = this.handshakeBuffer.indexOf('\r\n\r\n');
            if (end < 0) return;
            const headerText = this.handshakeBuffer.subarray(0, end).toString('utf8');
            const rest = this.handshakeBuffer.subarray(end + 4);
            this.handshakeBuffer = Buffer.alloc(0);
            const lines = headerText.split('\r\n');
            const status = lines.shift() || '';
            const responseHeaders = {};
            for (const line of lines) {
              const idx = line.indexOf(':');
              if (idx > 0) {
                responseHeaders[line.slice(0, idx).trim().toLowerCase()] = line
                  .slice(idx + 1)
                  .trim();
              }
            }
            if (!/^HTTP\/1\.[01] 101\b/.test(status)) {
              fail(new Error(`Doubao WebSocket handshake failed: ${status}`));
              socket.destroy();
              return;
            }
            if ((responseHeaders['sec-websocket-accept'] || '') !== expectedAccept) {
              fail(new Error('Doubao WebSocket handshake returned an invalid accept key'));
              socket.destroy();
              return;
            }
            this.open = true;
            if (!settled) {
              settled = true;
              resolve();
            }
            this.emit('open');
            if (rest.length) this._consume(rest);
            return;
          }
          this._consume(chunk);
        } catch (e) {
          fail(e);
          socket.destroy();
        }
      });

      socket.on('error', fail);
      socket.on('close', () => {
        this.open = false;
        if (!this.closed && !settled) {
          fail(new Error('Doubao WebSocket closed during handshake'));
        }
        this.emit('close');
      });
    });
  }

  _consume(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const b0 = this.buffer[0];
      const b1 = this.buffer[1];
      const fin = !!(b0 & 0x80);
      const opcode = b0 & 0x0f;
      const masked = !!(b1 & 0x80);
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this.buffer.length < 4) return;
        len = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.buffer.length < 10) return;
        const big = this.buffer.readBigUInt64BE(2);
        if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new Error('WebSocket frame is too large');
        }
        len = Number(big);
        offset = 10;
      }
      let mask = null;
      if (masked) {
        if (this.buffer.length < offset + 4) return;
        mask = this.buffer.subarray(offset, offset + 4);
        offset += 4;
      }
      if (this.buffer.length < offset + len) return;
      const payload = Buffer.from(this.buffer.subarray(offset, offset + len));
      this.buffer = this.buffer.subarray(offset + len);
      if (mask) {
        for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
      }

      if (opcode === 0x8) {
        if (this.socket && !this.socket.destroyed) {
          this.socket.end(encodeClientWsFrame(payload, 0x8));
        }
        this.closed = true;
        continue;
      }
      if (opcode === 0x9) {
        this._sendFrame(payload, 0x0a);
        continue;
      }
      if (opcode === 0x0a) continue;

      if (opcode === 0x0) {
        this.fragments.push(payload);
        if (fin && this.fragmentOpcode !== null) {
          const full = Buffer.concat(this.fragments);
          const originalOpcode = this.fragmentOpcode;
          this.fragmentOpcode = null;
          this.fragments = [];
          if (originalOpcode === 0x2) this.emit('message', full);
        }
        continue;
      }
      if (!fin) {
        this.fragmentOpcode = opcode;
        this.fragments = [payload];
        continue;
      }
      if (opcode === 0x2) this.emit('message', payload);
    }
  }

  _sendFrame(payload, opcode) {
    if (!this.socket || !this.open || this.socket.destroyed) return false;
    this.socket.write(encodeClientWsFrame(payload, opcode));
    return true;
  }

  send(payload) {
    return this._sendFrame(payload, 0x2);
  }

  close() {
    this.closed = true;
    if (this.socket && this.open && !this.socket.destroyed) {
      try {
        this.socket.write(encodeClientWsFrame(Buffer.alloc(0), 0x8));
      } catch (_e) {}
    }
    if (this.socket && !this.socket.destroyed) this.socket.end();
    this.open = false;
  }
}

function mapLanguage(language) {
  if (!language || language === 'multi' || language === 'zh') return 'zh-CN';
  if (language === 'en-US' || language === 'en') return 'en-US';
  return language;
}

function buildAuthHeaders(options) {
  const requestId = randomUUID();
  const common = {
    'X-Api-Resource-Id': options.resourceId || 'volc.seedasr.sauc.duration',
    'X-Api-Request-Id': requestId,
    'X-Api-Connect-Id': randomUUID(),
    'X-Api-Sequence': '-1',
  };
  if (options.apiKey) return { ...common, 'X-Api-Key': options.apiKey };
  return {
    ...common,
    'X-Api-App-Key': options.appKey,
    'X-Api-Access-Key': options.accessKey,
  };
}

class DoubaoAsrSession {
  constructor(options = {}) {
    this.apiKey = options.apiKey || '';
    this.appKey = options.appKey || '';
    this.accessKey = options.accessKey || '';
    this.resourceId = options.resourceId || 'volc.seedasr.sauc.duration';
    this.wsUrl = options.wsUrl || 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream';
    this.language = mapLanguage(options.language || 'zh');
    this.sampleRate = options.sampleRate || 16000;
    this.onTranscript = options.onTranscript || (() => {});
    this.onState = options.onState || (() => {});
    this.ws = null;
    this.seq = 1;
    this.pending = Buffer.alloc(0);
    this.segmentBytes = Math.round(this.sampleRate * 2 * 0.2);
    this.queue = [];
    this.connected = false;
    this.closing = false;
    this.seenDefinite = new Set();
    this.lastInterim = '';
    this.finalTimeoutMs = options.finalTimeoutMs || 5000;
    this.finalization = null;
    this.finalResolve = null;
    this.finalReject = null;
    this.finalTimer = null;
  }

  async connect() {
    const hasLegacy = this.appKey && this.accessKey;
    if (!this.apiKey && !hasLegacy) {
      throw new Error('Doubao API Key or App ID + Access Token is missing');
    }
    if (!['zh-CN', 'en-US'].includes(this.language)) {
      throw new Error('Doubao bidirectional ASR currently supports Chinese/English in this app');
    }

    const ws = new HeaderWebSocket(
      this.wsUrl,
      buildAuthHeaders({
        apiKey: this.apiKey,
        appKey: this.appKey,
        accessKey: this.accessKey,
        resourceId: this.resourceId,
      }),
    );
    this.ws = ws;
    ws.on('message', (data) => this._handleMessage(data));
    ws.on('error', (e) => this.onState('error', e.message));
    ws.on('close', () => {
      this.connected = false;
      if (this.finalization && this.finalReject) {
        this._settleFinalization(new Error('Doubao WebSocket closed before the final transcript'));
      }
      this.onState('closed', this.closing ? '' : 'Doubao WebSocket closed');
    });

    await ws.connect();
    const payload = {
      user: { uid: 'interview-copilot' },
      audio: {
        format: 'pcm',
        codec: 'raw',
        rate: this.sampleRate,
        bits: 16,
        channel: 1,
        language: this.language,
      },
      request: {
        model_name: 'bigmodel',
        enable_itn: true,
        enable_punc: true,
        enable_ddc: false,
        show_utterances: true,
        result_type: 'full',
      },
    };
    ws.send(buildFullClientRequest(this.seq++, payload));
    this.connected = true;
    this.onState('open');
    for (const chunk of this.queue.splice(0)) this.send(chunk);
  }

  send(buffer) {
    const chunk = Buffer.isBuffer(buffer)
      ? buffer
      : Buffer.from(buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : buffer);
    if (!this.connected || !this.ws || !this.ws.open) {
      this.queue.push(chunk);
      return;
    }
    this.pending = Buffer.concat([this.pending, chunk]);
    while (this.pending.length >= this.segmentBytes) {
      const packet = this.pending.subarray(0, this.segmentBytes);
      this.pending = this.pending.subarray(this.segmentBytes);
      this.ws.send(buildAudioOnlyRequest(this.seq++, packet, false));
    }
  }

  _handleMessage(data) {
    let parsed;
    try {
      parsed = parseServerFrame(data);
    } catch (e) {
      this.onState('error', `Doubao response parse failed: ${e.message}`);
      return;
    }
    if (parsed.messageType === MSG_TYPE.SERVER_ERROR_RESPONSE) {
      const detail = parsed.error || '';
      const error = new Error(`Doubao ASR error ${parsed.errorCode}: ${detail}`.trim());
      this.onState('error', error.message);
      this._settleFinalization(error);
      return;
    }
    const result = parsed.payload && parsed.payload.result;
    if (!result) {
      if (parsed.isLast) {
        this.onState('final_received', String(Date.now()));
        this._settleFinalization();
      }
      return;
    }

    const utterances = Array.isArray(result.utterances) ? result.utterances : [];
    let emittedFinal = false;
    for (const u of utterances) {
      if (!u || !u.definite || !String(u.text || '').trim()) continue;
      const text = String(u.text).trim();
      const key = `${u.start_time ?? ''}:${u.end_time ?? ''}:${text}`;
      if (this.seenDefinite.has(key)) continue;
      this.seenDefinite.add(key);
      emittedFinal = true;
      this.onTranscript({ text, isFinal: true });
    }

    const fullText = String(result.text || '').trim();
    if (!emittedFinal && fullText && (parsed.isLast || fullText !== this.lastInterim)) {
      this.lastInterim = fullText;
      this.onTranscript({ text: fullText, isFinal: !!parsed.isLast });
    }
    if (parsed.isLast) {
      this.onState('final_received', String(Date.now()));
      this._settleFinalization();
    }
  }

  close() {
    if (this.finalization) return this.finalization;
    this.closing = true;
    if (this.ws && this.ws.open) {
      this.finalization = new Promise((resolve, reject) => {
        this.finalResolve = resolve;
        this.finalReject = reject;
      });
      const finalChunk = this.pending;
      this.pending = Buffer.alloc(0);
      const sent = this.ws.send(buildAudioOnlyRequest(this.seq++, finalChunk, true));
      if (!sent) {
        this._settleFinalization(new Error('Doubao final audio packet could not be sent'));
        return this.finalization;
      }
      this.onState('final_packet_sent', String(Date.now()));
      this.finalTimer = setTimeout(() => {
        const error = new Error(`Doubao final transcript timed out after ${this.finalTimeoutMs}ms`);
        this.onState('error', error.message);
        this._settleFinalization(error);
      }, this.finalTimeoutMs);
    } else if (this.ws) {
      this.ws.close();
      return Promise.resolve();
    }
    return this.finalization || Promise.resolve();
  }

  _settleFinalization(error) {
    if (!this.finalization) return;
    if (this.finalTimer) clearTimeout(this.finalTimer);
    this.finalTimer = null;
    const resolve = this.finalResolve;
    const reject = this.finalReject;
    this.finalResolve = null;
    this.finalReject = null;
    if (this.ws) this.ws.close();
    this.connected = false;
    if (error) reject(error);
    else resolve();
  }

  // 应用退出/窗口关闭时立即断开，不发送最终包、不等待服务端最终结果。
  abort() {
    this.closing = true;
    if (this.finalTimer) clearTimeout(this.finalTimer);
    this.finalTimer = null;
    const reject = this.finalReject;
    this.finalization = null;
    this.finalResolve = null;
    this.finalReject = null;
    if (this.ws) this.ws.close();
    this.connected = false;
    if (reject) reject(new Error('Doubao session aborted'));
  }
}

module.exports = {
  DoubaoAsrSession,
  _protocol: {
    buildFullClientRequest,
    buildAudioOnlyRequest,
    parseServerFrame,
    encodeClientWsFrame,
    buildAuthHeaders,
  },
};
