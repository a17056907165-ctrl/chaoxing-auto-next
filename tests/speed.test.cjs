const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

function setup({ paused = false, rate = 1, menu = [], restricted = false, reject = false, rejectTarget = false,
  clamp = null, ignoreTarget = false } = {}) {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync('extension/speed.js', 'utf8'), context);
  let actualRate = rate, writes = 0;
  const history = [];
  const video = { readyState: 4, paused, ended: false, error: null, currentSrc: 'first.mp4',
    get playbackRate() { return actualRate; },
    set playbackRate(value) {
      writes++; history.push(value);
      if (reject || (rejectTarget && value === 2)) throw new Error('not supported');
      if (!(ignoreTarget && value === 2)) actualRate = clamp || value;
    } };
  const doc = {
    defaultView: { getComputedStyle() { return { display: 'block' }; } },
    querySelectorAll(selector) {
      if (selector === 'video') return [video];
      if (selector === '.vjs-playback-rate') return restricted ? [{ matches() { return true; } }] : [];
      if (selector === '.vjs-playback-rate .vjs-menu-item') return menu.map(rate => typeof rate === 'object' ? rate :
        { textContent: typeof rate === 'number' ? `${rate}x` : rate });
      return [];
    }
  };
  const config = { enabled: true, rate: 2, revision: 'first' };
  return { speed: context.CxAutoSpeed, video, doc, config, update(overrides = {}) {
    return context.CxAutoSpeed.update(doc, { ...config, ...overrides })[0];
  }, writes: () => writes, history: () => history, setRate(rate) { actualRate = rate; } };
}

test('automatically applies and verifies default 2x once', () => {
  const s = setup();
  assert.equal(s.update().status, 'checking');
  assert.equal(s.video.playbackRate, 2);
  assert.equal(s.update().status, 'applied');
  s.update();
  assert.equal(s.writes(), 1);
});
test('waits for metadata and playback before attempting speed', () => {
  const s = setup({ paused: true });
  assert.equal(s.update().status, 'waiting');
  s.video.paused = false; s.video.readyState = 0;
  assert.equal(s.update().status, 'waiting');
  assert.equal(s.writes(), 0);
  s.video.readyState = 4;
  assert.equal(s.update().rate, 2);
});
test('disabling auto speed makes no speed changes', () => {
  const s = setup();
  assert.equal(s.update({ enabled: false }).status, 'off');
  assert.equal(s.writes(), 0);
});
test('a platform rate reset is respected without repeated writes', () => {
  const s = setup();
  s.update(); s.setRate(1);
  for (let i = 0; i < 5; i++) assert.equal(s.update().status, 'blocked');
  assert.equal(s.video.playbackRate, 1);
  assert.equal(s.writes(), 1);
});
test('an unsupported setter or disabled menu leaves playback speed intact', () => {
  for (const options of [{ reject: true }, { restricted: true }]) {
    const s = setup(options);
    assert.equal(s.update().status, 'blocked');
    assert.equal(s.update().rate, 1);
    assert.equal(s.writes(), options.reject ? 1 : 0);
  }
});
test('partial or asynchronously populated menus never downgrade the requested 2x', () => {
  for (const menu of [[1, 1.25, 1.5], ['1x', '1.5x', '2x2x'], ['1.5×', '2.0倍（推荐）']]) {
    const s = setup({ menu });
    assert.equal(s.update().rate, 2);
    assert.equal(s.update().status, 'applied');
    assert.deepEqual(s.history(), [2]);
  }
});

test('an accepted higher current rate is not reduced to 1.5 because the menu is partial', () => {
  const s = setup({ rate: 2, menu: [1, 1.5] });
  assert.equal(s.update().rate, 2);
  assert.equal(s.writes(), 0);
});

test('a deliberately selected 1.5x remains the requested target', () => {
  const s = setup({ menu: [1, 1.5, 2] });
  assert.equal(s.update({ rate: 1.5 }).rate, 1.5);
  assert.deepEqual(s.history(), [1.5]);
});

test('accepts player clamping instead of repeatedly overwriting its allowed rate', () => {
  const s = setup({ clamp: 1.5, menu: [1, 1.5, 2] });
  assert.equal(s.update().rate, 1.5);
  assert.equal(s.update().status, 'limited');
  assert.deepEqual(s.history(), [2]);
});

