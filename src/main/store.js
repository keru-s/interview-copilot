'use strict';

// 资料知识库：保存上传/粘贴文档的纯文本，并在本地用轻量 BM25 做相关片段检索。
// 持久化到 userData/knowledge.json；索引只存在内存里，资料变化后自动失效并重建。
// 目标是面试场景：有明显个人资料命中时只注入少量相关 chunk；没有命中时不注入 KB，直接让 LLM 作答。

const fs = require('fs');
const path = require('path');
const { chunkText } = require('./documents');

// 在 Electron 主进程里能拿到 app；在纯 Node 单测里拿不到 → 自动退回内存模式（不落盘）。
let app = null;
try {
  app = require('electron').app;
} catch (_e) {
  /* not in electron */
}
const canPersist = () => !!(app && typeof app.getPath === 'function');
const filePath = () => path.join(app.getPath('userData'), 'knowledge.json');

let docs = null; // 懒加载： { id, name, text, chars }[]
let seq = 0;
let indexCache = null;

const EN_STOP = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'can',
  'do',
  'for',
  'from',
  'how',
  'i',
  'in',
  'is',
  'it',
  'of',
  'on',
  'or',
  'that',
  'the',
  'this',
  'to',
  'what',
  'when',
  'where',
  'which',
  'why',
  'with',
  'you',
  'your',
]);

// 中文问题里非常常见、区分度很低的片段。过滤掉它们，避免“项目/介绍/为什么”等词把无关资料召回。
const ZH_STOP = new Set([
  '什么',
  '怎么',
  '怎样',
  '如何',
  '为什么',
  '介绍',
  '一下',
  '这个',
  '那个',
  '一个',
  '区别',
  '原理',
  '实现',
  '使用',
  '项目',
  '你们',
  '你是',
  '的是',
  '有什么',
  '时候',
]);

// 高频面试技术词别名。只扩展 query，不改原文；例如问 SFT，也能命中“监督微调”。
const ALIAS_GROUPS = [
  ['sft', 'supervised fine tuning', 'supervised fine-tuning', '监督微调', '有监督微调'],
  ['rag', 'retrieval augmented generation', 'retrieval-augmented generation', '检索增强生成'],
  ['llm', 'large language model', '大语言模型'],
  ['lora', 'low rank adaptation', 'low-rank adaptation', '低秩适配'],
  ['rlhf', 'reinforcement learning from human feedback', '人类反馈强化学习'],
  ['websocket', 'web socket'],
  ['sse', 'server sent events', 'server-sent events'],
  ['bm25', 'okapi bm25'],
  ['agent', 'ai agent', '智能体'],
  ['mcp', 'model context protocol'],
  ['a2a', 'agent2agent', 'agent to agent'],
];

function ensureLoaded() {
  if (docs !== null) return;
  docs = [];
  seq = 0;
  if (!canPersist()) return;
  try {
    const data = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
    if (Array.isArray(data.docs)) {
      docs = data.docs;
      seq = docs.reduce((m, d) => {
        const n = parseInt(String(d.id).replace(/\D/g, ''), 10) || 0;
        return Math.max(m, n);
      }, 0);
    }
  } catch (_e) {
    // 文件不存在 / 损坏 → 视为空库
  }
}

function persist() {
  if (!canPersist()) return;
  try {
    fs.writeFileSync(filePath(), JSON.stringify({ docs }, null, 2), 'utf8');
  } catch (e) {
    console.error('保存知识库失败:', e);
  }
}

function invalidateIndex() {
  indexCache = null;
}

function add(name, text) {
  ensureLoaded();
  const clean = (text || '').trim();
  const id = `doc_${++seq}`;
  docs.push({ id, name, text: clean, chars: clean.length });
  invalidateIndex();
  persist();
  return summary();
}

function update(id, { name, text } = {}) {
  ensureLoaded();
  const d = docs.find((x) => x.id === id);
  if (d) {
    if (typeof name === 'string') d.name = name;
    if (typeof text === 'string') {
      d.text = text.trim();
      d.chars = d.text.length;
    }
    invalidateIndex();
    persist();
  }
  return summary();
}

function remove(id) {
  ensureLoaded();
  docs = docs.filter((d) => d.id !== id);
  invalidateIndex();
  persist();
  return summary();
}

function clear() {
  ensureLoaded();
  docs = [];
  invalidateIndex();
  persist();
  return summary();
}

function summary() {
  ensureLoaded();
  return docs.map((d) => ({ id: d.id, name: d.name, chars: d.chars }));
}

