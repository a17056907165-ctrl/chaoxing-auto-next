const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const context = vm.createContext({ URL });
vm.runInContext(fs.readFileSync('extension/core.js', 'utf8'), context);
const { assess, isNextText } = context.CxAutoNext;
const video = (overrides = {}) => ({ id: 'video-1', source: 'video.mp4', duration: 60,
  currentTime: 60, paused: true, ended: true, error: false, ...overrides });
const frame = (overrides = {}) => ({ frameId: 0, documentId: 'page-1', snapshot: {
  videos: [video()], pendingTasks: 0, candidates: [{ id: 'next-1', disabled: false }],
  selectorError: false, ...overrides } });

test('accepts chapter navigation text without mistaking slides for chapters', () => {
  for (const text of ['下一节', ' 下 一 节 > ', '下一章节', '下一章', '下一个视频', '下一知识点']) assert.equal(isNextText(text), true);
  for (const text of ['上一节', '下一页', '下一题', '提交答案', '下一节未解锁', '转到下一节吗']) assert.equal(isNextText(text), false);
});
test('requires responding course frames and advances a loaded blank page', () => {
  assert.equal(assess([]).ready, false);
  assert.equal(assess([frame(), { error: true }]).ready, false);
  assert.equal(assess([frame({ videos: [] })]).ready, true);
});
test('loaded question-only chapters can skip without answering their unfinished tasks', () => {
  const result = assess([frame({ videos: [],
    questionKey: 'questions-a', pageKey: '/chapter/1', hasQuiz: true, tasks: [{ quiz: true, completed: false }] })]);
  assert.equal(result.ready, true);
  assert.equal(result.mode, 'quiz');
  assert.equal(result.target.id, 'next-1');
  assert.match(result.status, /答题页/);
});
test('question evidence from a nested frame uses the top-frame next-section button', () => {
  const top = frame({ videos: [], pageKey: '/studentstudy?chapterId=1' });
  const child = { frameId: 7, documentId: 'work-frame', snapshot: {
    videos: [], hasQuiz: true, candidates: [], selectorError: false,
    questionKey: 'question406502489', pageKey: '/work/doHomeWorkNew'
  } };
  const result = assess([top, child]);
  assert.equal(result.ready, true);
  assert.equal(result.target.frameId, 0);
});
test('question-only evidence does not bypass loading video frames or active popups', () => {
  for (const state of [{ loading: true }, { videoContext: true }, { activeVideoQuiz: true }, { quiz: { active: true } }]) {
    assert.equal(assess([frame({ videos: [], ...state })]).ready, false);
  }
  assert.equal(assess([frame({ videos: [] }),
    { frameId: 4, documentId: 'loading-player', snapshot: {
      videos: [], candidates: [], videoContext: true, pendingTasks: 0 } }]).ready, false);
});
test('any unfinished video wins over question-page skipping', () => {
  assert.equal(assess([frame({ contentState: 'questions', videos: [video({ ended: false })] })]).ready, false);
});
test('question-only skipping still respects missing, locked and inaccessible navigation', () => {
  for (const candidates of [[], [{ id: 'next-1', disabled: true }]]) {
    assert.equal(assess([frame({ videos: [], candidates })]).ready, false);
  }
  assert.equal(assess([frame({ videos: [] }), { error: true }]).ready, false);
});
test('question-only SPA chapter or question replacement changes the one-shot signature', () => {
  const content = { videos: [], pageKey: '/chapter/1', hasQuiz: true, questionKey: 'question-a' };
  const original = assess([frame(content)]).signature;
  assert.notEqual(assess([frame({ ...content, pageKey: '/chapter/2' })]).signature, original);
  assert.notEqual(assess([frame({ ...content, questionKey: 'question-b' })]).signature, original);
  assert.equal(assess([frame({ ...content, pendingTasks: 1 })]).signature, original);
});
test('a second unfinished video prevents navigation', () => {
  assert.equal(assess([frame({ videos: [video(), video({ id: 'v2', ended: false, paused: false })] })]).ready, false);
  assert.equal(assess([frame(), { ...frame({ videos: [video({ ended: false })] }), documentId: 'nested-video', frameId: 5 }]).ready, false);
});
test('loading, paused, almost-ended and error states never advance', () => {
  for (const overrides of [{ ended: false, duration: null }, { ended: false, paused: true },
    { ended: false, currentTime: 59.99 }, { ended: false, error: true }]) {
    assert.equal(assess([frame({ videos: [video(overrides)] })]).ready, false);
  }
});
test('invalid selectors, locked buttons and final chapters wait', () => {
  for (const overrides of [{ selectorError: true }, { candidates: [] },
    { candidates: [{ id: 'next', disabled: true }] }]) assert.equal(assess([frame(overrides)]).ready, false);
});
test('known completions count across unmarked media and platform-confirmed players', () => {
  const completed = frame({ videos: [
    video({ ended: false, currentTime: 0, platformCompleted: true }),
    video({ id: 'second', ended: false, currentTime: 0, completed: true, error: true })
  ] });
  const result = assess([completed]);
  assert.equal(result.ready, true);
  assert.match(result.status, /全部完成/);
  const unfinished = frame({ videos: [video({ ended: false, currentTime: 0 })] });
  assert.equal(assess([completed, unfinished]).ready, false);
  assert.match(assess([completed, unfinished]).status, /已完成 2\/3/);
});
test('finished media can advance and prefers top-frame navigation', () => {
  const child = { ...frame(), frameId: 3, documentId: 'child' };
  const result = assess([child, frame()]);
  assert.equal(result.ready, true);
  assert.equal(result.mode, 'video');
  assert.equal(result.target.frameId, 0);
});
test('same-document chapter media replacement changes navigation signature', () => {
  const original = assess([frame()]).signature;
  assert.notEqual(assess([frame({ videos: [video({ source: 'next.mp4' })] })]).signature, original);
  assert.notEqual(assess([{ ...frame(), documentId: 'page-2' }]).signature, original);
  assert.notEqual(assess([frame({ videos: [video({ id: 'replacement' })] })]).signature, original);
});
test('loaded empty chapter can advance, including nested empty course cards', () => {
  const direct = frame({ videos: [] });
  assert.equal(assess([direct]).mode, 'empty');
  const shell = frame({ videos: [] });
  const leaf = { ...frame({ videos: [], candidates: [] }), frameId: 3, documentId: 'cards' };
  assert.equal(assess([shell, leaf]).mode, 'empty');
});
test('finished video does not hide an unloaded second player or lazy video frame', () => {
  const ended = frame();
  const placeholder = { frameId: 5, documentId: 'unloaded', snapshot: {
    videos: [], candidates: [], playerDocument: true, videoContext: true } };
  assert.equal(assess([ended, placeholder]).ready, false);
  assert.equal(assess([{ ...ended, pendingVideo: true }]).ready, false);
  assert.equal(assess([frame({ unloadedVideo: true })]).ready, false);
});
test('an unfinished non-quiz task holds the chapter even alongside a quiz', () => {
  const quiz = { frameId: 4, documentId: 'quiz', parentFrameId: 0, url: 'https://mooc1.chaoxing.com/work/doWork',
    snapshot: { videos: [], hasQuiz: true } };
  const task = { id: 'reading', quiz: false, completed: false };
  const chapter = frame({ videos: [], hasMaterial: true, tasks: [task] });
  assert.equal(assess([chapter, quiz]).ready, false);
  task.completed = true;
  assert.equal(assess([chapter, quiz]).ready, true);
  const frameUrl = 'https://mooc1.chaoxing.com/knowledge/cards?knowledgeid=2';
  const shell = frame({ videos: [], contentFrameUrls: [frameUrl] });
  assert.equal(assess([shell, quiz]).ready, false);
  const content = { frameId: 5, documentId: 'cards', parentFrameId: 0, url: frameUrl,
    snapshot: { videos: [], loading: true } };
  assert.equal(assess([shell, quiz, content]).ready, false);
  content.snapshot.loading = false;
  assert.equal(assess([shell, quiz, content]).ready, true);
});

