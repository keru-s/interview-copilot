'use strict';

// Optional two-computer question-capture mode layered on top of the existing app.
// The existing hotkey remains user-configurable in Settings, but its behavior becomes:
// first press = start capturing the interviewer; second press = stop capture and answer.

const baseStartListening = startListening;
const baseOpenSettings = openSettings;
const baseSaveSettings = saveSettings;

let captureStartIndex = null;
let captureStartedListening = false;
let captureFinishing = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureCaptureSettingsUI() {
  const hotkeyInput = $('setHotkey');
  if (!hotkeyInput) return;

  const hotkeyLabel = hotkeyInput.closest('.setting');
  const hotkeyTitle = hotkeyLabel && hotkeyLabel.querySelector('span');
  if (hotkeyTitle) {
    hotkeyTitle.textContent = 'Question capture hotkey (press once to start, again to stop & answer)';
  }

  if ($('setCaptureCandidateMic')) return;

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

function applyCaptureSettingsUI() {
  if (!state.settings) return;
  ensureCaptureSettingsUI();

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
  $('setCaptureCandidateMic').value = state.settings.captureCandidateMic === false ? 'false' : 'true';
};

saveSettings = async function () {
  ensureCaptureSettingsUI();
  const captureCandidateMic = $('setCaptureCandidateMic').value !== 'false';
  await baseSaveSettings();
  state.settings = await window.api.saveSettings({ captureCandidateMic });
  applyCaptureSettingsUI();
};

// Keep the original listening behavior when candidate-mic capture is enabled.
// When disabled, only the selected Interviewer audio source is opened and sent to Deepgram.
startListening = async function () {
  if (!state.settings || state.settings.captureCandidateMic !== false) {
    return baseStartListening();
  }

  if (!state.settings.deepgramApiKey) {
    toast('Add your Deepgram API key in Settings first', true);
    openSettings();
    return;
  }

  setStatus('Initializing…');
  try {
    let sysStream = null;
    const sysVal = $('sysSelect').value;
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

    if (!sysStream) {
      throw new Error('No interviewer audio source is available. Choose an input device first.');
    }

    const lang = state.settings.sttLanguage || 'en-US';
    state.dgMic = null;
    state.dgSys = new window.DeepgramLive({
      apiKey: state.settings.deepgramApiKey,
      language: lang,
      onTranscript: (r) => handleTranscript('interviewer', r),
      onState: (s, info) => onDgState('sys', s, info),
    });
    await wireStream(sysStream, state.dgSys);
    state.streams.push(sysStream);
    state.dgSys.connect();

    state.listening = true;
    state.sessionStart = Date.now();
    state.lastAutoKey = null;
    clearEmptyState();
    if (!$('transcript').querySelector('.day-sep')) addDaySeparator();
    setLive(true);
    setListeningUI(true);
    setStatus('Listening', 'live');
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

  // If this hotkey started the listening session, stop the source first and leave the
  // Deepgram socket alive briefly so endpointing can emit the final transcript.
  if (startedListeningHere) {
    state.streams.forEach((stream) => {
      stream.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch (_e) {}
      });
    });
  }

  await sleep(500);

  const finalText = state.history
    .slice(startIndex)
    .filter((h) => h.role === 'interviewer')
    .map((h) => h.text)
    .join(' ')
    .trim();
  const interimText =
    (state.interim.interviewer && state.interim.interviewer.querySelector('.bubble')?.textContent) || '';
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
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', initCaptureMode);
} else {
  initCaptureMode();
}
