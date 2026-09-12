'use strict';

const path = require('path');
const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  globalShortcut,
  session,
  desktopCapturer,
  systemPreferences,
  shell,
} = require('electron');

const settingsStore = require('./settings');
const store = require('./store');
const docs = require('./documents');
const llm = require('./llm');
const gemini = require('./gemini');
const openaiCompat = require('./openaiCompat');
const prompt = require('./prompt');
const { DoubaoAsrSession } = require('./doubaoAsr');
const { PROVIDERS } = require('./config');

// 按当前 Provider（config.js 注册表）解析出：流式实现 / Key / baseURL / 模型链
function resolveProvider(s) {
  const id = s.provider && PROVIDERS[s.provider] ? s.provider : 'gemini';
  const p = PROVIDERS[id];
  const model = ((s[p.modelField] || '') + '').trim() || p.defaultModel;
  const models = [model, ...(p.fallbacks || [])].filter((m, i, a) => a.indexOf(m) === i);
  return {
    id,
    label: p.label,
    type: p.type,
    needsKey: !!p.keyField && !p.optionalKey,
    apiKey: p.keyField ? s[p.keyField] || '' : '',
    baseURL: p.baseURLField ? ((s[p.baseURLField] || '') + '').trim() || p.baseURL : p.baseURL,
    models,
    temperature: p.temperature,
    reasoningEffort: p.reasoningField ? (s[p.reasoningField] || '') + '' : '',
    streamFn: p.type === 'gemini' ? gemini.generateAnswerStream : openaiCompat.generateAnswerStream,
  };
}

// 固定 app 名，保证 dev 运行与打包后的 .app 使用同一份 userData/settings.json
app.setName('interview-copilot');

let mainWindow = null;
let currentSettings = settingsStore.load();
let activeGen = null; // { id, controller }

// 豆包 ASR 会话表。预加载脚本运行在安全隔离环境，不能加载 Node 侧模块，
// 因此会话由主进程托管，渲染进程只通过 doubao-stt-* 窄通道收发消息。
const doubaoSessions = new Map();

function emitDoubaoEvent(sender, sessionId, payload) {
  if (sender && !sender.isDestroyed()) {
    sender.send('doubao-stt-event', { sessionId, ...payload });
  }
}

function closeAllDoubaoSessions() {
  for (const session of doubaoSessions.values()) {
    try {
      session.abort();
    } catch (_e) {
      /* ignore */
    }
  }
  doubaoSessions.clear();
}

