'use strict';

/* global window, document */

const { contextBridge, ipcRenderer } = require('electron');
const { DoubaoAsrSession } = require('./doubaoAsr');

const doubaoSessions = new Map();
const doubaoListeners = new Set();

function emitDoubao(sessionId, payload) {
  for (const cb of doubaoListeners) {
    try {
      cb({ sessionId, ...payload });
    } catch (_e) {}
  }
}

async function startDoubaoSession(options = {}) {
  const sessionId = String(options.sessionId || '');
  if (!sessionId) throw new Error('Doubao sessionId is required');

  const previous = doubaoSessions.get(sessionId);
  if (previous) previous.close();

  const session = new DoubaoAsrSession({
    apiKey: options.apiKey,
    appKey: options.appKey,
    accessKey: options.accessKey,
    resourceId: options.resourceId,
    wsUrl: options.wsUrl,
    language: options.language,
    sampleRate: options.sampleRate,
    onTranscript: (result) => emitDoubao(sessionId, { type: 'transcript', ...result }),
    onState: (state, info) => emitDoubao(sessionId, { type: 'state', state, info }),
  });
  doubaoSessions.set(sessionId, session);
  try {
    await session.connect();
    return { ok: true };
  } catch (e) {
    doubaoSessions.delete(sessionId);
    try {
      session.close();
    } catch (_e) {}
    throw e;
  }
}

contextBridge.exposeInMainWorld('api', {
  // 设置
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (partial) => ipcRenderer.invoke('save-settings', partial),

  // 资料
  pickDocuments: () => ipcRenderer.invoke('pick-documents'),
  listDocuments: () => ipcRenderer.invoke('list-documents'),
  removeDocument: (id) => ipcRenderer.invoke('remove-document', id),
  clearDocuments: () => ipcRenderer.invoke('clear-documents'),
  addTextDocument: (payload) => ipcRenderer.invoke('add-text-document', payload),
  pickJD: () => ipcRenderer.invoke('pick-jd'),

  // 权限
  ensureMicPermission: () => ipcRenderer.invoke('ensure-mic-permission'),
  getScreenPermission: () => ipcRenderer.invoke('get-screen-permission'),
  openScreenSettings: () => ipcRenderer.invoke('open-screen-settings'),

  // 豆包 ASR：在 preload/Node 侧发 WebSocket，以便携带自定义鉴权 Header。
  doubaoSttStart: (options) => startDoubaoSession(options),
  doubaoSttSend: ({ sessionId, buffer }) => {
    const session = doubaoSessions.get(sessionId);
    if (!session) return false;
    session.send(buffer);
    return true;
  },
  doubaoSttClose: (sessionId) => {
    const session = doubaoSessions.get(sessionId);
    if (!session) return false;
    session.close();
    doubaoSessions.delete(sessionId);
    return true;
  },
  onDoubaoSttEvent: (cb) => {
    doubaoListeners.add(cb);
    return () => doubaoListeners.delete(cb);
  },

  // 生成答案
  generateAnswer: (payload) => ipcRenderer.send('generate-answer', payload),
  cancelGenerate: () => ipcRenderer.send('cancel-generate'),

  // 事件订阅
  onHotkeyGenerate: (cb) => {
    const h = () => cb();
    ipcRenderer.on('hotkey-generate', h);
    return () => ipcRenderer.removeListener('hotkey-generate', h);
  },
  // question-capture-mode 会在初始化后接管热键语义；用于清掉旧的“直接生成”监听器。
  clearHotkeyGenerateListeners: () => ipcRenderer.removeAllListeners('hotkey-generate'),
  onAnswerStart: (cb) => sub('answer-start', cb),
  onAnswerQuestion: (cb) => sub('answer-question', cb),
  onAnswerChunk: (cb) => sub('answer-chunk', cb),
  onAnswerDone: (cb) => sub('answer-done', cb),
  onAnswerError: (cb) => sub('answer-error', cb),
});

function sub(channel, cb) {
  const h = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
}

// Load the optional capture-mode layer after app.js has finished its DOMContentLoaded init.
// Injecting from preload avoids changing the upstream index.html structure.
window.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => {
    if (document.querySelector('script[data-question-capture-mode]')) return;
    const script = document.createElement('script');
    script.src = 'capture-mode.js';
    script.dataset.questionCaptureMode = 'true';
    document.body.appendChild(script);
  }, 0);
});
