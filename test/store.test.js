'use strict';

const test = require('node:test');
const assert = require('node:assert');
const store = require('../src/main/store');

test('store: add / summary / remove / clear', () => {
  store.clear();
  assert.deepEqual(store.summary(), []);

  const s1 = store.add('resume.txt', 'I am a backend engineer.');
  assert.equal(s1.length, 1);
  assert.equal(s1[0].name, 'resume.txt');
  assert.equal(s1[0].chars, 'I am a backend engineer.'.length);

  store.add('jd.txt', 'We need a forward deployed engineer.');
  const id = store.summary()[0].id;
  const after = store.remove(id);
  assert.equal(after.length, 1);
  assert.equal(after[0].name, 'jd.txt');

  store.clear();
  assert.deepEqual(store.summary(), []);
});

test('store: update changes a doc in place and invalidates retrieval index', () => {
  store.clear();
  store.add('a.txt', 'old irrelevant text');
  const id = store.summary()[0].id;
  store.warmIndex();

  const after = store.update(id, {
    name: 'b.txt',
    text: 'new vLLM inference optimization content',
  });
  assert.equal(after[0].name, 'b.txt');
  assert.equal(after[0].chars, 'new vLLM inference optimization content'.length);

  const r = store.search('vLLM inference optimization');
  assert.equal(r.matches[0].name, 'b.txt');
  assert.match(r.context, /vLLM/);
  store.clear();
});

test('store: legacy buildContext no longer assembles the full knowledge base', () => {
  store.clear();
  store.add('big.txt', 'x'.repeat(1000));
  assert.equal(store.buildContext(60000), '');
  store.clear();
});
