const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
function setup() {
  const session = {}, local = {}, sent = [];
  let listener, removed;
  const storage = values => ({
    async get(key) {
      if (key === null) return { ...values };
      return Object.fromEntries((Array.isArray(key) ? key : [key]).map(name => [name, values[name]]));
    },
    async set(next) { Object.assign(values, next); },
    async remove(keys) { keys.forEach(key => delete values[key]); }
  });
  const chrome = {
    runtime: { onMessage: { addListener(fn) { listener = fn; } } },
    storage: { session: storage(session), local: storage(local) },
    webNavigation: { async getAllFrames() { return [
      { frameId: 0, documentId: 'top', url: 'https://mooc1.chaoxing.com/mycourse/studentstudy' },
      { frameId: 4, documentId: 'video', url: 'https://mooc2.chaoxing.com/ananas/video' },
      { frameId: 6, documentId: 'external', url: 'https://example.com/embed' }
    ]; } },
    tabs: { onRemoved: { addListener(fn) { removed = fn; } },
      async sendMessage(tabId, message, options) { sent.push({ tabId, message, options }); return { videos: [], candidates: [] }; } }
  };
  const restart = () => {
    const context = vm.createContext({ chrome, URL, importScripts: file =>
      vm.runInContext(fs.readFileSync(`extension/${file}`, 'utf8'), context) });
    vm.runInContext(fs.readFileSync('extension/background.js', 'utf8'), context);
  };
  restart();
  const request = (message, overrides = {}) => new Promise(resolve => {
    listener({ course: 'a', ...message }, { frameId: 0, tab: { id: 8 }, url: 'https://mooc1.chaoxing.com/mycourse/studentstudy?courseid=a', ...overrides }, resolve);
  });
  return { request, session, local, sent, removed, chrome, restart };
}
test('activation is isolated by course and browser tab', async () => {
  const { request } = setup();
  await request({ type: 'CX_SAVE', course: 'a', enabled: true, preferences: {} });
  assert.equal((await request({ type: 'CX_LOAD', course: 'a' })).enabled, true);
  assert.equal((await request({ type: 'CX_LOAD', course: 'b' })).enabled, false);
  assert.equal((await request({ type: 'CX_LOAD', course: 'a' }, { tab: { id: 9 } })).enabled, false);
});
test('course-specific selectors do not leak to another course', async () => {
  const { request } = setup();
  await request({ type: 'CX_SAVE', course: 'a', enabled: false, preferences: { selector: '#nextA' } });
  assert.equal((await request({ type: 'CX_LOAD', course: 'b' })).preferences.selector, undefined);
});
test('snapshots target current documents within the requesting tab', async () => {
  const { request, sent } = setup();
  const frames = await request({ type: 'CX_COLLECT', selector: '' });
  assert.equal(frames.length, 2);
  assert.deepEqual(sent.filter(call => call.message.type === 'CX_SNAPSHOT').map(call => [call.tabId, call.options.documentId]), [[8, 'top'], [8, 'video']]);
});
test('an inaccessible embedded player is reported rather than silently skipped', async () => {
  const { request, chrome } = setup();
  chrome.tabs.sendMessage = async () => { throw new Error('gone'); };
  const frames = await request({ type: 'CX_COLLECT' });
  assert.equal(frames.every(frame => frame.error), true);
});
test('an ended event wakes the current tab only while the matching activation is enabled', async () => {
  const { request, sent } = setup();
  const { epoch } = await request({ type: 'CX_SAVE', enabled: true, preferences: {} });
  const player = { frameId: 4, url: 'https://mooc2.chaoxing.com/ananas/modules/video/index.html' };
  const notify = () => request({ type: 'CX_VIDEO_ENDED', epoch }, player);
  assert.equal((await notify()).ok, true);
  const checks = () => sent.filter(call => call.message.type === 'CX_CHECK');
  assert.equal(checks().length, 1);
  assert.equal(checks()[0].tabId, 8);
  assert.equal(checks()[0].options.frameId, 0);
  await request({ type: 'CX_SAVE', enabled: false, preferences: {} });
  assert.equal((await notify()).ok, false);
  assert.equal(checks().length, 1);
});
test('speed configuration reaches every course frame with the fresh snapshot', async () => {
  const { request, sent } = setup();
  await request({ type: 'CX_SAVE', enabled: true, preferences: {} });
  sent.length = 0;
  const speed = { enabled: true, rate: 2, revision: 'new' };
  await request({ type: 'CX_COLLECT', speed });
  const snapshots = sent.filter(call => call.message.type === 'CX_SNAPSHOT');
  assert.equal(snapshots.length, 2);
  for (const call of snapshots) assert.equal(call.message.speed, speed);
});
test('video-quiz and playback preferences reach nested player frames', async () => {
  const { request, sent } = setup();
  await request({ type: 'CX_SAVE', enabled: true, preferences: {} });
  sent.length = 0;
  const quiz = { enabled: true, revision: 'q1' };
  const playback = { enabled: true, revision: 'p1' };
  await request({ type: 'CX_COLLECT', quiz, playback });
  for (const call of sent.filter(call => call.message.type === 'CX_SNAPSHOT')) {
    assert.equal(call.message.quiz, quiz);
    assert.equal(call.message.playback.enabled, playback.enabled);
    assert.equal(call.message.playback.revision, playback.revision);
  }
});
test('only one unfinished cross-frame video is selected, then the next after it ends', async () => {
  const { request, sent, chrome } = setup();
  await request({ type: 'CX_SAVE', enabled: true, preferences: {} });
  let firstEnded = false;
  chrome.tabs.sendMessage = async (tabId, message, options) => {
    sent.push({ tabId, message, options });
    return { videos: [{ id: options.documentId === 'top' ? 'one' : 'two', ended: options.documentId === 'top' && firstEnded, paused: true }], candidates: [] };
  };
  sent.length = 0;
  await request({ type: 'CX_COLLECT', playback: { enabled: true } });
  let snapshots = sent.filter(call => call.message.type === 'CX_SNAPSHOT');
  assert.equal(snapshots[0].message.playback.activeVideoId, 'one');
  assert.equal(snapshots[1].message.playback.activeVideoId, null);
  firstEnded = true;
  sent.length = 0;
  await request({ type: 'CX_COLLECT', playback: { enabled: true } });
  snapshots = sent.filter(call => call.message.type === 'CX_SNAPSHOT');
  assert.equal(snapshots[0].message.playback.activeVideoId, null);
  assert.equal(snapshots[1].message.playback.activeVideoId, 'two');
});
test('only the inner preview of the pending document task receives the scroll instruction', async () => {
  const { request, sent, chrome } = setup();
  await request({ type: 'CX_SAVE', enabled: true, preferences: {} });
  const moduleUrl = 'https://mooc1.chaoxing.com/ananas/modules/zt/pdf/index.html';
  const viewUrl = 'https://pan-yz.chaoxing.com/screen/v2/read';
  const top = { frameId: 0, documentId: 'top', url: 'https://mooc1.chaoxing.com/mycourse/studentstudy' };
  const wrapper = { frameId: 2, parentFrameId: 0, documentId: 'wrapper', url: moduleUrl };
  const preview = { frameId: 6, parentFrameId: 2, documentId: 'preview', url: viewUrl };
  const unrelated = { frameId: 8, parentFrameId: 0, documentId: 'unrelated', url: viewUrl };
  let frames = [top, wrapper, unrelated];
  chrome.webNavigation.getAllFrames = async () => frames;
  chrome.tabs.sendMessage = async (tabId, message, options) => {
    sent.push({ tabId, message, options });
    const id = options.documentId;
    return { videos: [], documentTasks: id === 'top' ? [{ id: 'task', url: moduleUrl, completed: false }] : [],
      documentViewer: id !== 'top', hasInnerPreview: id === 'wrapper' };
  };
  const readers = () => sent.filter(call => call.message.type === 'CX_SNAPSHOT' && call.message.readDocument)
    .map(call => call.options.documentId);
  await request({ type: 'CX_COLLECT' });
  assert.deepEqual(readers(), []);
  sent.length = 0;
  frames = [top, wrapper, preview, unrelated];
  await request({ type: 'CX_COLLECT' });
  assert.deepEqual(readers(), ['preview']);
});
test('an unresponsive auxiliary frame does not stop a confirmed player from starting', async () => {
  const { request, sent, chrome } = setup();
  await request({ type: 'CX_SAVE', enabled: true, preferences: {} });
  const frames = await chrome.webNavigation.getAllFrames();
  chrome.webNavigation.getAllFrames = async () => [...frames,
    { frameId: 9, parentFrameId: 0, documentId: 'blank', url: 'about:blank' }];
  chrome.tabs.sendMessage = async (tabId, message, options) => {
    sent.push({ tabId, message, options });
    if (options.documentId === 'blank') throw new Error('No receiving end');
    return { videos: options.documentId === 'video' ? [{ id: 'first', paused: true }] : [] };
  };
  const collected = await request({ type: 'CX_COLLECT', playback: { enabled: true } });
  assert.equal(sent.find(call => call.message.type === 'CX_SNAPSHOT' && call.options.documentId === 'video')
    .message.playback.activeVideoId, 'first');
  assert.equal(collected.some(frame => frame.documentId === 'blank'), false);
});
test('a video iframe awaiting its source is revealed before document reading', async () => {
  const { request, sent, chrome } = setup();
  await request({ type: 'CX_SAVE', enabled: true, preferences: {} });
  chrome.tabs.sendMessage = async (tabId, message, options) => {
    sent.push({ tabId, message, options });
    return { videos: [], videoAttachments: options.documentId === 'top' ? [{ id: 'pending', url: '' }] : [],
      documentTasks: options.documentId === 'top' ? [{ id: 'reader', completed: false }] : [] };
  };
  const [top] = await request({ type: 'CX_COLLECT', playback: { enabled: true } });
  const { message } = sent.find(call => call.message.type === 'CX_SNAPSHOT' && call.options.documentId === 'top');
  assert.equal(message.revealVideo, 'pending');
  assert.equal(message.revealDocument, null);
  assert.equal(top.pendingVideo, true);
});
test('the final snapshot uses the current platform video task flag', async () => {
  const { request, chrome } = setup();
  await request({ type: 'CX_SAVE', enabled: true, preferences: {} });
  chrome.tabs.sendMessage = async (_tabId, message, options) => {
    const videos = options?.documentId === 'video' ? [{ id: 'first', ended: true, taskRequired: true,
      platformCompleted: message.type === 'CX_INSPECT' }] : [];
    return { videos };
  };
  const frames = await request({ type: 'CX_COLLECT', playback: { enabled: true } });
  const [video] = frames.find(frame => frame.documentId === 'video').snapshot.videos;
  assert.equal(video.taskRequired, true);
  assert.equal(video.platformCompleted, false);
});
test('completion follows the current cards chapter even when the outer URL stays the same', async () => {
  const { request, sent, chrome } = setup();
  await request({ type: 'CX_SAVE', enabled: true, preferences: {} });
  let chapter = 1;
  let ended = true;
  chrome.webNavigation.getAllFrames = async () => [{ frameId: 1, parentFrameId: 0, documentId: 'cards',
    url: `https://mooc1.chaoxing.com/mooc-ans/knowledge/cards?knowledgeid=${chapter}` }];
  chrome.tabs.sendMessage = async (tabId, message, options) => {
    sent.push({ tabId, message, options });
    return { candidates: [], videos: [{ id: '1', completionKey: 'source:same.mp4', ended, paused: true }] };
  };
  const poll = () => request({ type: 'CX_COLLECT', playback: { enabled: true } },
    { url: 'https://mooc1.chaoxing.com/mycourse/studentstudy?courseid=a&chapterId=1' });
  await poll();
  ended = false;
  assert.equal((await poll())[0].snapshot.videos[0].completed, true);
  chapter = 2;
  assert.equal((await poll())[0].snapshot.videos[0].completed, undefined);
  assert.equal(sent.at(-1).message.playback.activeVideoId, '1');
});
test('child frames and unrelated origins cannot issue navigation commands', async () => {
  const { request, sent } = setup();
  for (const sender of [{ frameId: 4 }, { url: 'https://chaoxing.com.example.org/' }]) {
    assert.equal(typeof (await request({ type: 'CX_NEXT', documentId: 'video', id: 'next' }, sender)).error, 'string');
  }
  assert.equal(sent.length, 0);
});
test('closing a tab clears its activation but preserves other tabs', async () => {
  const { request, removed, session } = setup();
  await request({ type: 'CX_SAVE', course: 'a', enabled: true, preferences: {} });
  session['cx-next:9:a'] = { enabled: true };
  await removed(8);
  assert.equal(session['cx-next:8:a'], undefined);
  assert.equal(session['cx-next-guard:8'], undefined);
  assert.equal(session['cx-next:9:a'].enabled, true);
});

