'use strict';

/* global startListening:writable, openSettings:writable, saveSettings:writable */
/* global $, state, renderHotkeyHint, toast, setStatus, handleSystemCaptureError */
/* global getMicStream, getSystemStream, handleTranscript, wireStream, clearEmptyState */
/* global addDaySeparator, setLive, setListeningUI, listInputDevices, stopListening */
/* global triggerGenerate */

// Optional two-computer question-capture mode layered on top of the existing app.
// The existing hotkey remains user-configurable in Settings, but its behavior becomes:
// first press = start capturing the interviewer; second press = stop capture and answer.

const baseStartListening = startListening;
const baseOpenSettings = openSettings;
const baseSaveSettings = saveSettings;

let captureStartIndex = null;
let captureStartedListening = false;
let captureFinishing = false;
let doubaoSeq = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class DoubaoLive {
  constructor(opts) {
    this.apiKey = opts.apiKey;
    this.appKey = opts.appKey;
    this.accessKey = opts.accessKey;
    this.resourceId = opts.resourceId;
    this.wsUrl = opts.wsUrl;
    this.language = opts.language || 'zh';
    this.sampleRate = opts.sampleRate || 16000;
    this.onTranscript = opts.onTranscript || (() => {});
    this.onState = opts.onState || (() => {});
    this.sessionId = `doubao_${Date.now()}_${++doubaoSeq}`;
    this.unsub = null;
    this.closed = false;
    this.closePromise = null;
  }

  connect() {
    this.unsub = window.api.onDoubaoSttEvent((evt) => {
      if (!evt || evt.sessionId !== this.sessionId) return;
      if (evt.type === 'transcript') {
        this.onTranscript({ text: evt.text || '', isFinal: !!evt.isFinal });
      } else if (evt.type === 'state') {
        this.onState(evt.state, evt.info || '');
      }
    });

    return window.api
      .doubaoSttStart({
        sessionId: this.sessionId,
        apiKey: this.apiKey,
        appKey: this.appKey,
        accessKey: this.accessKey,
        resourceId: this.resourceId,
        wsUrl: this.wsUrl,
        language: this.language,
        sampleRate: this.sampleRate,
      })
      .catch((e) => {
        this.onState('error', e.message);
        throw e;
      });
  }

  send(buffer) {
    if (this.closed) return;
    window.api.doubaoSttSend({ sessionId: this.sessionId, buffer });
  }

  close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = window.api.doubaoSttClose(this.sessionId).finally(() => {
      if (this.unsub) this.unsub();
      this.unsub = null;
    });
    return this.closePromise;
  }
}

