const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

function setup({ overlay = true, overlayStarts = true, readyState = 4, source = 'first.mp4',
  paused = true, reject = false, throwing = false, promise = null, hidden = false } = {}) {
  const context = vm.createContext({ setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync('extension/playback.js', 'utf8'), context);
  let clicks = 0, plays = 0;
  const doc = {
    defaultView: { getComputedStyle() { return { display: 'block', visibility: 'visible' }; } },
    querySelectorAll(selector) { return selector === 'video' ? [video] : []; }
  };
  const container = { querySelectorAll() { return overlay ? [button] : []; } };
  const button = {
    isConnected: true, ownerDocument: doc, parentElement: null, title: '播放视频', textContent: 'Play Video',
    getClientRects() { return [{}]; }, getAttribute() { return null; },
    closest() { return null; }, matches() { return true; },
    click() { clicks++; if (overlayStarts) video.paused = false; }
  };
  const video = {
    isConnected: true, ownerDocument: doc, parentElement: container, readyState, currentSrc: source,
    paused, ended: false, error: null,
    getClientRects() { return hidden ? [] : [{}]; },
    getAttribute() { return null; }, querySelector() { return null; }, closest() { return container; },
    play() {
      plays++;
      if (throwing) throw new Error('not supported');
      if (reject) return Promise.reject(new Error('NotAllowedError'));
      if (promise) return promise;
      video.paused = false;
      return Promise.resolve();
    }
  };
  // Keep style traversal within the mock DOM.
  container.ownerDocument = doc;
  container.getAttribute = () => null;
  const config = { enabled: true, revision: 'first' };
  return { playback: context.CxAutoPlayback, video, button, doc,
    clicks: () => clicks, plays: () => plays,
    update(overrides = {}) { return context.CxAutoPlayback.update(doc, { ...config, ...overrides }); } };
}

test('clicks the player overlay before relying on native play()', async () => {
  const s = setup();
  assert.equal((await s.update())[0].status, 'started');
  assert.equal(s.clicks(), 1);
  assert.equal(s.plays(), 0);
  assert.equal((await s.update())[0].status, 'playing');
});
test('falls back to native play when the overlay does not start playback', async () => {
  const s = setup({ overlayStarts: false });
  assert.equal((await s.update())[0].status, 'started');
  assert.equal(s.clicks(), 1);
  assert.equal(s.plays(), 1);
});
test('supports native video controls without a custom overlay', async () => {
  const s = setup({ overlay: false });
  assert.equal((await s.update())[0].status, 'started');
  assert.equal(s.plays(), 1);
});
test('uses the visible overlay even when the hidden video has no source yet', async () => {
  const empty = setup({ source: '', readyState: 0, hidden: true });
  assert.equal((await empty.update())[0].status, 'started');
  assert.equal(empty.clicks(), 1);
  const native = setup({ overlay: false, readyState: 0 });
  assert.equal((await native.update())[0].reason, 'loading');
  native.video.readyState = 1;
  assert.equal((await native.update())[0].status, 'started');
  const preload = setup({ readyState: 0 });
  assert.equal((await preload.update())[0].status, 'started');
});
test('honors a manual pause instead of restarting on every snapshot', async () => {
  const s = setup();
  await s.update();
  s.video.paused = true;
  for (let i = 0; i < 3; i++) assert.equal((await s.update())[0].status, 'paused');
  assert.equal(s.clicks(), 1);
});
test('already-playing videos are not later mistaken for new paused media', async () => {
  const s = setup({ paused: false });
  assert.equal((await s.update())[0].status, 'playing');
  s.video.paused = true;
  assert.equal((await s.update())[0].status, 'paused');
  assert.equal(s.clicks(), 0);
});
test('a rejected or throwing play call stops retrying until an explicit revision', async () => {
  for (const options of [{ reject: true }, { throwing: true }]) {
    const s = setup({ overlay: false, ...options });
    assert.equal((await s.update())[0].status, 'blocked');
    assert.equal((await s.update())[0].status, 'blocked');
    assert.equal(s.plays(), 1);
    assert.equal((await s.update({ revision: 'retry' }))[0].status, 'blocked');
    assert.equal(s.plays(), 2);
  }
});
test('disabled, hidden, errored and ended videos are not started', async () => {
  const s = setup();
  assert.equal((await s.update({ enabled: false }))[0].status, 'off');
  assert.equal(s.clicks(), 0);
  const hidden = setup({ hidden: true, overlay: false });
  assert.equal((await hidden.update())[0].reason, 'hidden');
  assert.equal(hidden.clicks(), 0);
  s.video.ended = true;
  assert.equal((await s.update())[0].status, 'ended');
  s.video.ended = false; s.video.error = {};
  assert.equal((await s.update())[0].reason, 'media-error');
  assert.equal(s.clicks(), 0);
});
test('a fresh source gets another automatic start attempt', async () => {
  const s = setup();
  await s.update();
  s.video.currentSrc = 'second.mp4'; s.video.paused = true;
  assert.equal((await s.update())[0].status, 'started');
  assert.equal(s.clicks(), 2);
});
test('an active quiz blocks playback and one solved pulse permits one resume', async () => {
  const s = setup();
  await s.update(); s.video.paused = true;
  assert.equal((await s.update({ quizActive: true }))[0].reason, 'quiz');
  assert.equal(s.clicks(), 1);
  assert.equal((await s.update({ quizSolved: true }))[0].status, 'started');
  s.video.paused = true;
  assert.equal((await s.update({ quizSolved: true }))[0].status, 'paused');
  assert.equal(s.clicks(), 2);
  await s.update({ quizSolved: false });
  assert.equal((await s.update({ quizSolved: true }))[0].status, 'started');
  assert.equal(s.clicks(), 3);
});
test('concurrent scans share one pending play operation', async () => {
  let resolve;
  const deferred = new Promise(done => { resolve = done; });
  const s = setup({ overlay: false, promise: deferred });
  const first = s.update(), second = s.update();
  assert.equal(s.plays(), 1);
  s.video.paused = false; resolve();
  assert.equal((await first)[0].status, 'started');
  assert.equal((await second)[0].status, 'started');
});
test('disabling during an async play attempt cancels its reported action', async () => {
  let resolve;
  const deferred = new Promise(done => { resolve = done; });
  const s = setup({ overlay: false, promise: deferred });
  const pending = s.update();
  assert.equal((await s.update({ enabled: false }))[0].status, 'off');
  resolve();
  assert.equal((await pending)[0].reason, 'cancelled');
  assert.equal(s.plays(), 1);
});

test('a guard stop invalidates pending playback without restarting or pausing media', async () => {
  let resolve;
  const deferred = new Promise(done => { resolve = done; });
  const s = setup({ overlay: false, promise: deferred });
  const pending = s.update();
  s.playback.stop(s.doc);
  resolve();
  assert.equal((await pending)[0].reason, 'cancelled');
  assert.equal(s.plays(), 1);
  assert.equal(s.video.paused, true);
});
test('pending native play cannot block snapshots indefinitely', async () => {
  const s = setup({ overlay: false, promise: new Promise(() => {}) });
  const result = (await s.update())[0];
  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'timeout');
  assert.equal(s.plays(), 1);
});
test('summary distinguishes autoplay failures from a paused player', async () => {
  const s = setup();
  assert.match(s.playback.summary([{ snapshot: { playback: [{ status: 'blocked' }] } }], true), /点击播放/);
  assert.match(s.playback.summary([{ snapshot: { playback: [{ status: 'paused' }] } }], true), /暂停/);
});

