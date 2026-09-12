'use strict';

const test = require('node:test');
const assert = require('node:assert');
const store = require('../src/main/store');
const { buildPrompt } = require('../src/main/prompt');

test('BM25: retrieves the relevant personal project chunk', () => {
  store._reset();
  store.add(
    'Lazada title optimization.md',
    '我负责东南亚商品标题优化项目。使用 Qwen3 做监督微调，训练数据覆盖六个国家，并使用 vLLM 在 H20 上部署。',
  );
  store.add('Java notes.md', 'HashMap 在 JDK 8 中使用数组、链表和红黑树。');

  const r = store.search('你在商品标题优化项目里为什么使用 SFT？');
  assert.ok(r.matches.length >= 1);
  assert.equal(r.matches[0].name, 'Lazada title optimization.md');
  assert.match(r.context, /监督微调/);
  assert.doesNotMatch(r.context, /HashMap/);
});

test('BM25: alias expansion lets SFT match 监督微调', () => {
  store._reset();
  store.add('finetune.md', '这个方案最后选择监督微调，让模型学习稳定的标题生成规则。');

  const r = store.search('SFT 为什么适合这个任务？');
  assert.ok(r.matches.length >= 1);
  assert.match(r.context, /监督微调/);
});

test('BM25: unrelated generic question does not inject knowledge base', () => {
  store._reset();
  store.add('resume.md', 'Lazada 商品标题优化，Qwen3，SFT，vLLM，H20。');

  const r = store.search('TCP 三次握手的原理是什么？');
  assert.equal(r.context, '');
  assert.deepEqual(r.matches, []);
});

test('buildPrompt: uses retrieved chunks instead of the full knowledge base', () => {
  store._reset();
  store.add('title-project.md', '商品标题优化使用 Qwen3 和监督微调。');
  store.add('unrelated.md', '这里是一段完全无关的家庭旅行计划。');

  const { userText, retrieval } = buildPrompt({
    question: '标题优化项目为什么使用 SFT？',
    transcript: '',
    context: 'SHOULD NOT BE USED WHEN KB EXISTS',
    answerLanguage: 'zh',
    maxChars: 500,
  });

  assert.ok(retrieval && retrieval.matches.length >= 1);
  assert.match(userText, /监督微调/);
  assert.doesNotMatch(userText, /家庭旅行计划/);
  assert.doesNotMatch(userText, /SHOULD NOT BE USED/);
});

test('buildPrompt: generic question skips KB and goes straight to model knowledge', () => {
  store._reset();
  store.add('resume.md', 'Lazada 商品标题优化，Qwen3，SFT，vLLM，H20。');

  const { userText, retrieval } = buildPrompt({
    question: 'TCP 三次握手是什么？',
    transcript: '',
    context: 'FULL KB SHOULD BE DISCARDED',
    answerLanguage: 'zh',
    maxChars: 500,
  });

  assert.ok(retrieval);
  assert.equal(retrieval.context, '');
  assert.doesNotMatch(userText, /FULL KB SHOULD BE DISCARDED/);
  assert.doesNotMatch(userText, /Lazada/);
  assert.match(userText, /TCP 三次握手/);
});

test.after(() => store._reset());