function normalize(s) {
  return String(s || '')
    .normalize('NFKC')
    .toLowerCase();
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsAlias(raw, alias) {
  const a = normalize(alias);
  if (/\p{Script=Han}/u.test(a)) return raw.includes(a);
  if (/^[a-z0-9]+$/.test(a)) {
    return new RegExp(`(^|[^a-z0-9])${escapeRegex(a)}([^a-z0-9]|$)`).test(raw);
  }
  return raw.includes(a);
}

function expandAliases(query) {
  const raw = normalize(query);
  const extra = [];
  for (const group of ALIAS_GROUPS) {
    if (group.some((alias) => containsAlias(raw, alias))) extra.push(...group);
  }
  return extra.length ? `${query}\n${extra.join(' ')}` : String(query || '');
}

function tokenize(text) {
  const s = normalize(text);
  const out = [];

  // 英文、数字和常见技术 token（qwen3.5 / seller_id / c++ / server-sent 等）。
  const latin = s.match(/[a-z0-9]+(?:[._+#/-][a-z0-9]+)*/g) || [];
  for (const token of latin) {
    if (token.length > 1 && !EN_STOP.has(token)) out.push(token);
  }

  // 中文不引入分词依赖：保留短词本身，并补 2-gram / 3-gram。
  const hanRuns = s.match(/\p{Script=Han}+/gu) || [];
  for (const run of hanRuns) {
    if (run.length >= 2 && run.length <= 8 && !ZH_STOP.has(run)) out.push(run);
    for (const n of [2, 3]) {
      if (run.length < n) continue;
      for (let i = 0; i <= run.length - n; i += 1) {
        const gram = run.slice(i, i + n);
        if (!ZH_STOP.has(gram)) out.push(gram);
      }
    }
  }

  return out;
}

function termFrequency(tokens) {
  const tf = new Map();
  for (const token of tokens) tf.set(token, (tf.get(token) || 0) + 1);
  return tf;
}

function buildIndex() {
  ensureLoaded();
  const chunks = [];
  const df = new Map();

  for (const doc of docs) {
    const pieces = chunkText(doc.text || '', 900, 120);
    pieces.forEach((text, chunkIndex) => {
      // 文件名通常带有“简历/项目名/技术主题”等强信号，重复一次作为轻量 title boost。
      const tokens = [...tokenize(doc.name), ...tokenize(doc.name), ...tokenize(text)];
      if (!tokens.length) return;
      const tf = termFrequency(tokens);
      const row = {
        docId: doc.id,
        name: doc.name,
        chunkIndex,
        text,
        tf,
        length: tokens.length,
      };
      chunks.push(row);
      for (const token of tf.keys()) df.set(token, (df.get(token) || 0) + 1);
    });
  }

  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
  indexCache = {
    chunks,
    df,
    avgdl: chunks.length ? totalLength / chunks.length : 0,
  };
  return indexCache;
}

function warmIndex() {
  if (!indexCache) buildIndex();
  return {
    documents: docs ? docs.length : 0,
    chunks: indexCache ? indexCache.chunks.length : 0,
  };
}

function search(query, { topK = 5, minScore = 0.75, maxChars = 10000 } = {}) {
  ensureLoaded();
  const q = String(query || '').trim();
  if (!q || docs.length === 0) return { context: '', matches: [], tookMs: 0 };

  const started = Date.now();
  const idx = indexCache || buildIndex();
  if (!idx.chunks.length) {
    return { context: '', matches: [], tookMs: Date.now() - started };
  }

  const queryTokens = tokenize(expandAliases(q));
  const qtf = termFrequency(queryTokens);
  if (!qtf.size) return { context: '', matches: [], tookMs: Date.now() - started };

  const N = idx.chunks.length;
  const k1 = 1.35;
  const b = 0.72;
  const scored = [];

  for (const chunk of idx.chunks) {
    let score = 0;
    let matchedTerms = 0;
    for (const [term, queryFreq] of qtf) {
      const tf = chunk.tf.get(term) || 0;
      if (!tf) continue;
      matchedTerms += 1;
      const n = idx.df.get(term) || 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      const lengthNorm = chunk.length / Math.max(1, idx.avgdl);
      const denom = tf + k1 * (1 - b + b * lengthNorm);
      const queryWeight = 1 + Math.log(Math.max(1, queryFreq));
      score += idf * ((tf * (k1 + 1)) / denom) * queryWeight;
    }
    if (score > 0) scored.push({ ...chunk, score, matchedTerms });
  }

  scored.sort((a, b2) => b2.score - a.score);
  const best = scored[0];
  if (!best || best.score < minScore) {
    return { context: '', matches: [], tookMs: Date.now() - started };
  }

  // 相对阈值避免第 4/5 个很弱的 chunk 被硬塞进 Prompt。
  const cutoff = Math.max(minScore, best.score * 0.35);
  const selected = scored.filter((x) => x.score >= cutoff).slice(0, topK);

  const blocks = [];
  let used = 0;
  const matches = [];
  for (const item of selected) {
    const block = `### 资料：${item.name}（相关片段）\n${item.text}`;
    if (used && used + block.length + 10 > maxChars) break;
    const remain = maxChars - used;
    if (remain <= 80) break;
    const finalBlock =
      block.length <= remain ? block : `${block.slice(0, Math.max(0, remain - 12))}\n[片段截断]`;
    blocks.push(finalBlock);
    used += finalBlock.length + 10;
    matches.push({
      docId: item.docId,
      name: item.name,
      chunkIndex: item.chunkIndex,
      score: Number(item.score.toFixed(3)),
      chars: item.text.length,
    });
    if (finalBlock.length < block.length) break;
  }

  return {
    context: blocks.join('\n\n---\n\n'),
    matches,
    tookMs: Date.now() - started,
  };
}

// main.js 仍调用这个旧接口。真正的 Knowledge Base 注入现在由 prompt.js 的 BM25 检索完成，
// 因此这里不再构造“全量资料字符串”，避免每个通用问题都白做一次全库拼接。
function buildContext() {
  return '';
}

function _reset() {
  docs = [];
  seq = 0;
  invalidateIndex();
}

module.exports = {
  add,
  update,
  remove,
  clear,
  summary,
  buildContext,
  search,
  warmIndex,
  _tokenize: tokenize,
  _reset,
};
