// Real unpacked extension tests in a fresh, isolated Edge profile. Every course,
// player and question response below is a local fixture; no real course is used.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const extension = path.resolve(process.env.CX_EXTENSION_DIR || 'extension');
const artifacts = path.resolve('artifacts');
fs.mkdirSync(artifacts, { recursive: true });
const courseUrl = (scenario, chapter = 1) =>
  `https://mooc1.chaoxing.com/mooc2-ans/mycourse/studentstudy?courseid=quiz-test-${scenario}&chapterId=${chapter}`;

function wav(seconds = 25) {
  const samples = Math.round(8000 * seconds);
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40);
  return bytes;
}

function courseHtml(scenario) {
  const mixed = scenario === 'mixed-reading';
  const chapterQuestions = ['chapter-questions', 'mixed-reading', 'mixed-reading-inner', 'quiz-pending-task',
    'completed-reading-quiz', 'completed-video-quiz', 'completed-document-quiz'].includes(scenario);
  const plain = scenario === 'plain-document';
  const src = chapterQuestions
    ? `https://mooc2.chaoxing.com/mooc-ans/work/doHomeWorkNew?workId=1&scenario=${scenario}`
    : `https://mooc2.chaoxing.com/ananas/modules/video/index.html?scenario=${scenario}`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
    <title>视频弹题与自动播放 · 模拟课程</title>
    <style>body{font:16px system-ui;margin:40px;background:#f0f5f5;color:#203c43}main{width:790px;padding:28px;background:white;border-radius:14px}iframe{width:100%;height:520px;border:0}#next{display:inline-block;padding:12px;background:#dcecea;border-radius:8px}</style>
    </head><body><main><h1>模拟课程 · ${scenario}</h1>
    ${mixed ? '<article><h2>本节课文</h2><p>读完这段说明后，再完成下面的章节题目。</p></article>' : ''}
    ${scenario === 'quiz-pending-task' ? '<div class="ans-attach-ct" data-jobid="reading-pending"><span class="ans-job-icon" title="任务点未完成"></span><article><p>这个非测验阅读任务尚未完成。</p></article></div>' : ''}
    ${scenario === 'completed-reading-quiz' ? '<div class="ans-attach-ct ans-job-finished" data-jobid="reading-completed"><span class="ans-job-icon" title="任务点已完成"></span><article><p>这个非测验阅读任务已由平台确认完成。</p></article></div>' : ''}
    ${scenario === 'completed-video-quiz' ? '<div class="ans-attach-ct ans-job-finished" data-jobid="video-completed"><span class="ans-job-icon" title="任务点已完成"></span><iframe class="ans-insertvideo" src="https://mooc3.chaoxing.com/ananas/modules/video/index.html?scenario=completed-video-quiz&objectid=completed-video"></iframe></div>' : ''}
    ${scenario === 'completed-document-quiz' ? '<div class="ans-attach-ct ans-job-finished" data-jobid="document-completed"><span class="ans-job-icon" title="任务点已完成"></span><iframe class="ans-insertdoc" src="https://mooc3.chaoxing.com/ananas/modules/pdf/index.html?scenario=completed-document-quiz"></iframe></div>' : ''}
    ${plain ? '<article><h2>本节阅读材料</h2><p>此页只有阅读材料。</p></article>' : `<iframe id="content-frame" src="${src}"></iframe>`}
    <a id="next" href="#" onclick="event.preventDefault();window.nextClicks++">下一节 &gt;</a>
    </main><script>window.nextClicks=0;</script></body></html>`;
}

function chapterHtml(scenario) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>章节测验</title></head>
    <body><div id="RightCon"><h1>章节测验 待完成</h1>
    ${scenario === 'mixed-reading-inner' ? '<article><p>本页还有实际阅读材料，不应当归类为独立测验。</p></article>' : ''}
    <div class="ans-attach-ct" data-jobid="work-fixture"><span class="ans-job-icon" title="任务点未完成"></span>
    <div id="question123456"><p>【单选题】这是独立章节题，扩展应当跳过而非作答。</p>
    <label><input type="radio" name="chapter-choice" value="a">A</label>
    <label><input type="radio" name="chapter-choice" value="b">B</label></div>
    <button id="chapter-submit" onclick="window.chapterSubmits++">提交</button></div></div>
    <script>window.chapterSubmits=0;window.chapterSelections=0;document.addEventListener('change',()=>window.chapterSelections++);</script>
    </body></html>`;
}

function playerHtml(scenario) {
  const popup = scenario.startsWith('popup-');
  const multiple = scenario === 'popup-checkbox';
  const type = multiple ? 'checkbox' : 'radio';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>视频播放器</title>
    <style>body{font:16px system-ui;margin:0}.video-js{position:relative}video{background:#eef3f4}.ans-videoquiz{background:#fff;border:1px solid #9dbbb5;padding:18px}.ans-videoquiz-opt{margin:12px 0}button{padding:8px 14px}#spanNot{color:#b73737}#spanRight{color:#14634c}[hidden]{display:none!important}</style>
    </head><body><div class="video-js"><video id="video" controls preload="auto" width="730" height="170" src="/tone.wav"></video>
    <button class="vjs-big-play-button" aria-label="播放视频" onclick="window.playClicks++;document.querySelector('video').play();this.hidden=true">播放</button>
    ${popup ? `<div class="ans-videoquiz" data-question-id="${scenario}"><div class="tkTopic">
      <h2 class="tkItem_title">${multiple ? '【多选题】请选择 A 和 B。' : '【单选题】请选择 B。'}</h2>
      <ul class="ans-videoquiz-opts">${['A', 'B', 'C'].map((label, index) => `<li class="ans-videoquiz-opt"><label><input type="${type}" name="ans-videoquiz-opt" value="${index}">${label} 选项 ${label}</label></li>`).join('')}</ul>
      <p id="spanNot" hidden>回答错误，请重新选择。</p><p id="spanRight" hidden>回答正确</p>
      <button id="videoquiz-retry" hidden onclick="document.querySelector('#spanNot').hidden=true;this.hidden=true">重新选择</button>
      <button id="videoquiz-submit">提交</button>
      <a href="#" id="videoquiz-continue" class="ans-videoquiz-continue" hidden>继续播放</a>
    </div></div>` : ''}</div>
    <script>
      window.playClicks=0;window.submissions=[];window.selectionEvents=0;window.continueClicks=0;
      document.addEventListener('change',()=>window.selectionEvents++);
      const submit=document.querySelector('#videoquiz-submit');
      if(submit)submit.addEventListener('click',()=>{
        const selected=Array.from(document.querySelectorAll('.ans-videoquiz-opt input:checked')).map(input=>Number(input.value)).sort();
        window.submissions.push(selected);
        ${scenario === 'popup-no-feedback' ? 'return;' : ''}
        const correct=JSON.stringify(selected)===JSON.stringify(${multiple ? '[0,1]' : '[1]'});
        document.querySelector('#spanNot').hidden=correct;
        document.querySelector('#spanRight').hidden=!correct;
        // This course permits changing the selection directly after a wrong answer.
        document.querySelector('#videoquiz-retry').hidden=true;
        document.querySelector('#videoquiz-continue').hidden=!correct;
        if(correct)submit.hidden=true;
      });
      const cont=document.querySelector('#videoquiz-continue');
      if(cont)cont.addEventListener('click',event=>{
        event.preventDefault();window.continueClicks++;
        document.querySelector('.ans-videoquiz').hidden=true;
        // The test deliberately leaves playback paused. The extension must resume.
      });
    </script></body></html>`;
}

(async () => {
  const context = await chromium.launchPersistentContext(path.join(artifacts, `edge-questions-${Date.now()}`), {
    channel: 'msedge', headless: true, viewport: { width: 1280, height: 1000 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--autoplay-policy=no-user-gesture-required']
  });
  const failures = [];
  const chapterCases = ['chapter-questions', 'mixed-reading', 'mixed-reading-inner', 'quiz-pending-task',
    'completed-reading-quiz', 'completed-video-quiz', 'completed-document-quiz'];
  let passed = 0;
  try {
    await context.route('**/*.chaoxing.com/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('/tone.wav')) return route.fulfill({ contentType: 'audio/wav', body: wav() });
      if (url.pathname.includes('/work/doHomeWorkNew')) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: chapterHtml(url.searchParams.get('scenario')) });
      if (url.pathname.includes('/ananas/modules/pdf/')) return route.fulfill({ contentType: 'text/html; charset=utf-8', body:
        '<!doctype html><html><meta charset="utf-8"><title>Completed course document</title><body><main id="viewerContainer"><p>The platform has already completed this document task.</p></main></body></html>' });
      if (url.pathname.includes('/ananas/modules/video/')) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: playerHtml(url.searchParams.get('scenario') || '') });
      const scenario = (url.searchParams.get('courseid') || '').replace(/^quiz-test-/, '');
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: courseHtml(scenario) });
    });
    async function run(scenario, verify, options = {}) {
      const page = await context.newPage();
      page.on('pageerror', error => failures.push(error.message));
      try {
        await page.goto(courseUrl(scenario));
        await page.waitForFunction(() => {
          const root=document.querySelector('#cx-auto-next-panel')?.shadowRoot;
          return root && !root.querySelector('#toggle').disabled;
        });
        const panel = page.locator('#cx-auto-next-panel');
        await panel.locator('summary').click();
        await panel.locator('#auto-speed').uncheck();
        if (options.autoQuiz === false) await panel.locator('#auto-quiz').uncheck();
        await panel.locator('#save').click();
        await panel.locator('#toggle').click();
        const selector = chapterCases.includes(scenario) ? '/work/doHomeWorkNew' : '/ananas/modules/video/';
        const frame = scenario === 'plain-document' ? null : page.frames().find(frame => frame.url().includes(selector));
        if (scenario !== 'plain-document') assert.ok(frame, `expected embedded fixture for ${scenario}`);
        await verify(page, frame, panel);
        if (chapterCases.includes(scenario)) {
          assert.equal(await frame.evaluate(() => window.chapterSelections), 0, 'chapter questions are not selected');
          assert.equal(await frame.evaluate(() => window.chapterSubmits), 0, 'chapter questions are not submitted');
        }
        passed++;
        console.log(`PASS ${scenario}`);
      } catch (error) {
        await page.screenshot({ path: path.join(artifacts, `questions-test-failure-${scenario}.png`) }).catch(() => {});
        console.error(`${scenario} status:`, await page.locator('#cx-auto-next-panel').locator('#status').textContent().catch(() => 'unavailable'));
        console.error(`${scenario} quiz status:`, await page.locator('#cx-auto-next-panel').locator('#quiz-status').textContent().catch(() => 'unavailable'));
        throw error;
      } finally { await page.close(); }
    }
    async function noNavigation(page, milliseconds = 6500) {
      await page.waitForTimeout(milliseconds);
      assert.equal(await page.evaluate(() => window.nextClicks), 0);
    }
    async function nextOnce(page) {
      await page.waitForFunction(() => window.nextClicks === 1, null, { timeout: 7000 });
      await page.waitForTimeout(2500);
      assert.equal(await page.evaluate(() => window.nextClicks), 1);
    }
    function uniqueAttempts(attempts) {
      return new Set(attempts.map(values => JSON.stringify(values))).size === attempts.length;
    }
    const results = await Promise.allSettled([
      run('popup-radio', async (page, player) => {
        await player.waitForFunction(() => window.continueClicks === 1, null, { timeout: 30000 });
        const attempts = await player.evaluate(() => window.submissions);
        assert.deepEqual(attempts, [[0], [1]]);
        assert.equal(uniqueAttempts(attempts), true);
        await player.waitForFunction(() => !document.querySelector('video').paused);
        assert.equal(await page.evaluate(() => window.nextClicks), 0);
        await page.screenshot({ path: path.join(artifacts, 'questions-radio-preview.png') });
      }),
      run('popup-checkbox', async (_page, player) => {
        await player.waitForFunction(() => window.continueClicks === 1, null, { timeout: 45000 });
        const attempts = await player.evaluate(() => window.submissions);
        assert.equal(uniqueAttempts(attempts), true);
        assert.ok(attempts.length <= 7);
        assert.deepEqual(attempts.at(-1), [0, 1]);
        await player.waitForFunction(() => !document.querySelector('video').paused);
      }),
      run('popup-no-feedback', async (page, player) => {
        await player.waitForFunction(() => window.submissions.length === 1);
        await noNavigation(page);
        assert.equal(await player.evaluate(() => window.submissions.length), 1);
        assert.equal(await player.evaluate(() => window.continueClicks), 0);
        assert.equal(await player.locator('video').evaluate(video => video.paused), true);
      }),
      run('chapter-questions', nextOnce),
      run('plain-document', page => noNavigation(page)),
      run('mixed-reading', page => noNavigation(page)),
      run('mixed-reading-inner', page => noNavigation(page)),
      run('quiz-pending-task', page => noNavigation(page)),
      run('completed-reading-quiz', nextOnce),
      run('completed-video-quiz', nextOnce),
      run('completed-document-quiz', nextOnce),
      run('auto-play', async (page, player) => {
        await player.waitForFunction(() => !document.querySelector('video').paused, null, { timeout: 10000 });
        assert.ok(await player.evaluate(() => window.playClicks) >= 1);
        await player.locator('video').evaluate(video => video.pause());
        await page.waitForTimeout(3500);
        assert.equal(await player.locator('video').evaluate(video => video.paused), true);
        await page.goto(courseUrl('auto-play', 2));
        await page.waitForFunction(() => document.querySelector('#cx-auto-next-panel')?.shadowRoot.querySelector('.badge').textContent === '已启用');
        const nextPlayer = page.frames().find(frame => frame.url().includes('/ananas/modules/video/'));
        assert.ok(nextPlayer);
        await nextPlayer.waitForFunction(() => !document.querySelector('video').paused, null, { timeout: 10000 });
      }),
      run('popup-disabled', async (page, player) => {
        await noNavigation(page);
        assert.equal(await player.evaluate(() => window.submissions.length), 0);
        assert.equal(await player.evaluate(() => window.selectionEvents), 0);
        assert.equal(await player.evaluate(() => window.continueClicks), 0);
        assert.equal(await player.locator('video').evaluate(video => video.paused), true);
      }, { autoQuiz: false })
    ]);
    const rejected = results.filter(result => result.status === 'rejected');
    if (rejected.length) throw new AggregateError(rejected.map(result => result.reason), `${rejected.length} question/content scenarios failed`);
    assert.deepEqual(failures, []);
    fs.writeFileSync(path.join(artifacts, 'questions-browser-test-result.txt'),
      `All ${passed} question/content/task/autoplay Edge scenarios passed.\nExtension tested: ${extension}\n`, 'utf8');
  } finally { await context.close(); }

})().catch(error => { console.error(error); process.exitCode = 1; });
