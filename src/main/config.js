'use strict';

// 答案 Provider 注册表。
// type: 'openai'  → 走 openaiCompat.js（OpenAI 兼容 Chat Completions）
//       'gemini'  → 走 gemini.js
// keyField/modelField/baseURLField 指向 settings.js 中的字段名。
const PROVIDERS = {
  // 注意：deepseek-chat 旧名已退役，官方模型名为 deepseek-flash / deepseek-v4-pro，
  // 思考模式默认开启（力度 high），可用 thinking.type=disabled 关闭。
  deepseek: {
    label: 'DeepSeek',
    type: 'openai',
    baseURL: 'https://api.deepseek.com/chat/completions',
    keyField: 'deepseekApiKey',
    modelField: 'deepseekModel',
    defaultModel: 'deepseek-flash',
    reasoningField: 'deepseekThinking',
    fallbacks: [],
  },
  openai: {
    label: 'OpenAI',
    type: 'openai',
    baseURL: 'https://api.openai.com/v1/chat/completions',
    keyField: 'openaiApiKey',
    modelField: 'openaiModel',
    defaultModel: 'gpt-4o-mini',
    fallbacks: ['gpt-4o'],
  },
  // Kimi Code 会员订阅（coding 控制台 Key），与 Kimi 开放平台（api.moonshot.cn）Key 不通用。
  // k3 系列只接受 temperature=1；始终思考，reasoning_effort 调力度（low/high/max）。
  kimi: {
    label: 'Kimi Code（会员订阅）',
    type: 'openai',
    baseURL: 'https://api.kimi.com/coding/v1/chat/completions',
    keyField: 'kimiApiKey',
    modelField: 'kimiModel',
    defaultModel: 'k3-256k',
    temperature: 1,
    reasoningField: 'kimiReasoningEffort',
    fallbacks: [],
  },
  ollama: {
    label: 'Ollama (local)',
    type: 'openai',
    baseURL: 'http://localhost:11434/v1/chat/completions',
    baseURLField: 'ollamaBaseURL',
    keyField: null, // 本地，无需 Key
    modelField: 'ollamaModel',
    defaultModel: 'llama3.1',
    fallbacks: [],
  },
  // 用户自定义的 OpenAI 兼容端点：地址与模型都由设置页填写，Key 可留空。
  custom: {
    label: '自定义（OpenAI 兼容）',
    type: 'openai',
    baseURLField: 'customBaseURL',
    keyField: 'customApiKey',
    optionalKey: true,
    modelField: 'customModel',
    defaultModel: '',
    fallbacks: [],
  },
  gemini: {
    label: 'Gemini',
    type: 'gemini',
    keyField: 'geminiApiKey',
    modelField: 'genModel',
    defaultModel: 'gemini-2.5-flash',
    fallbacks: ['gemini-2.0-flash'],
  },
};

module.exports = { PROVIDERS };
