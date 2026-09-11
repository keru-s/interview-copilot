'use strict';

const { contextBridge, ipcRenderer } = require('electron');

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

  // 豆包 ASR：会话在主进程运行（安全隔离下 preload 不能加载 Node 侧模块），
  // 这里只做消息转发；转写/状态事件经 doubao-stt-event 推回页面。
  doubaoSttStart: (options) => ipcRenderer.invoke('doubao-stt-start', options),
  doubaoSttSend: (payload) => ipcRenderer.invoke('doubao-stt-send', payload),
  doubaoSttClose: (sessionId) => ipcRenderer.invoke('doubao-stt-close', sessionId),
  onDoubaoSttEvent: (cb) => sub('doubao-stt-event', cb),

  // 生成答案
  generateAnswer: (payload) => ipcRenderer.send('generate-answer', payload),
  cancelGenerate: () => ipcRenderer.send('cancel-generate'),
  listModels: (payload) => ipcRenderer.invoke('list-models', payload),

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