function createWindow() {
  const smoke = !!process.env.INTERVIEW_SMOKE;
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    show: !smoke,
    backgroundColor: '#0f1117',
    title: 'Real Time Interview Copilot',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  if (smoke) {
    mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
      console.error('[smoke] load failed', code, desc);
      process.exit(1);
    });
    mainWindow.webContents.on('console-message', (_e, level, message) => {
      console.log('[renderer]', message);
    });
    mainWindow.webContents.on('did-finish-load', async () => {
      try {
        // capture-mode.js 在 app-ready 之后才接管 UI，init 含 IPC 与设备枚举，需要轮询等待。
        const evalCheck = () =>
          mainWindow.webContents.executeJavaScript(`(() => {
            const api = window.api;
            const fns = [
              'getSettings', 'saveSettings', 'generateAnswer', 'listModels',
              'doubaoSttStart', 'doubaoSttSend', 'doubaoSttClose', 'onDoubaoSttEvent',
              'onHotkeyGenerate', 'clearHotkeyGenerateListeners', 'onHotkeyError',
              'openMicSettings',
            ];
            return {
              hasApi: !!api,
              missing: fns.filter((name) => !api || typeof api[name] !== 'function'),
              captureModeLoaded: !!document.getElementById('setSttProvider'),
              hasOpenSettings: typeof openSettings === 'function',
            };
          })()`);
        let check = null;
        for (let i = 0; i < 20; i += 1) {
          check = await evalCheck();
          if (check.hasApi && check.captureModeLoaded) break;
          await new Promise((r) => setTimeout(r, 300));
        }
        const ok =
          check.hasApi && !check.missing.length && check.captureModeLoaded && check.hasOpenSettings;
        if (!ok) {
          console.error('[smoke] renderer API check failed', JSON.stringify(check));
          process.exit(1);
        }
        console.log('[smoke] window loaded OK');
        app.quit();
      } catch (e) {
        console.error('[smoke] check errored', e);
        process.exit(1);
      }
    });
  }

  // 渲染层订阅可能晚于启动时的热键注册失败事件，加载完成后补发一次。
  mainWindow.webContents.on('did-finish-load', () => {
    if (lastHotkeyError && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('hotkey-error', lastHotkeyError);
    }
  });

  // 截图模式：注入一段演示对话，截取窗口写到 assets/screenshot.png 后退出（仅用于生成 README 图）。
  if (process.env.INTERVIEW_SCREENSHOT) {
    mainWindow.webContents.on('did-finish-load', () => {
      // 等 init() 跑完再注入演示内容，避免被 showEmptyState 覆盖。
      setTimeout(async () => {
        try {
          const fs = require('fs');
          await mainWindow.webContents.executeJavaScript(require('./_screenshotDemo').demoJs());
          await new Promise((r) => setTimeout(r, 350));
          const img = await mainWindow.webContents.capturePage();
          const out = path.join(__dirname, '..', '..', 'assets', 'screenshot.png');
          fs.mkdirSync(path.dirname(out), { recursive: true });
          fs.writeFileSync(out, img.toPNG());
          console.log('[screenshot] wrote', out);
        } catch (e) {
          console.error('[screenshot] failed', e);
        }
        app.quit();
      }, 1000);
    });
  }

  // GIF 模式：按 _gifDemo 的时间线逐帧截图，用 ffmpeg 合成 assets/demo.gif（需要 ffmpeg）。
  if (process.env.INTERVIEW_GIF) {
    mainWindow.webContents.on('did-finish-load', () => {
      setTimeout(async () => {
        const fs = require('fs');
        const os = require('os');
        const { spawnSync } = require('child_process');
        try {
          const { steps } = require('./_gifDemo');
          const tmp = path.join(os.tmpdir(), 'ic-gif-frames');
          fs.rmSync(tmp, { recursive: true, force: true });
          fs.mkdirSync(tmp, { recursive: true });
          let n = 0;
          for (const s of steps()) {
            await mainWindow.webContents.executeJavaScript(s.js);
            for (let h = 0; h < (s.hold || 1); h++) {
              await new Promise((r) => setTimeout(r, 50));
              const img = await mainWindow.webContents.capturePage();
              fs.writeFileSync(
                path.join(tmp, `f_${String(n++).padStart(4, '0')}.png`),
                img.toPNG(),
              );
            }
          }
          const out = path.join(__dirname, '..', '..', 'assets', 'demo.gif');
          fs.mkdirSync(path.dirname(out), { recursive: true });
          const vf =
            'scale=900:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer';
          const r = spawnSync(
            'ffmpeg',
            [
              '-y',
              '-framerate',
              '9',
              '-i',
              path.join(tmp, 'f_%04d.png'),
              '-vf',
              vf,
              '-loop',
              '0',
              out,
            ],
            { encoding: 'utf8' },
          );
          if (r.status === 0) console.log('[gif] wrote', out, `(${n} frames)`);
          else
            console.error(
              '[gif] ffmpeg failed',
              (r.stderr || r.error || '').toString().slice(-600),
            );
        } catch (e) {
          console.error('[gif] failed', e);
        }
        app.quit();
      }, 1000);
    });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
    closeAllDoubaoSessions();
  });
}

// 允许渲染进程通过 getDisplayMedia 采集系统声音（面试官）。
function setupDisplayMediaLoopback() {
  session.defaultSession.setDisplayMediaRequestHandler(
    async (request, callback) => {
      // macOS 13+ : audio: 'loopback' 直接抓系统声音（需要「屏幕录制」权限）。
      // getSources 失败几乎都是没授予屏幕录制权限——安静地拒绝，由渲染层引导用户去授权。
      try {
        const sources = await desktopCapturer.getSources({ types: ['screen'] });
        if (sources && sources.length) {
          callback({ video: sources[0], audio: 'loopback' });
        } else {
          console.warn('No screen sources (grant Screen Recording permission for system audio).');
          callback({});
        }
      } catch (_e) {
        console.warn('System-audio capture unavailable — grant Screen Recording permission.');
        callback({});
      }
    },
    { useSystemPicker: false },
  );
}

