const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const context = vm.createContext({});
vm.runInContext(fs.readFileSync('extension/quiz.js', 'utf8'), context);
const { choices, summary } = context.CxVideoQuiz;
test('single-choice trials cover every option exactly once', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(choices(4, false))), [[0], [1], [2], [3]]);
});
test('checkbox trials cover distinct nonempty subsets, trying simpler answers first', () => {
  const combinations = JSON.parse(JSON.stringify(choices(4, true)));
  assert.equal(combinations.length, 15);
  assert.equal(new Set(combinations.map(JSON.stringify)).size, 15);
  assert.deepEqual(combinations.slice(0, 4), [[0], [1], [2], [3]]);
  assert.deepEqual(combinations.at(-1), [0, 1, 2, 3]);
});
test('unsupported option counts do not create unbounded combinations', () => {
  for (const count of [0, 1, 7, 50, 2.5]) assert.equal(choices(count, true).length, 0);
});
test('popup summary exposes feedback and allows disabling independently', () => {
  const frames = [{ snapshot: { quiz: { active: true, status: '等待反馈' } } }];
  assert.equal(summary(frames, true), '等待反馈');
  assert.match(summary(frames, false), /已关闭/);
});