test('pause broadcasts a newer disabled guard to every content frame in the same tab', async () => {
  const { request, sent } = setup();
  const first = await request({ type: 'CX_SAVE', enabled: true, preferences: {} });
  const paused = await request({ type: 'CX_SAVE', enabled: false, preferences: {} });
  assert.ok(paused.epoch > first.epoch);
  const guard = sent.filter(call => call.message.type === 'CX_GUARD').at(-1);
  assert.equal(guard.tabId, 8);
  assert.equal(guard.options, undefined, 'omitting frame targeting fans the guard out to the whole tab');
  assert.equal(guard.message.enabled, false);
  assert.equal(guard.message.epoch, paused.epoch);
});

test('pausing while getAllFrames is pending makes later snapshots inspection-only', async () => {
  const { request, sent, chrome } = setup();
  const enabled = await request({ type: 'CX_SAVE', enabled: true, preferences: {} });
  let release, entered;
  const reached = new Promise(resolve => { entered = resolve; });
  const frames = await chrome.webNavigation.getAllFrames();
  chrome.webNavigation.getAllFrames = () => { entered(); return new Promise(resolve => { release = resolve; }); };
  const pending = request({ type: 'CX_COLLECT', speed: { enabled: true }, quiz: { enabled: true }, playback: { enabled: true } });
  await reached;
  const paused = await request({ type: 'CX_SAVE', enabled: false, preferences: {} });
  release(frames);
  await pending;
  const snapshots = sent.filter(call => call.message.type === 'CX_SNAPSHOT');
  assert.equal(snapshots.length, 2);
  for (const { message } of snapshots) {
    assert.equal(message.inspectionOnly, true);
    assert.equal(message.enabled, false);
    assert.equal(message.epoch, paused.epoch);
    assert.ok(message.epoch > enabled.epoch);
    for (const field of ['speed', 'quiz', 'playback']) assert.equal(message[field].enabled, false);
  }
});