function ensureCaptureSettingsUI() {
  const hotkeyInput = $('setHotkey');
  const deepgramInput = $('setDeepgram');
  if (!hotkeyInput || !deepgramInput) return;

  const deepgramSetting = deepgramInput.closest('.setting');
  if (!$('setSttProvider')) {
    const provider = document.createElement('label');
    provider.className = 'setting';
    provider.innerHTML =
      '<span>语音转写服务</span>' +
      '<select id="setSttProvider">' +
      '<option value="deepgram">Deepgram</option>' +
      '<option value="doubao">Doubao / Volcengine</option>' +
      '</select>';
    deepgramSetting.insertAdjacentElement('beforebegin', provider);

    const doubao = document.createElement('div');
    doubao.id = 'doubaoSttSettings';
    doubao.innerHTML =
      '<label class="setting"><span>Doubao API Key（新控制台，推荐）</span>' +
      '<input type="password" id="setDoubaoApiKey" placeholder="API Key" /></label>' +
      '<p class="note">如果你的账号仍在使用旧版应用凭证，请留空 API Key，并填写下面两项。</p>' +
      '<label class="setting"><span>Doubao App ID / App Key（旧版）</span>' +
      '<input type="text" id="setDoubaoAppKey" placeholder="火山引擎控制台中的 App ID" /></label>' +
      '<label class="setting"><span>Doubao Access Token（旧版）</span>' +
      '<input type="password" id="setDoubaoAccessKey" placeholder="Access Token" /></label>' +
      '<label class="setting"><span>Doubao Resource ID</span>' +
      '<input type="text" id="setDoubaoResourceId" placeholder="volc.seedasr.sauc.duration" /></label>' +
      '<p class="note">使用 ASR 2.0 流式输入模式（bigmodel_nostream），采集结束后返回完整的最终问题。</p>';
    deepgramSetting.insertAdjacentElement('afterend', doubao);

    $('setSttProvider').onchange = updateSttProviderUI;
  }

  const hotkeyLabel = hotkeyInput.closest('.setting');
  const hotkeyTitle = hotkeyLabel && hotkeyLabel.querySelector('span');
  if (hotkeyTitle) {
    hotkeyTitle.textContent = '问题采集快捷键（按一次开始采集，再按一次停止并作答）';
  }

  if (!$('setCaptureCandidateMic')) {
    const label = document.createElement('label');
    label.className = 'setting';
    label.innerHTML =
      '<span>采集候选人麦克风</span>' +
      '<select id="setCaptureCandidateMic">' +
      '<option value="true">开启 —— 转写面试官 + 候选人</option>' +
      '<option value="false">关闭 —— 仅采集面试官声音</option>' +
      '</select>';

    const row = hotkeyLabel ? hotkeyLabel.closest('.setting-row') : null;
    if (row) row.insertAdjacentElement('afterend', label);
  }
}

function updateSttProviderUI() {
  const provider = $('setSttProvider') ? $('setSttProvider').value : 'deepgram';
  const deepgramSetting = $('setDeepgram') && $('setDeepgram').closest('.setting');
  if (deepgramSetting) deepgramSetting.style.display = provider === 'deepgram' ? '' : 'none';
  if ($('doubaoSttSettings')) {
    $('doubaoSttSettings').style.display = provider === 'doubao' ? '' : 'none';
  }
}

function applyCaptureSettingsUI() {
  if (!state.settings) return;
  ensureCaptureSettingsUI();

  if ($('setSttProvider')) $('setSttProvider').value = state.settings.sttProvider || 'deepgram';
  updateSttProviderUI();

  const enabled = state.settings.captureCandidateMic !== false;
  if ($('micSelect')) {
    $('micSelect').disabled = !enabled;
    const field = $('micSelect').closest('.field');
    if (field) {
      field.title = enabled ? '候选人麦克风已开启' : '候选人麦克风已在设置中关闭';
    }
  }

  const hint = document.querySelector('.kbd-hint');
  if (hint) {
    hint.innerHTML = '按 <span id="hotkeyHint"></span> 开始/结束问题采集';
    renderHotkeyHint(state.settings.hotkey || 'Control+A');
  }

  const box = $('questionBox');
  if (box) {
    box.placeholder =
      '面试官开始提问时按一次采集快捷键，问题结束时再按一次即可自动作答；也可以直接在这里输入问题…';
  }
}

openSettings = function () {
  ensureCaptureSettingsUI();
  baseOpenSettings();
  $('setSttProvider').value = state.settings.sttProvider || 'deepgram';
  $('setDoubaoApiKey').value = state.settings.doubaoApiKey || '';
  $('setDoubaoAppKey').value = state.settings.doubaoAppKey || '';
  $('setDoubaoAccessKey').value = state.settings.doubaoAccessKey || '';
  $('setDoubaoResourceId').value = state.settings.doubaoResourceId || 'volc.seedasr.sauc.duration';
  $('setCaptureCandidateMic').value =
    state.settings.captureCandidateMic === false ? 'false' : 'true';
  updateSttProviderUI();
};