test('only after a target rejection does a scoped lower menu rate get one fallback attempt', () => {
  const s = setup({ rejectTarget: true, menu: ['1×', '1.25×', '1.5×（推荐）'] });
  assert.equal(s.update().rate, 1.5);
  assert.equal(s.update().status, 'limited');
  assert.deepEqual(s.history(), [2, 1.5]);
});

test('fallback labels tolerate duplicated accessible text and numeric data attributes', () => {
  const fallbackMenus = [
    ['1.25x', '1.5x1.5x'],
    [{ textContent: '选中 速度', getAttribute(name) { return name === 'data-rate' ? '1.5' : null; } }],
    [{ textContent: '选中', getAttribute(name) { return name === 'aria-label' ? '1.5 倍速（默认）' : null; } }]
  ];
  for (const menu of fallbackMenus) {
    const s = setup({ rejectTarget: true, menu });
    assert.equal(s.update().rate, 1.5);
    assert.deepEqual(s.history(), [2, 1.5]);
  }
});

test('an ignored target can fall back once, but a reset fallback is not fought', () => {
  const s = setup({ ignoreTarget: true, menu: [1, 1.5] });
  assert.equal(s.update().rate, 1.5);
  assert.deepEqual(s.history(), [2, 1.5]);
  s.setRate(1);
  for (let index = 0; index < 4; index++) assert.equal(s.update().status, 'blocked');
  assert.deepEqual(s.history(), [2, 1.5]);
});

test('an async target reset permits at most one lower-menu fallback', () => {
  const s = setup({ menu: [1, 1.5] });
  assert.equal(s.update().rate, 2);
  s.setRate(1);
  assert.equal(s.update().rate, 1.5);
  s.setRate(1);
  s.update(); s.update();
  assert.deepEqual(s.history(), [2, 1.5]);
});

test('another player disabled menu never blocks this player or changes its target', () => {
  const s = setup();
  const unrelated = { matches() { return true; } };
  const firstScope = { querySelectorAll() { return []; } };
  const secondScope = { querySelectorAll(selector) { return selector === '.vjs-playback-rate' ? [unrelated] : []; } };
  s.video.closest = () => firstScope;
  const other = { ...s.video, currentSrc: 'other.mp4', closest() { return secondScope; }, playbackRate: 1 };
  const originalQuery = s.doc.querySelectorAll.bind(s.doc);
  s.doc.querySelectorAll = selector => selector === 'video' ? [s.video, other] : originalQuery(selector);
  const results = s.speed.update(s.doc, s.config);
  assert.equal(results[0].rate, 2);
  assert.equal(results[1].status, 'blocked');
  assert.deepEqual(s.history(), [2]);
});

test('a temporarily disabled player can attempt its target once its control becomes available', () => {
  const s = setup({ restricted: true });
  assert.equal(s.update().status, 'blocked');
  s.video.closest = () => ({ querySelectorAll() { return []; } });
  assert.equal(s.update().rate, 2);
  assert.deepEqual(s.history(), [2]);
});
test('each new video source or explicit preference revision gets a fresh attempt', () => {
  const s = setup();
  s.update(); s.setRate(1); s.update();
  s.video.currentSrc = 'second.mp4';
  assert.equal(s.update().rate, 2);
  s.setRate(1);
  assert.equal(s.update({ rate: 1.5, revision: 'second' }).rate, 1.5);
  assert.equal(s.writes(), 3);
});
test('an existing requested rate needs no write and summaries show actual speed', () => {
  const s = setup({ rate: 2 });
  s.update(); const result = s.update();
  assert.equal(s.writes(), 0);
  assert.equal(s.speed.summary([{ snapshot: { speeds: [result] } }], true), '当前倍速：2×');
});
test('speed summary reports the current playing video rather than an earlier ended video', () => {
  const s = setup();
  const frames = [{ snapshot: { videos: [{ ended: true, paused: true }, { ended: false, paused: false }],
    speeds: [{ status: 'limited', rate: 1.5 }, { status: 'applied', rate: 2 }] } }];
  assert.equal(s.speed.summary(frames, true), '当前倍速：2×');
});