test('persisted disabled control survives a background worker restart', async () => {
  const { request, sent, restart } = setup();
  const paused = await request({ type: 'CX_SAVE', enabled: false, preferences: {} });
  restart();
  sent.length = 0;
  await request({ type: 'CX_COLLECT', quiz: { enabled: true }, playback: { enabled: true } });
  for (const call of sent.filter(call => call.message.type === 'CX_SNAPSHOT')) {
    assert.equal(call.message.inspectionOnly, true);
    assert.equal(call.message.epoch, paused.epoch);
  }
  const resumed = await request({ type: 'CX_SAVE', enabled: true, preferences: {} });
  assert.ok(resumed.epoch > paused.epoch);
});

test('a paused or stale navigation request cannot click a section button', async () => {
  const { request, sent } = setup();
  const enabled = await request({ type: 'CX_SAVE', enabled: true, preferences: {} });
  await request({ type: 'CX_NEXT', epoch: enabled.epoch, documentId: 'top', id: 'next' });
  assert.equal(sent.filter(call => call.message.type === 'CX_CLICK').length, 1);
  const paused = await request({ type: 'CX_SAVE', enabled: false, preferences: {} });
  assert.equal((await request({ type: 'CX_NEXT', epoch: enabled.epoch, documentId: 'top', id: 'next' })).clicked, false);
  assert.equal((await request({ type: 'CX_NEXT', epoch: paused.epoch, documentId: 'top', id: 'next' })).clicked, false);
  assert.equal(sent.filter(call => call.message.type === 'CX_CLICK').length, 1);
});
test('unfinished-learning confirmation uses the same current enabled epoch', async () => {
  const { request, sent } = setup();
  const enabled = await request({ type: 'CX_SAVE', enabled: true, preferences: {} });
  await request({ type: 'CX_NEXT', epoch: enabled.epoch, documentId: 'top', id: 'confirm-next', confirmation: true });
  const click = sent.filter(call => call.message.type === 'CX_CLICK').at(-1);
  assert.equal(click.message.confirmation, true);
  assert.equal(click.message.id, 'confirm-next');
  await request({ type: 'CX_SAVE', enabled: false, preferences: {} });
  assert.equal((await request({ type: 'CX_NEXT', epoch: enabled.epoch, documentId: 'top', id: 'confirm-next', confirmation: true })).clicked, false);
  assert.equal(sent.filter(call => call.message.type === 'CX_CLICK').length, 1);
});