function setupMany(firstOptions = {}) {
  const first = setup(firstOptions);
  const second = setup({ source: 'second.mp4' });
  const videos = [first.video, second.video];
  second.video.ownerDocument = first.doc;
  second.button.ownerDocument = first.doc;
  second.video.parentElement.ownerDocument = first.doc;
  first.doc.querySelectorAll = selector => selector === 'video' ? videos : [];
  return { first, second, videos, update: options => first.update(options) };
}

test('multiple videos start one at a time and every queued video gets a fresh attempt', async () => {
  const s = setupMany();
  const initial = await s.update();
  assert.equal(initial[0].status, 'started');
  assert.equal(initial[1].status, 'queued');
  assert.equal(s.first.clicks(), 1);
  assert.equal(s.second.clicks(), 0);
  await s.update();
  assert.equal(s.second.clicks(), 0, 'the next player stays queued while the first is playing');
  s.first.video.ended = true; s.first.video.paused = true;
  const afterFirst = await s.update();
  assert.equal(afterFirst[0].status, 'ended');
  assert.equal(afterFirst[1].status, 'started');
  assert.equal(s.second.clicks(), 1);
});

test('manually pausing the active video keeps subsequent videos queued', async () => {
  const s = setupMany();
  await s.update();
  s.first.video.paused = true;
  for (let index = 0; index < 3; index++) {
    const result = await s.update();
    assert.equal(result[0].status, 'paused');
    assert.equal(result[1].status, 'queued');
  }
  assert.equal(s.first.clicks(), 1);
  assert.equal(s.second.clicks(), 0);
});