// 当前生效的热键与最近一次注册失败信息（启动失败时渲染层尚未订阅，加载完成后补发）。
let activeHotkey = null;
let lastHotkeyError = null;

const onHotkey = () => {
  if (mainWindow) mainWindow.webContents.send('hotkey-generate');
};

function notifyHotkeyError(payload) {
  lastHotkeyError = payload;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('hotkey-error', payload);
  }
}

function tryRegisterHotkey(key) {
  try {
    return globalShortcut.register(key, onHotkey);
  } catch (_e) {
    return false;
  }
}

// 启动时注册持久化的热键；失败时回退到默认热键并把修复写回设置。
function registerHotkey() {
  const key = currentSettings.hotkey || 'Control+A';
  globalShortcut.unregisterAll();
  activeHotkey = null;
  if (tryRegisterHotkey(key)) {
    activeHotkey = key;
    return true;
  }
  console.warn(`热键 ${key} 注册失败（可能被占用或格式非法）`);
  let fallback = null;
  if (key !== 'Control+A' && tryRegisterHotkey('Control+A')) {
    fallback = 'Control+A';
    activeHotkey = fallback;
    currentSettings = settingsStore.save({ hotkey: fallback });
  }
  notifyHotkeyError({ key, fallback });
  return false;
}

// ---------- IPC ----------

ipcMain.handle('get-settings', () => currentSettings);

ipcMain.handle('save-settings', (_e, partial) => {
  const patch = { ...(partial || {}) };
  // 热键先验后存：新热键注册成功才持久化；失败则旧热键保持生效并通知渲染层。
  if (patch.hotkey && patch.hotkey !== activeHotkey) {
    if (tryRegisterHotkey(patch.hotkey)) {
      if (activeHotkey) globalShortcut.unregister(activeHotkey);
      activeHotkey = patch.hotkey;
      lastHotkeyError = null;
    } else {
      console.warn(`热键 ${patch.hotkey} 注册失败（可能被占用或格式非法）`);
      notifyHotkeyError({ key: patch.hotkey, fallback: activeHotkey });
      delete patch.hotkey;
    }
  }
  currentSettings = settingsStore.save(patch);
  return currentSettings;
});

ipcMain.handle('list-documents', () => store.summary());

ipcMain.handle('remove-document', (_e, id) => store.remove(id));

ipcMain.handle('clear-documents', () => store.clear());

ipcMain.handle('pick-documents', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择面试资料（简历 / JD / 笔记等）',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '文档', extensions: ['txt', 'md', 'markdown', 'pdf', 'docx', 'json', 'csv', 'log'] },
      { name: '全部文件', extensions: ['*'] },
    ],
  });
  if (result.canceled) return { canceled: true, docs: store.summary() };

  const errors = [];
  for (const filePath of result.filePaths) {
    try {
      const text = await docs.parseFile(filePath);
      store.add(path.basename(filePath), text);
    } catch (e) {
      errors.push(`${path.basename(filePath)}: ${e.message}`);
    }
  }
  return { canceled: false, docs: store.summary(), errors };
});

// 添加手动粘贴的资料文本
ipcMain.handle('add-text-document', (_e, { name, text }) => {
  store.add(name || '手动输入', text || '');
  return store.summary();
});

// 选择并解析一个 JD 文件，返回纯文本（持久化由设置完成）
ipcMain.handle('pick-jd', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择岗位 JD 文件',
    properties: ['openFile'],
    filters: [
      { name: '文档', extensions: ['txt', 'md', 'markdown', 'pdf', 'docx', 'json'] },
      { name: '全部文件', extensions: ['*'] },
    ],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  try {
    const text = await docs.parseFile(result.filePaths[0]);
    return { name: path.basename(result.filePaths[0]), text };
  } catch (e) {
    return { name: '', text: '', error: e.message };
  }
});