function contentSetup() {
  let listener, playbackPromise = Promise.resolve([]);
  const counts = { quiz: 0, playback: 0, speeds: 0, stops: 0, clicks: 0, confirmations: 0 };
  const context = {
    window: { top: {} }, document: {},
    chrome: { runtime: { onMessage: { addListener(fn) { listener = fn; } } } },
    CxAutoNext: { snapshot() { return { videos: [], candidates: [] }; }, videoDetails() { return []; },
      clickNext(_id, _selector, confirmation) { counts[confirmation ? 'confirmations' : 'clicks']++; return true; } },
    CxDocuments: { inspect() { return []; }, viewerDetails() { return {}; } },
    CxVideoQuiz: { step() { counts.quiz++; return { active: false, solved: false }; }, inspect() { return null; } },
    CxAutoPlayback: { update() { counts.playback++; return playbackPromise; }, stop() { counts.stops++; } },
    CxAutoSpeed: { update() { counts.speeds++; return []; } }
  };
  vm.runInNewContext(fs.readFileSync('extension/content.js', 'utf8'), context);
  return { counts, setPlayback(promise) { playbackPromise = promise; },
    send(message) { return new Promise(resolve => listener(message, {}, resolve)); } };
}

test('content rejects queued snapshots older than its newest guard', async () => {
  const { send, counts } = contentSetup();
  await send({ type: 'CX_GUARD', epoch: 10, enabled: false });
  await send({ type: 'CX_SNAPSHOT', epoch: 9, enabled: true, quiz: { enabled: true }, playback: { enabled: true } });
  await send({ type: 'CX_SNAPSHOT', epoch: 10, enabled: true, quiz: { enabled: true }, playback: { enabled: true } });
  assert.equal(counts.quiz, 0);
  assert.equal(counts.playback, 0);
  assert.equal(counts.speeds, 0);
  assert.equal(counts.stops, 1);
});