saveSettings = async function () {
  ensureCaptureSettingsUI();
  const extra = {
    sttProvider: $('setSttProvider').value || 'deepgram',
    doubaoApiKey: $('setDoubaoApiKey').value.trim(),
    doubaoAppKey: $('setDoubaoAppKey').value.trim(),
    doubaoAccessKey: $('setDoubaoAccessKey').value.trim(),
    doubaoResourceId: $('setDoubaoResourceId').value.trim() || 'volc.seedasr.sauc.duration',
    captureCandidateMic: $('setCaptureCandidateMic').value !== 'false',
  };
  await baseSaveSettings();
  state.settings = await window.api.saveSettings(extra);
  applyCaptureSettingsUI();
};

function onSttState(provider, which, s, info) {
  if (s === 'error') {
    setStatus('转写出错', 'error');
    if (info) toast(`${provider} (${which}): ${info}`, true);
  }
}

function makeSttClient(role) {
  const s = state.settings;
  const provider = s.sttProvider || 'deepgram';
  const lang = s.sttLanguage || 'en-US';
  const onTranscript = (r) => handleTranscript(role, r);
  const which = role === 'interviewer' ? 'interviewer' : 'candidate';

  if (provider === 'doubao') {
    return new DoubaoLive({
      apiKey: s.doubaoApiKey,
      appKey: s.doubaoAppKey,
      accessKey: s.doubaoAccessKey,
      resourceId: s.doubaoResourceId || 'volc.seedasr.sauc.duration',
      wsUrl: s.doubaoWsUrl || 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream',
      language: lang,
      onTranscript,
      onState: (stateName, info) => onSttState('Doubao', which, stateName, info),
    });
  }

  return new window.DeepgramLive({
    apiKey: s.deepgramApiKey,
    language: lang,
    onTranscript,
    onState: (stateName, info) => onSttState('Deepgram', which, stateName, info),
  });
}

function validateSttSettings() {
  const s = state.settings || {};
  const provider = s.sttProvider || 'deepgram';
  if (provider === 'doubao') {
    const hasModern = !!s.doubaoApiKey;
    const hasLegacy = !!s.doubaoAppKey && !!s.doubaoAccessKey;
    if (!hasModern && !hasLegacy) {
      toast('请先在设置中填写 Doubao API Key，或 App ID + Access Token', true);
      openSettings();
      return false;
    }
    const lang = s.sttLanguage || 'en-US';
    if (!['zh', 'en-US', 'multi'].includes(lang)) {
      toast('本应用中的 Doubao ASR 目前仅支持中文/英文', true);
      openSettings();
      return false;
    }
    return true;
  }
  if (!s.deepgramApiKey) {
    toast('请先在设置中填写 Deepgram API Key', true);
    openSettings();
    return false;
  }
  return true;
}

// Deepgram + candidate mic enabled can keep using the upstream implementation.
// Every other case goes through this provider-neutral path so Doubao can reuse the same PCM capture.
startListening = async function () {
  if (!state.settings) return;
  const provider = state.settings.sttProvider || 'deepgram';
  const captureCandidate = state.settings.captureCandidateMic !== false;
  if (provider === 'deepgram' && captureCandidate) return baseStartListening();
  if (!validateSttSettings()) return;

  setStatus('初始化…');
  try {
    const sysVal = $('sysSelect').value;
    const needsMicPermission = captureCandidate || sysVal !== '__loopback__';
    if (needsMicPermission) await window.api.ensureMicPermission();

    let micStream = null;
    if (captureCandidate) micStream = await getMicStream($('micSelect').value);

    let sysStream = null;
    try {
      if (sysVal === '__loopback__' && (await window.api.getScreenPermission()) === 'denied') {
        await handleSystemCaptureError(new Error('屏幕录制权限被拒绝'), sysVal);
      } else {
        sysStream = await getSystemStream(sysVal);
      }
    } catch (e) {
      console.error('interviewer audio capture failed:', e);
      await handleSystemCaptureError(e, sysVal);
    }

    if (!micStream && !sysStream) {
      throw new Error('没有可用的音频源，请先选择面试官的输入设备。');
    }

    state.dgMic = null;
    state.dgSys = null;

    if (micStream) {
      state.dgMic = makeSttClient('interviewee');
      await wireStream(micStream, state.dgMic);
      state.streams.push(micStream);
      await state.dgMic.connect();
    }

    if (sysStream) {
      state.dgSys = makeSttClient('interviewer');
      await wireStream(sysStream, state.dgSys);
      state.streams.push(sysStream);
      await state.dgSys.connect();
    }

    state.listening = true;
    state.sessionStart = Date.now();
    state.lastAutoKey = null;
    clearEmptyState();
    if (!$('transcript').querySelector('.day-sep')) addDaySeparator();
    setLive(true);
    setListeningUI(true);
    setStatus(`监听中 · ${provider === 'doubao' ? 'Doubao' : 'Deepgram'}`, 'live');
    listInputDevices();
  } catch (e) {
    console.error(e);
    setStatus('启动失败', 'error');
    toast('启动失败：' + e.message, true);
    await stopListening();
  }
};

