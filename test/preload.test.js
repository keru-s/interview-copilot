'use strict';

// 预加载脚本运行在 Electron 安全隔离环境：除 'electron' 外不能 require 任何本地模块，
// 否则整个入口失败、页面接口全部失效（曾出现 "module not found: ./doubaoAsr"）。
// 这条测试锁定“preload 只做消息转发”的约束，防止该回归。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');

const PRELOAD = path.join(__dirname, '../src/main/preload.js');

function loadPreload() {
  const exposed = {};
  const calls = { invoke: [], send: [], on: [] };
  const ipcRenderer = {
    invoke: (channel, payload) => {
      calls.invoke.push({ channel, payload });
      return Promise.resolve({ ok: true });
    },
    send: (channel, payload) => calls.send.push({ channel, payload }),
    on: (channel) => calls.on.push(channel),
    removeListener: () => {},
    removeAllListeners: () => {},
  };

  const originalLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'electron') {
      return {
        contextBridge: {
          exposeInMainWorld: (name, api) => {
            exposed[name] = api;
          },
        },
        ipcRenderer,
      };
    }
    if (request.startsWith('.')) {
      throw new Error(`preload must not require local module: ${request}`);
    }
    return originalLoad.call(this, request, ...rest);
  };

  globalThis.window = { addEventListener: () => {} };
  globalThis.document = {};
  try {
    delete require.cache[require.resolve(PRELOAD)];
    require(PRELOAD);
  } finally {
    Module._load = originalLoad;
    delete globalThis.window;
    delete globalThis.document;
    delete require.cache[require.resolve(PRELOAD)];
  }
  return { api: exposed.api, calls };
}

test('preload loads under sandbox restrictions and exposes the bridge API', () => {
  const { api } = loadPreload();
  assert.ok(api, 'window.api was not exposed');
  for (const fn of [
    'getSettings',
    'saveSettings',
    'generateAnswer',
    'cancelGenerate',
    'listModels',
    'onHotkeyGenerate',
    'clearHotkeyGenerateListeners',
    'onHotkeyError',
    'doubaoSttStart',
    'doubaoSttSend',
    'doubaoSttClose',
    'onDoubaoSttEvent',
  ]) {
    assert.equal(typeof api[fn], 'function', `window.api.${fn} missing`);
  }
});

test('preload doubao bridge forwards to IPC channels', async () => {
  const { api, calls } = loadPreload();

  await api.doubaoSttStart({ sessionId: 's1' });
  await api.doubaoSttSend({ sessionId: 's1', buffer: new ArrayBuffer(4) });
  await api.doubaoSttClose('s1');

  assert.deepEqual(
    calls.invoke.map((c) => c.channel),
    ['doubao-stt-start', 'doubao-stt-send', 'doubao-stt-close'],
  );

  const unsubscribe = api.onDoubaoSttEvent(() => {});
  assert.ok(calls.on.includes('doubao-stt-event'));
  assert.equal(typeof unsubscribe, 'function');
});

test('index.html loads capture-mode synchronously after app.js', () => {
  // capture-mode.js 覆盖 app.js 的全局函数（openSettings/saveSettings/startListening）。
  // 必须作为普通 <script> 紧随 app.js 加载：晚于 DOMContentLoaded 注入会与 init() 的
  // 事件绑定产生竞态（按钮绑到覆盖前的旧函数，扩展设置无法保存）。
  const html = fs.readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8');
  const order = ['deepgram.js', 'app.js', 'capture-mode.js'].map((f) => html.indexOf(`src="${f}"`));
  assert.ok(
    order.every((i) => i >= 0),
    'all renderer scripts must be plain script tags',
  );
  assert.ok(
    order.every((v, i) => i === 0 || order[i - 1] < v),
    `script order must be ${'deepgram.js < app.js < capture-mode.js'}`,
  );

  const preloadSource = fs.readFileSync(PRELOAD, 'utf8');
  assert.ok(
    !preloadSource.includes('createElement'),
    'preload must not inject renderer scripts (DOM injection races init)',
  );
});
