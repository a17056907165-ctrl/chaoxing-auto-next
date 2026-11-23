// Tests the unpacked extension in an isolated Edge profile using synthetic pages.
// No real course, authentication state, or user browser is accessed.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const extension = path.resolve(process.env.CX_EXTENSION_DIR || 'extension');
const artifacts = path.resolve('artifacts');
fs.mkdirSync(artifacts, { recursive: true });
const courseUrl = scenario => `https://mooc1.chaoxing.com/mycourse/studentstudy?courseid=empty-test-${scenario}&chapterId=1`;

function wav() {
  const samples = 8000 * 25;
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF'); buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write('WAVEfmt ', 8); buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(8000, 24); buffer.writeUInt32LE(16000, 28);
  buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(samples * 2, 40);
  return buffer;
}

const playerMarkup = `<div class="video-js" data-video-player>
  <video controls width="660" height="200" preload="auto" src="/tone.wav"></video>
  <button class="vjs-big-play-button" aria-label="播放视频" onclick="document.querySelector('video').play();this.hidden=true">播放</button>
</div>`;
const emptyIllustration = '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="110" viewBox="0 0 180 110"><rect x="30" y="20" width="120" height="75" rx="8" fill="#dce9ed"/><path d="M60 48h60M60 65h45" stroke="#9db6c0" stroke-width="5"/></svg>';
const illustrationImage = `<img alt="" width="180" height="110" src="data:image/svg+xml,${encodeURIComponent(emptyIllustration)}">`;
const illustratedEmpty = `<div class="empty-state" style="text-align:center;padding:24px">${illustrationImage}<p>暂无内容</p></div>`;
const screenshotCases = ['heading-only', 'styled-heading-only', 'empty-illustration-img', 'empty-illustration-svg',
  'empty-with-reading', 'empty-with-image', 'heading-with-reading'];

function courseHtml(scenario) {
  if (scenario.startsWith('real-')) return realCourseHtml(scenario);
  const nested = ['nested', 'delayed-video', ...screenshotCases].includes(scenario);
  const startsLoading = ['loading', 'paused'].includes(scenario);
  const content = nested
    ? `<iframe id="iframe" src="https://mooc2.chaoxing.com/mooc-ans/knowledge/cards?courseid=empty-test-${scenario}&knowledgeid=1&scenario=${scenario}"></iframe>`
    : startsLoading
      ? '<div id="loading-content" role="progressbar" aria-label="课程内容加载中">课程内容加载中…</div>'
      : {
          reading: '<article><h2>本节阅读资料</h2><p>本节课程的阅读材料。</p></article>',
          'non-video-media': '<object type="application/pdf" aria-label="课程讲义"><p>课程讲义.pdf</p></object><audio controls src="/tone.wav"></audio>',
          'pending-reading': '<div class="ans-attach-ct" data-jobid="reading-required"><span class="ans-job-icon" title="任务点未完成"></span><article><p>这是尚未完成的必读课程材料。</p></article></div>',
          'pending-audio': '<div class="ans-attach-ct" data-jobid="audio-required"><span class="ans-job-icon" title="任务点未完成"></span><audio controls src="/tone.wav"></audio></div>',
          'pending-document': '<div class="ans-attach-ct" data-jobid="document-required"><span class="ans-job-icon" title="任务点未完成"></span><iframe class="ans-insertdoc" src="https://mooc3.chaoxing.com/ananas/modules/pdf/index.html?part=pending-document"></iframe></div>',
          'pending-unknown': '<div class="ans-attach-ct" data-jobid="unknown-required"><span class="ans-job-icon" title="任务点未完成"></span></div>',
          'empty-message': '<div id="chapter-content">本章节暂无课程内容</div>'
        }[scenario] || '<div id="chapter-content"></div>';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>空章节跳转测试</title>
    <style>body{font:16px system-ui;margin:32px;display:flex;gap:30px}#mainid{width:760px}iframe{width:720px;height:330px;border:0}button{padding:9px 18px}aside{width:220px;color:#576b73}[hidden]{display:none!important}[role=dialog]{position:fixed;left:100px;top:80px;background:white;border:2px solid #306b62;padding:24px}</style>
    </head><body><main id="mainid"><h2 class="chapter-title">本节课程</h2>
      <section id="course-content">${content}</section>
      <div id="prevNextFocus"><button id="main-next">下一节</button></div>
    </main><aside id="content1"><h3>目录</h3><p>第一章 课程介绍</p><p>第二章 课程内容</p><p>讨论　笔记　标注</p></aside>
    <section id="unfinished" role="dialog" hidden><p>学习未完成，是否进入下一节？</p><button id="confirm-next">下一节</button></section>
    <script>
      window.nextClicks=0;window.confirmClicks=0;
      document.querySelector('#main-next').addEventListener('click',()=>{
        window.nextClicks++;
        ${scenario === 'warning' ? "document.querySelector('#unfinished').hidden=false;" : ''}
      });
      document.querySelector('#confirm-next').addEventListener('click',()=>{window.confirmClicks++;document.querySelector('#unfinished').hidden=true;});
    </script></body></html>`;
}

function realCourseHtml(scenario) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>学生学习页面</title>
    <style>body{font:16px system-ui;margin:32px;display:flex;gap:30px}#mainid{width:760px}.prev_title{font-size:26px}.prev_list{display:flex;gap:14px;margin:16px 0}.course_main iframe{width:720px;height:330px;border:0}#prevNextFocus{display:flex;gap:16px}button{padding:9px 18px}.iconBox{position:fixed;left:760px;top:160px}.iconBox img{display:block;width:32px;height:32px}.iconBox span{display:block}aside{width:180px}</style>
    </head><body><div id="mainid">
      <div class="prev_title_pos" role="option"><div class="prev_title" title="本节课程">本节课程</div></div>
      <div id="prev_tab" class="prev_list"><span>章节内容</span><span>学习资料</span></div>
      <div id="qqqq" class="course_main"><iframe id="iframe" src="https://mooc2.chaoxing.com/mooc-ans/knowledge/cards?courseid=empty-test-${scenario}&knowledgeid=1&scenario=${scenario}"></iframe></div>
      <div id="prevNextFocus"><button id="previous">上一节</button><button id="main-next">下一节</button></div>
      <div class="iconBox"><img alt="课堂笔记" src="data:image/svg+xml,${encodeURIComponent(emptyIllustration)}"><span>笔记</span><img alt="问题反馈" src="data:image/svg+xml,${encodeURIComponent(emptyIllustration)}"><span>反馈</span></div>
    </div><aside id="content1"><p>第一章 课程介绍</p><p>第二章 课程内容</p></aside>
    <script>window.nextClicks=0;window.confirmClicks=0;document.querySelector('#main-next').addEventListener('click',()=>window.nextClicks++);</script></body></html>`;
}

