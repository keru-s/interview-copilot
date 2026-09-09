'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULTS = {
  // 语音转文字 Provider：deepgram / doubao
  sttProvider: 'deepgram',
  deepgramApiKey: process.env.DEEPGRAM_API_KEY || '',
  // 豆包语音 / 火山引擎大模型流式 ASR 2.0。
  // 新控制台优先使用 API Key；旧应用仍可使用 App ID + Access Token。
  doubaoApiKey: process.env.DOUBAO_ASR_API_KEY || '',
  doubaoAppKey: process.env.DOUBAO_ASR_APP_KEY || '',
  doubaoAccessKey: process.env.DOUBAO_ASR_ACCESS_KEY || '',
  doubaoResourceId: process.env.DOUBAO_ASR_RESOURCE_ID || 'volc.seedasr.sauc.duration',
  doubaoWsUrl:
    process.env.DOUBAO_ASR_WS_URL || 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async',
  // 答案 Provider： deepseek / gemini / openai / ollama
  provider: 'gemini',
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  deepseekApiKey: process.env.DEEPSEEK_API_KEY || '',
  deepseekModel: 'deepseek-chat',
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  openaiModel: 'gpt-4o-mini',
  ollamaBaseURL: process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1/chat/completions',
  ollamaModel: 'llama3.1',
  // 转写语言： zh / en-US / multi
  sttLanguage: 'en-US',
  // 生成模型（可编辑，填你账号能用的任意 Flash 模型 ID）
  genModel: 'gemini-2.5-flash',
  // 注入到上下文的资料最大字符数
  maxContextChars: 60000,
  // 是否采集候选人麦克风；两机模式下可关闭，只保留 interviewer 音源
  captureCandidateMic: true,
  // 全局热键：第一次按开始采集问题，第二次按停止并生成答案
  hotkey: 'Control+A',
  // 自动作答：监测到面试官问完一个问题就自动触发（无需按热键）
  autoAnswer: false,
  // 答案字数上限
  maxChars: 500,
  // 答案语言： auto（跟随问题） / zh / en
  answerLanguage: 'auto',
  // 面试背景与作答风格（注入到系统提示，最高优先级）
  interviewProfile: '',
  // 目标岗位 JD（持久化；上传或粘贴，作答时据此定制）
  jobDescription: '',
};

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function load() {
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf8');
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch (_e) {
    return { ...DEFAULTS };
  }
}

function save(partial) {
  const merged = { ...load(), ...partial };
  try {
    fs.writeFileSync(settingsPath(), JSON.stringify(merged, null, 2), 'utf8');
  } catch (e) {
    console.error('保存设置失败:', e);
  }
  return merged;
}

module.exports = { load, save, DEFAULTS, settingsPath };