async function beginQuestionCapture() {
  captureStartIndex = state.history.length;
  captureStartedListening = !state.listening;
  $('questionBox').value = '';
  state.autoQuestion = '';

  if (!state.listening) await startListening();
  if (!state.listening) {
    captureStartIndex = null;
    captureStartedListening = false;
    return;
  }

  setStatus('正在采集问题', 'live');
  toast('已开始采集问题 —— 面试官问完后再按一次快捷键。');
}

async function finishQuestionCapture() {
  if (captureStartIndex === null || captureFinishing) return;
  captureFinishing = true;

  const startIndex = captureStartIndex;
  const startedListeningHere = captureStartedListening;
  const provider = state.settings.sttProvider || 'deepgram';

  if (provider === 'doubao') {
    // nostream 的最终结果在 close 后才返回；stopListening 会 await closePromise，
    // 因此停下来时最终转写已入库，实现「先定稿再作答」。
    await stopListening();
  } else {
    // Deepgram uses a short trailing-silence window to produce its final transcript.
    await sleep(500);
  }

  const finalText = state.history
    .slice(startIndex)
    .filter((h) => h.role === 'interviewer')
    .map((h) => h.text)
    .join(' ')
    .trim();
  const interimText =
    (state.interim.interviewer &&
      state.interim.interviewer.querySelector('.bubble')?.textContent) ||
    '';
  const question = finalText || interimText.trim();

  captureStartIndex = null;
  captureStartedListening = false;

  if (provider !== 'doubao' && startedListeningHere) await stopListening();

  if (!question) {
    toast('本次采集没有转写到面试官的语音。', true);
    captureFinishing = false;
    return;
  }

  $('questionBox').value = question;
  state.autoQuestion = '';
  setStatus(state.listening ? '监听中' : '空闲', state.listening ? 'live' : undefined);
  triggerGenerate();
  captureFinishing = false;
}

async function toggleQuestionCapture() {
  if (captureFinishing || state.generating) return;
  if (captureStartIndex === null) await beginQuestionCapture();
  else await finishQuestionCapture();
}

function initCaptureMode() {
  ensureCaptureSettingsUI();
  applyCaptureSettingsUI();

  // app.js registered the legacy "hotkey => generate immediately" listener during init().
  // Replace it with the two-press capture flow after init has completed.
  window.api.clearHotkeyGenerateListeners();
  window.api.onHotkeyGenerate(() => {
    void toggleQuestionCapture();
  });
}

// 本脚本通过 <script> 紧随 app.js 同步加载（覆盖在 init 绑定事件之前生效）；
// 接管热键语义必须等 init 完成，否则会清掉尚未注册的旧监听器。
window.addEventListener('app-ready', initCaptureMode, { once: true });