test('a player already running later in the page is preserved before starting queued media', async () => {
  const s = setupMany();
  s.second.video.paused = false;
  const result = await s.update();
  assert.equal(result[0].status, 'queued');
  assert.equal(result[1].status, 'playing');
  assert.equal(s.first.clicks(), 0);
  s.second.video.ended = true; s.second.video.paused = true;
  assert.equal((await s.update())[0].status, 'started');
});

test('external video identity selects exactly one player and null selects none', async () => {
  const s = setupMany();
  const videoIds = ['first-id', 'second-id'];
  const waiting = await s.update({ videoIds, activeVideoId: null });
  assert.equal(waiting.every(result => result.status === 'queued'), true);
  assert.equal(s.first.clicks(), 0);
  assert.equal(s.second.clicks(), 0);
  const selected = await s.update({ videoIds, activeVideoId: 'second-id' });
  assert.equal(selected[0].status, 'queued');
  assert.equal(selected[1].status, 'started');
  assert.equal(s.second.clicks(), 1);
  assert.equal(s.first.clicks(), 0);
  s.second.video.paused = true;
  assert.equal((await s.update({ videoIds, activeVideoId: 'second-id' }))[1].status, 'paused');
});

test('missing or non-string external identities do not fall back to starting a player', async () => {
  const s = setupMany();
  for (const selection of [
    { activeVideoId: 'unknown', videoIds: ['first-id', 'second-id'] },
    { activeVideoId: 'first-id' },
    { activeVideoId: 0, videoIds: ['first-id', 'second-id'] },
    { activeVideoId: '0', videoIds: [0, 1] }
  ]) {
    assert.equal((await s.update(selection)).every(result => result.status === 'queued'), true);
  }
  assert.equal(s.first.clicks(), 0);
  assert.equal(s.second.clicks(), 0);
});

test('stable external identities survive a reordered list without replaying the active video', async () => {
  const s = setupMany();
  await s.update({ activeVideoId: 'second-id', videoIds: ['first-id', 'second-id'] });
  s.videos.reverse();
  const result = await s.update({ activeVideoId: 'second-id', videoIds: ['second-id', 'first-id'] });
  assert.equal(result[0].status, 'playing');
  assert.equal(result[1].status, 'queued');
  assert.equal(s.second.clicks(), 1);
  assert.equal(s.first.clicks(), 0);
});

test('changing external selection invalidates an older pending play operation', async () => {
  let resolve;
  const deferred = new Promise(done => { resolve = done; });
  const s = setupMany({ overlay: false, promise: deferred });
  const pending = s.update({ activeVideoId: 'first-id', videoIds: ['first-id', 'second-id'] });
  assert.equal(s.first.plays(), 1);
  const next = await s.update({ activeVideoId: 'second-id', videoIds: ['first-id', 'second-id'] });
  assert.equal(next[1].status, 'started');
  resolve();
  assert.equal((await pending)[0].reason, 'cancelled');
  assert.equal(s.first.plays(), 1);
});

test('queued status is summarized as sequencing rather than a loading failure', () => {
  const s = setup();
  assert.match(s.playback.summary([{ snapshot: { playback: [{ status: 'queued' }] } }], true), /排队/);
});

test('a shared container with multiple bare videos does not click another player control', async () => {
  const s = setupMany();
  const shared = {
    ownerDocument: s.first.doc, parentElement: null,
    getAttribute() { return null; },
    querySelectorAll(selector) { return selector === 'video' ? s.videos : [s.first.button, s.second.button]; }
  };
  for (const video of s.videos) {
    video.parentElement = shared;
    video.closest = () => null;
  }
  const result = await s.update({ activeVideoId: 'second-id', videoIds: ['first-id', 'second-id'] });
  assert.equal(result[1].status, 'started');
  assert.equal(s.first.clicks(), 0);
  assert.equal(s.second.clicks(), 0);
  assert.equal(s.first.plays(), 0);
  assert.equal(s.second.plays(), 1);
});