test('ordinary reading remains even when the same chapter contains quiz questions', () => {
  assert.equal(assess([frame({ videos: [], hasMaterial: true, hasQuiz: true })]).ready, false);
});

test('required video waits for a platform marker when ended or cached locally', () => {
  const marked = { taskRequired: true, platformCompleted: false };
  const ended = assess([frame({ videos: [video(marked)] })]);
  assert.equal(ended.ready, false);
  assert.match(ended.status, /等待学习通确认视频任务点/);
  assert.equal(assess([frame({ videos: [video({ ...marked, ended: false, completed: true })] })]).ready, false);
  assert.equal(assess([frame({ videos: [video({ ...marked, platformCompleted: true })] })]).ready, true);
});

test('only a known pending quiz allows a mixed chapter to confirm the unfinished warning', () => {
  const warning = { confirmations: [{ id: 'confirm', disabled: false }] };
  assert.equal(assess([frame(warning)]).blockedConfirmation, true);
  const withQuiz = assess([frame({ ...warning, tasks: [{ id: 'question', quiz: true, completed: false }] })]);
  assert.equal(withQuiz.confirmation.id, 'confirm');
});

test('marked document and PPT tasks require the platform completion marker before navigation', () => {
  const pdf = { id: 'pdf', url: '/ananas/modules/pdf/index.html', completed: true };
  const ppt = { id: 'ppt', url: '/ananas/modules/ppt/index.html', completed: false };
  const chapter = frame({ videos: [], documentTasks: [pdf, ppt] });
  assert.equal(assess([chapter]).ready, false);
  assert.match(assess([chapter]).status, /已完成 1\/2/);
  ppt.completed = true;
  assert.equal(assess([chapter]).ready, true);
  const anotherChapter = frame({ videos: [], documentTasks: [pdf, { ...ppt, url: '/another-ppt' }] });
  assert.notEqual(assess([chapter]).signature, assess([anotherChapter]).signature);
});

test('navigation ignores chapter-like buttons inside a document preview', () => {
  const chapter = frame({ videos: [], candidates: [] });
  const viewer = { ...frame({ videos: [], documentViewer: true }), frameId: 4, documentId: 'viewer' };
  assert.equal(assess([chapter, viewer]).ready, false);
});

test('a chapter stays eligible while its warning temporarily replaces the primary next control', () => {
  const opening = assess([frame({ videos: [] })]);
  const warning = assess([{ ...frame({ videos: [], candidates: [],
    confirmations: [{ id: 'confirm', disabled: false }] }), epoch: 99 }]);
  assert.equal(warning.ready, false);
  assert.equal(warning.eligible, true);
  assert.equal(warning.signature, opening.signature);
  assert.equal(warning.confirmation.id, 'confirm');
  assert.equal(warning.confirmation.epoch, 99);
});
