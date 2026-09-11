'use strict';

// Upstream app.js still assumes Deepgram + Gemini are mandatory during startup.
// With selectable providers that check is no longer correct. If the selected STT and answer
// providers are actually configured, close only the automatic "Configure API keys" modal.

function sttReady(settings) {
  const provider = settings.sttProvider || 'deepgram';
  if (provider === 'doubao') {
    return !!settings.doubaoApiKey || (!!settings.doubaoAppKey && !!settings.doubaoAccessKey);
  }
  return !!settings.deepgramApiKey;
}

function llmReady(settings) {
  const provider = settings.provider || 'gemini';
  if (provider === 'deepseek') return !!settings.deepseekApiKey;
  if (provider === 'openai') return !!settings.openaiApiKey;
  if (provider === 'kimi') return !!settings.kimiApiKey;
  if (provider === 'ollama') return true;
  if (provider === 'custom') return !!(settings.customBaseURL && settings.customModel);
  return !!settings.geminiApiKey;
}

async function fixInitialProviderReadiness() {
  try {
    const settings = await window.api.getSettings();
    if (!sttReady(settings) || !llmReady(settings)) return;

    const status = document.getElementById('statusText');
    const modal = document.getElementById('settingsModal');
    if (!status || !modal) return;

    // Never close a Settings window the user opened intentionally.
    if (status.textContent !== '配置 API Key') return;
    modal.classList.add('hidden');
    status.textContent = '空闲';
  } catch (_e) {
    // Startup should remain usable even if this compatibility shim cannot read settings.
  }
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', () => setTimeout(fixInitialProviderReadiness, 250));
} else {
  setTimeout(fixInitialProviderReadiness, 250);
}
