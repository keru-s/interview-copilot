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

    window.api
      .doubaoSttStart({
        sessionId: this.sessionId,
        appKey: this.appKey,
        accessKey: this.accessKey,
        resourceId: this.resourceId,
        wsUrl: this.wsUrl,
        language: this.language,
        sampleRate: this.sampleRate,
      })
      .catch((e) => this.onState('error', e.message));
  }

  send(buffer) {
    if (this.closed) return;
    window.api.doubaoSttSend({ sessionId: this.sessionId, buffer });
  }

  close() {
    this.closed = true;
    window.api.doubaoSttClose(this.sessionId);
    if (this.unsub) this.unsub();
    this.unsub = null;
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
      '<span>Speech-to-text provider</span>' +
      '<select id="setSttProvider">' +
      '<option value="deepgram">Deepgram</option>' +
      '<option value="doubao">Doubao / Volcengine</option>' +
      '</select>';
    deepgramSetting.insertAdjacentElement('beforebegin', provider);

    const doubao = document.createElement('div');
    doubao.id = 'doubaoSttSettings';
    doubao.innerHTML =
      '<label class="setting"><span>Doubao App ID / App Key</span>' +
      '<input type="text" id="setDoubaoAppKey" placeholder="App ID from Volcengine console" /></label>' +
      '<label class="setting"><span>Doubao Access Token</span>' +
      '<input type="password" id="setDoubaoAccessKey" placeholder="Access Token" /></label>' +
      '<label class="setting"><span>Doubao Resource ID</span>' +
      '<input type="text" id="setDoubaoResourceId" placeholder="volc.seedasr.sauc.duration" /></label>' +
      '<p class="note">Doubao uses ASR 2.0 optimized bidirectional streaming (bigmodel_async). ' +
      'This app currently maps it to Chinese/English interview transcription.</p>';
    deepgramSetting.insertAdjacentElement('afterend', doubao);

    $('setSttProvider').onchange = updateSttProviderUI;
  }

  const hotkeyLabel = hotkeyInput.closest('.setting');
  const hotkeyTitle = hotkeyLabel && hotkeyLabel.querySelector('span');
  if (hotkeyTitle) {
    hotkeyTitle.textContent =
      'Question capture hotkey (press once to start, again to stop & answer)';
  }

  if (!$('setCaptureCandidateMic')) {
    const label = document.createElement('label');
    label.className = 'setting';
    label.innerHTML =
      '<span>Capture candidate microphone</span>' +
      '<select id="setCaptureCandidateMic">' +
      '<option value="true">Enabled — transcribe interviewer + candidate</option>' +
      '<option value="false">Disabled — interviewer audio only</option>' +
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
      field.title = enabled
        ? 'Candidate microphone is enabled'
        : 'Candidate microphone is disabled in Settings';
    }
  }

  const hint = document.querySelector('.kbd-hint');
  if (hint) {
    hint.innerHTML = 'Press <span id="hotkeyHint"></span> to start/stop question capture';
    renderHotkeyHint(state.settings.hotkey || 'Control+A');
  }

  const box = $('questionBox');
  if (box) {
    box.placeholder =
      'Press the capture hotkey once when the interviewer starts asking, then press it again when the question ends. You can also type a question here…';
  }
}

openSettings = function () {
  ensureCaptureSettingsUI();
  baseOpenSettings();
  $('setSttProvider').value = state.settings.sttProvider || 'deepgram';
  $('setDoubaoAppKey').value = state.settings.doubaoAppKey || '';
  $('setDoubaoAccessKey').value = state.settings.doubaoAccessKey || '';
  $('setDoubaoResourceId').value =
    state.settings.doubaoResourceId || 'volc.seedasr.sauc.duration';
  $('setCaptureCandidateMic').value =
    state.settings.captureCandidateMic === false ? 'false' : 'true';
  updateSttProviderUI();
};

saveSettings = async function () {
  ensureCaptureSettingsUI();
  const extra = {
    sttProvider: $('setSttProvider').value || 'deepgram',
    doubaoAppKey: $('setDoubaoAppKey').value.trim(),
    doubaoAccessKey: $('setDoubaoAccessKey').value.trim(),
    doubaoResourceId:
      $('setDoubaoResourceId').value.trim() || 'volc.seedasr.sauc.duration',
    captureCandidateMic: $('setCaptureCandidateMic').value !== 'false',
  };
  await baseSaveSettings();
  state.settings = await window.api.saveSettings(extra);
  applyCaptureSettingsUI();
};