// 豆包 ASR：开始会话。转写与状态事件通过 doubao-stt-event 回发到发起页面。
ipcMain.handle('doubao-stt-start', async (e, options = {}) => {
  const sessionId = String(options.sessionId || '');
  if (!sessionId) throw new Error('Doubao sessionId is required');

  const previous = doubaoSessions.get(sessionId);
  if (previous) previous.abort();

  const sender = e.sender;
  const session = new DoubaoAsrSession({
    apiKey: options.apiKey,
    appKey: options.appKey,
    accessKey: options.accessKey,
    resourceId: options.resourceId,
    wsUrl: options.wsUrl,
    language: options.language,
    sampleRate: options.sampleRate,
    onTranscript: (result) => emitDoubaoEvent(sender, sessionId, { type: 'transcript', ...result }),
    onState: (state, info) => emitDoubaoEvent(sender, sessionId, { type: 'state', state, info }),
  });
  doubaoSessions.set(sessionId, session);
  try {
    await session.connect();
    return { ok: true };
  } catch (err) {
    doubaoSessions.delete(sessionId);
    try {
      session.abort();
    } catch (_e) {
      /* ignore */
    }
    throw err;
  }
});

// 豆包 ASR：发送一段 PCM（16kHz / 16-bit / mono）。
ipcMain.handle('doubao-stt-send', (_e, { sessionId, buffer } = {}) => {
  const session = doubaoSessions.get(String(sessionId || ''));
  if (!session || !buffer) return false;
  session.send(buffer);
  return true;
});

// 豆包 ASR：发送最终包并等待服务端最终响应后关闭。
ipcMain.handle('doubao-stt-close', async (_e, sessionId) => {
  const key = String(sessionId || '');
  const session = doubaoSessions.get(key);
  if (!session) return false;
  try {
    await session.close();
    return true;
  } finally {
    doubaoSessions.delete(key);
  }
});