test('content checks its guard again after pending playback before applying speed', async () => {
  const { send, counts, setPlayback } = contentSetup();
  let release;
  setPlayback(new Promise(resolve => { release = resolve; }));
  const pending = send({ type: 'CX_SNAPSHOT', epoch: 10, enabled: true, quiz: { enabled: true }, playback: { enabled: true } });
  assert.equal(counts.quiz, 1);
  await send({ type: 'CX_GUARD', epoch: 11, enabled: false });
  release([{ status: 'started' }]);
  const snapshot = await pending;
  assert.equal(snapshot.speeds.length, 0);
  assert.equal(counts.speeds, 0);
  assert.equal(counts.stops, 1);
});

test('content allows only current-epoch navigation and ignores older stop guards', async () => {
  const { send, counts } = contentSetup();
  await send({ type: 'CX_SNAPSHOT', epoch: 20, enabled: true });
  await send({ type: 'CX_GUARD', epoch: 19, enabled: false });
  assert.equal((await send({ type: 'CX_CLICK', epoch: 19, id: 'next' })).clicked, false);
  assert.equal((await send({ type: 'CX_CLICK', epoch: 20, id: 'next' })).clicked, true);
  assert.equal(counts.stops, 0);
  assert.equal(counts.clicks, 1);
});
test('content only clicks a confirmation target while the current guard is enabled', async () => {
  const { send, counts } = contentSetup();
  await send({ type: 'CX_GUARD', epoch: 30, enabled: true });
  assert.equal((await send({ type: 'CX_CLICK', epoch: 30, id: 'confirm-next', confirmation: true })).clicked, true);
  await send({ type: 'CX_GUARD', epoch: 31, enabled: false });
  assert.equal((await send({ type: 'CX_CLICK', epoch: 30, id: 'confirm-next', confirmation: true })).clicked, false);
  assert.equal(counts.confirmations, 1);
  assert.equal(counts.clicks, 0);
});