function nestedHtml(scenario) {
  if (scenario.startsWith('real-')) {
    const nullpage = '<div class="nullpage"><dl><dt><img width="180" height="110" src="https://mooc2.chaoxing.com/mooc-ans/images/nullImg.png"></dt><dd>暂无内容</dd></dl></div>';
    const content = scenario === 'real-blank' ? '' : nullpage;
    const extra = scenario === 'real-reading'
      ? '<p>这里仍然存在实际课程阅读正文，不能被空态提示一起忽略。</p>'
      : scenario === 'real-image'
        ? `<img width="180" height="110" alt="课程知识结构图" src="data:image/svg+xml,${encodeURIComponent(emptyIllustration)}">`
        : '';
    return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>章节内容</title><body><div id="pageDiv" class="ans-cc">${content}${extra}</div></body></html>`;
  }
  const screenshotContents = {
    'heading-only': '<h2><span>本节课程</span></h2><div style="min-height:160px"></div><nav><button>上一节</button><button>下一节</button></nav>',
    'styled-heading-only': '<div><p style="font-size:24px;font-weight:700"><span><strong>本节课程</strong></span></p></div><div style="min-height:160px"></div><nav><button>上一节</button><button>下一节</button></nav>',
    'empty-illustration-img': illustratedEmpty,
    'empty-illustration-svg': `<section class="empty-state" style="text-align:center;padding:24px">${emptyIllustration}<p>暂无内容</p></section>`,
    'empty-with-reading': `${illustratedEmpty}<article><h3>补充阅读</h3><p>这一段是仍然存在的实际课程阅读内容。</p></article>`,
    'empty-with-image': `${illustratedEmpty}<figure><img width="180" height="110" alt="课程知识结构图" src="data:image/svg+xml,${encodeURIComponent(emptyIllustration)}"><figcaption>本节课程的知识结构图</figcaption></figure>`,
    'heading-with-reading': '<h2><span>本节课程</span></h2><p>标题下面这段正文是实际课程阅读内容，不应被一起忽略。</p>'
  };
  if (screenshotContents[scenario]) return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>本节课程</title><body><div id="pageDiv">${screenshotContents[scenario]}</div></body></html>`;
  if (scenario !== 'delayed-video') return '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>课程内容</title><body><div id="pageDiv"></div></body></html>';
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>正在加载视频</title><body>
    <div id="pageDiv"><div class="video-js" data-video-player><span role="progressbar">视频正在加载…</span></div></div>
    <script>setTimeout(()=>{document.querySelector('#pageDiv').innerHTML=${JSON.stringify(playerMarkup)};},3500);</script>
    </body></html>`;
}

(async () => {
  const context = await chromium.launchPersistentContext(path.join(artifacts, `edge-empty-${Date.now()}`), {
    channel: 'msedge', headless: true, viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--autoplay-policy=no-user-gesture-required']
  });
  const errors = [];
  try {
    await context.route('**/*.chaoxing.com/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('/tone.wav')) return route.fulfill({ contentType: 'audio/wav', body: wav() });
      if (url.pathname.endsWith('/images/nullImg.png')) return route.fulfill({ contentType: 'image/svg+xml', body: emptyIllustration });
      if (url.pathname.includes('/ananas/modules/pdf/')) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><html><meta charset="utf-8"><title>课程文档</title><body><main id="viewerContainer"><h1>必读讲义</h1><p>平台尚未标记该文档任务已完成。</p></main></body></html>' });
      if (url.pathname.includes('/knowledge/cards')) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: nestedHtml(url.searchParams.get('scenario')) });
      const scenario = (url.searchParams.get('courseid') || '').replace('empty-test-', '');
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: courseHtml(scenario) });
    });
    async function run(scenario, verify, { enable = true } = {}) {
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      try {
        await page.goto(courseUrl(scenario));
        await page.waitForFunction(() => {
          const root = document.querySelector('#cx-auto-next-panel')?.shadowRoot;
          return root && !root.querySelector('#toggle').disabled;
        });
        const panel = page.locator('#cx-auto-next-panel');
        await panel.locator('summary').click();
        await panel.locator('#auto-speed').uncheck();
        await panel.locator('#save').click();
        if (enable) await panel.locator('#toggle').click();
        await verify(page, panel);
        console.log(`PASS ${scenario}`);
      } catch (error) {
        await page.screenshot({ path: path.join(artifacts, `empty-failure-${scenario}.png`) }).catch(() => {});
        console.error(`${scenario} status:`, await page.locator('#cx-auto-next-panel').locator('#status').textContent().catch(() => 'unavailable'));
        throw error;
      } finally { await page.close(); }
    }
    async function stays(page, milliseconds = 6500) {
      await page.waitForTimeout(milliseconds);
      assert.equal(await page.evaluate(() => window.nextClicks), 0);
    }
    async function finishLoading(page) {
      await page.locator('#loading-content').evaluate(loading => {
        loading.outerHTML = '<article><p>加载完成后的阅读材料。</p></article>';
      });
    }
    async function skipsOnce(page) {
      await page.waitForFunction(() => window.nextClicks === 1, null, { timeout: 4500 });
      await page.waitForTimeout(3200);
      assert.equal(await page.evaluate(() => window.nextClicks), 1, 'page without video does not repeatedly click next');
    }
    const results = await Promise.allSettled([
      run('direct', skipsOnce),
      run('empty-message', skipsOnce),
      run('nested', skipsOnce),
      run('real-blank', skipsOnce),
      run('real-nullpage', skipsOnce),
      run('real-reading', page => stays(page)),
      run('real-image', page => stays(page)),
      run('heading-only', skipsOnce),
      run('styled-heading-only', skipsOnce),
      run('empty-illustration-img', skipsOnce),
      run('empty-illustration-svg', skipsOnce),
      run('empty-with-reading', page => stays(page)),
      run('empty-with-image', page => stays(page)),
      run('heading-with-reading', page => stays(page)),
      run('delayed-video', async page => {
        const frame = page.frames().find(frame => frame.url().includes('/knowledge/cards'));
        assert.ok(frame);
        await frame.waitForFunction(() => Boolean(document.querySelector('video')), null, { timeout: 8000 });
        await frame.waitForFunction(() => !document.querySelector('video').paused, null, { timeout: 6000 });
        assert.equal(await page.evaluate(() => window.nextClicks), 0);
      }),
      run('loading', async page => {
        await stays(page, 3200);
        await finishLoading(page);
        await stays(page, 3500);
      }),
      run('reading', page => stays(page)),
      run('non-video-media', page => stays(page)),
      run('pending-reading', page => stays(page)),
      run('pending-audio', page => stays(page)),
      run('pending-document', page => stays(page)),
      run('pending-unknown', page => stays(page)),
      run('disabled', page => stays(page), { enable: false }),
      run('paused', async (page, panel) => {
        await panel.locator('#toggle').click();
        await finishLoading(page);
        await stays(page);
      }),
      run('warning', async page => {
        await page.waitForFunction(() => window.confirmClicks === 1, null, { timeout: 10000 });
        await page.waitForTimeout(2000);
        assert.equal(await page.evaluate(() => window.nextClicks), 1);
        assert.equal(await page.evaluate(() => window.confirmClicks), 1);
      })
    ]);
    const rejected = results.filter(result => result.status === 'rejected');
    if (rejected.length) throw new AggregateError(rejected.map(result => result.reason), `${rejected.length} empty/content scenarios failed`);
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(artifacts, 'empty-chapter-test-result.txt'),
      `All 25 empty/content/task Edge scenarios passed.\nExtension tested: ${extension}\n`, 'utf8');
  } finally { await context.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