// 拉取 OpenAI 兼容端点的模型列表：GET {base}/models（base 由 chat/completions 地址推导）。
ipcMain.handle('list-models', async (_e, { baseURL, apiKey } = {}) => {
  const base = ((baseURL || '') + '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/chat\/completions$/, '');
  if (!base) return { models: [], error: '请求地址为空' };
  const headers = {};
  if (apiKey) headers.Authorization = 'Bearer ' + apiKey;
  try {
    const res = await fetch(`${base}/models`, { headers });
    if (!res.ok) {
      let txt = '';
      try {
        txt = await res.text();
      } catch (_e) {
        /* ignore */
      }
      return { models: [], error: `获取模型列表失败 (${res.status}): ${txt.slice(0, 200)}` };
    }
    const json = await res.json();
    const models = (Array.isArray(json.data) ? json.data : [])
      .map((m) => (m && (m.id || m.name)) || '')
      .filter(Boolean)
      .sort();
    return { models };
  } catch (e) {
    return { models: [], error: `获取模型列表失败: ${e.message}` };
  }
});

// 取消正在进行的生成
ipcMain.on('cancel-generate', () => {
  if (activeGen) {
    try {
      activeGen.controller.abort();
    } catch (_e) {
      /* ignore */
    }
    activeGen = null;
  }
});

// 生成答案（流式）
ipcMain.on('generate-answer', async (_e, { reqId, question, transcript }) => {
  const send = (channel, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, { reqId, ...payload });
    }
  };

  const q = (question || '').trim();
  const tr = (transcript || '').trim();
  if (!q && !tr) {
    send('answer-error', { message: '没有识别到对话内容，请先开始监听，或在问题框手动输入。' });
    return;
  }

  const prov = resolveProvider(currentSettings);
  if (prov.needsKey && !prov.apiKey) {
    send('answer-error', { message: `未配置 ${prov.label} API Key，请在「设置」中填写。` });
    return;
  }
  if (!prov.baseURL || !prov.models[0]) {
    send('answer-error', {
      message: `请在「设置」中完善 ${prov.label} 的请求地址和模型名。`,
    });
    return;
  }

  // 取消上一个
  if (activeGen) {
    try {
      activeGen.controller.abort();
    } catch (_e) {
      /* ignore */
    }
  }
  const controller = new AbortController();
  activeGen = { id: reqId, controller };

  const context = store.buildContext(currentSettings.maxContextChars || 60000);
  const { systemInstruction, userText } = prompt.buildPrompt({
    question: q,
    transcript: tr,
    context,
    answerLanguage: currentSettings.answerLanguage || 'auto',
    maxChars: currentSettings.maxChars || 500,
    profile: currentSettings.interviewProfile || '',
    jobDescription: currentSettings.jobDescription || '',
  });

  // 输出 token 上限。
  // - OpenAI 兼容类（含 DeepSeek/Ollama）可能是“推理模型”：max_tokens 需同时覆盖隐藏思考链，
  //   预算太小会导致答案为空，因此放宽，答案长度交给提示词控制（思考链不展示给用户）。
  // - Gemini 已关闭思考(thinkingBudget=0)，可按字数上限收紧做长度兜底。
  const maxChars = currentSettings.maxChars || 500;
  const lang = currentSettings.answerLanguage || 'auto';
  const perChar = lang === 'en' ? 0.5 : 1.1;
  const maxOutputTokens =
    prov.type === 'openai'
      ? 4096
      : Math.min(4096, Math.max(160, Math.ceil(maxChars * perChar * 1.15)));
  const extractTokens = prov.type === 'openai' ? 1024 : 80;

  const common = {
    streamFn: prov.streamFn,
    apiKey: prov.apiKey,
    baseURL: prov.baseURL,
    models: prov.models,
    // undefined 时走各 Provider 实现的默认值（0.6）；Kimi Code 的 k3 系列只接受 1。
    temperature: prov.temperature,
    // Kimi k3 的思考力度（low/high/max）；空字符串表示不下发，其他服务商忽略。
    reasoningEffort: prov.reasoningEffort,
    thinkingBudget: 0,
    signal: controller.signal,
  };

  // 提取模式（问题框留空）：并行跑一个轻量调用，把识别到的问题回填到「Current Question」框。
  // 问题只看最近几轮（末尾 6 行），与作答并行、不阻塞。
  if (!q && tr) {
    const recentTr = tr.split('\n').slice(-6).join('\n');
    llm
      .generateWithFallback({
        ...common,
        systemInstruction: prompt.EXTRACTION_SYSTEM,
        userText: prompt.buildExtractionUser(recentTr),
        maxOutputTokens: extractTokens,
        onChunk: () => {},
      })
      .then((r) => send('answer-question', { question: (r.text || '').trim() }))
      .catch(() => {});
  }

  try {
    await llm.generateWithFallback({
      ...common,
      systemInstruction,
      userText,
      maxOutputTokens,
      onStart: (model) => send('answer-start', { question: q, model, primary: prov.models[0] }),
      onChunk: (delta) => send('answer-chunk', { delta }),
    });
    send('answer-done', {});
  } catch (e) {
    if (e.name === 'AbortError') {
      send('answer-done', { aborted: true });
    } else {
      send('answer-error', { message: e.message });
    }
  } finally {
    if (activeGen && activeGen.id === reqId) activeGen = null;
  }
});

// 屏幕录制权限（macOS）—— 抓系统声音(Loopback) 需要它
ipcMain.handle('get-screen-permission', () => {
  if (process.platform !== 'darwin') return 'granted';
  return systemPreferences.getMediaAccessStatus('screen');
});

ipcMain.handle('open-screen-settings', () => {
  if (process.platform === 'darwin') {
    shell.openExternal(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
    );
  }
  return true;
});

ipcMain.handle('open-mic-settings', () => {
  if (process.platform === 'darwin') {
    shell.openExternal(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
    );
  }
  return true;
});

// 麦克风权限（macOS）
ipcMain.handle('ensure-mic-permission', async () => {
  if (process.platform !== 'darwin') return true;
  const status = systemPreferences.getMediaAccessStatus('microphone');
  if (status === 'granted') return true;
  try {
    return await systemPreferences.askForMediaAccess('microphone');
  } catch (_e) {
    return false;
  }
});

// ---------- app lifecycle ----------

app.whenReady().then(() => {
  // dev 运行(npm start)时也给 dock 上我们的图标；打包后用 bundle 自带的 icns。
  if (process.platform === 'darwin' && app.dock) {
    try {
      const devIcon = path.join(__dirname, '..', '..', 'build', 'icon.png');
      if (require('fs').existsSync(devIcon)) app.dock.setIcon(devIcon);
    } catch (_e) {
      /* ignore */
    }
  }
  setupDisplayMediaLoopback();
  createWindow();
  registerHotkey();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => {
  closeAllDoubaoSessions();
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