function onSttState(provider, which, s, info) {
  if (s === 'error') {
    setStatus('Transcription error', 'error');
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
      appKey: s.doubaoAppKey,
      accessKey: s.doubaoAccessKey,
      resourceId: s.doubaoResourceId || 'volc.seedasr.sauc.duration',
      wsUrl:
        s.doubaoWsUrl || 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async',
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
    if (!s.doubaoAppKey || !s.doubaoAccessKey) {
      toast('Add your Doubao App ID and Access Token in Settings first', true);
      openSettings();
      return false;
    }
    const lang = s.sttLanguage || 'en-US';
    if (!['zh', 'en-US', 'multi'].includes(lang)) {
      toast('Doubao bidirectional ASR in this app currently supports Chinese/English', true);
      openSettings();
      return false;
    }
    return true;
  }
  if (!s.deepgramApiKey) {
    toast('Add your Deepgram API key in Settings first', true);
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

  setStatus('Initializing…');
  try {
    const sysVal = $('sysSelect').value;
    const needsMicPermission = captureCandidate || sysVal !== '__loopback__';
    if (needsMicPermission) await window.api.ensureMicPermission();

    let micStream = null;
    if (captureCandidate) micStream = await getMicStream($('micSelect').value);

    let sysStream = null;
    try {
      if (sysVal === '__loopback__' && (await window.api.getScreenPermission()) === 'denied') {
        await handleSystemCaptureError(new Error('Screen Recording permission denied'), sysVal);
      } else {
        sysStream = await getSystemStream(sysVal);
      }
    } catch (e) {
      console.error('interviewer audio capture failed:', e);
      await handleSystemCaptureError(e, sysVal);
    }

    if (!micStream && !sysStream) {
      throw new Error('No audio source is available. Choose an interviewer input device first.');
    }

    state.dgMic = null;
    state.dgSys = null;

    if (micStream) {
      state.dgMic = makeSttClient('interviewee');
      await wireStream(micStream, state.dgMic);
      state.streams.push(micStream);
      state.dgMic.connect();
    }

    if (sysStream) {
      state.dgSys = makeSttClient('interviewer');
      await wireStream(sysStream, state.dgSys);
      state.streams.push(sysStream);
      state.dgSys.connect();
    }

    state.listening = true;
    state.sessionStart = Date.now();
    state.lastAutoKey = null;
    clearEmptyState();
    if (!$('transcript').querySelector('.day-sep')) addDaySeparator();
    setLive(true);
    setListeningUI(true);
    setStatus(`Listening · ${provider === 'doubao' ? 'Doubao' : 'Deepgram'}`, 'live');
    listInputDevices();
  } catch (e) {
    console.error(e);
    setStatus('Failed to start', 'error');
    toast('Failed to start: ' + e.message, true);
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

  setStatus('Capturing question', 'live');
  toast('Question capture started — press the hotkey again when the interviewer finishes.');
}

async function finishQuestionCapture() {
  if (captureStartIndex === null || captureFinishing) return;
  captureFinishing = true;

  const startIndex = captureStartIndex;
  const startedListeningHere = captureStartedListening;

  // Keep the source alive briefly so either provider receives the trailing silence / final words.
  await sleep(500);

  const finalText = state.history
    .slice(startIndex)
    .filter((h) => h.role === 'interviewer')
    .map((h) => h.text)
    .join(' ')
    .trim();
  const interimText =
    (state.interim.interviewer && state.interim.interviewer.querySelector('.bubble')?.textContent) ||
    '';
  const question = finalText || interimText.trim();

  captureStartIndex = null;
  captureStartedListening = false;

  if (startedListeningHere) await stopListening();

  if (!question) {
    toast('No interviewer speech was transcribed during this capture.', true);
    captureFinishing = false;
    return;
  }

  $('questionBox').value = question;
  state.autoQuestion = '';
  setStatus(state.listening ? 'Listening' : 'Idle', state.listening ? 'live' : undefined);
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

  // preload may inject this layer while app.js is still awaiting settings IPC.
  setTimeout(applyCaptureSettingsUI, 150);
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', initCaptureMode);
} else {
  initCaptureMode();
}
