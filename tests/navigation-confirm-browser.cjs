// Isolated Edge fixtures for the second "next section" click after a warning.
// The test never attaches to the user's browser or accesses a real course.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const extension = path.resolve(process.env.CX_EXTENSION_DIR || 'extension');
const artifacts = path.resolve('artifacts');
fs.mkdirSync(artifacts, { recursive: true });
const courseUrl = scenario => `https://mooc1.chaoxing.com/mooc2-ans/mycourse/studentstudy?courseid=confirm-test-${scenario}&chapterId=1`;

function wav() {
  const samples = 8000 * 25;
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
  const warning = scenario === 'unrelated' ? '网络连接异常，请检查网络。' : '学习未完成，您还有任务点未完成，是否进入下一节？';
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>下一节提示测试</title>
    <style>body{font:16px system-ui;margin:32px}iframe{width:720px;height:300px;border:0}button{padding:10px 18px}[hidden]{display:none!important}[role=dialog]{position:fixed;top:70px;left:100px;width:460px;padding:24px;background:white;border:2px solid #27675f;z-index:1000}</style>
    <h1>模拟章节测验</h1><iframe id="lesson" src="https://mooc2.chaoxing.com/mooc-ans/work/doHomeWorkNew?workId=1"></iframe>
    <button id="main-next">下一节</button>
    <section id="unfinished-dialog" role="dialog" aria-label="学习提示" hidden>
      <p>${warning}</p><button id="cancel-warning">取消</button><button id="confirm-next">下一节</button>
    </section>
    <script>
      window.mainClicks=0;window.confirmClicks=0;
      document.querySelector('#main-next').addEventListener('click',()=>{
        window.mainClicks++;
        ${scenario === 'paused' ? '' : "document.querySelector('#unfinished-dialog').hidden=false;"}
      });
      document.querySelector('#cancel-warning').addEventListener('click',()=>{document.querySelector('#unfinished-dialog').hidden=true;});
      document.querySelector('#confirm-next').addEventListener('click',()=>{
        window.confirmClicks++;
        ${scenario === 'transition' ? `
          document.querySelector('#unfinished-dialog').hidden=true;
          document.querySelector('#lesson').src='https://mooc2.chaoxing.com/ananas/modules/video/index.html?part=2';
          const nextUrl=new URL(location.href);nextUrl.searchParams.set('chapterId','2');history.replaceState(null,'',nextUrl);
        ` : ''}
      });
    </script></html>`;
}

const questionHtml = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>章节测验</title>
  <h1>章节测验 待完成</h1><h3>2.1</h3><div>题量: 1</div><div>满分: 100.0</div><h4>一、单选题（共1题）</h4>
  <div class="ans-attach-ct"><span class="ans-job-icon" title="任务点未完成"></span></div>
  <div id="question998877"><p>【单选题】本页面只有题目，不应作答或提交。</p>
  <label><input type="radio" name="choice" value="a">A</label><label><input type="radio" name="choice" value="b">B</label></div>
  <button id="submit" onclick="window.submitClicks++">提交</button>
  <script>window.submitClicks=0;window.selections=0;document.addEventListener('change',()=>window.selections++);</script></html>`;
const playerHtml = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>新视频</title>
  <div class="video-js"><video controls width="700" height="220" preload="auto" src="/tone.wav"></video>
  <button class="vjs-big-play-button" aria-label="播放视频" onclick="window.playClicks++;document.querySelector('video').play();this.hidden=true">播放</button></div>
  <script>window.playClicks=0;</script></html>`;

(async () => {
  const context = await chromium.launchPersistentContext(path.join(artifacts, `edge-next-confirm-${Date.now()}`), {
    channel: 'msedge', headless: true, viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--autoplay-policy=no-user-gesture-required']
  });
  const errors = [];
  try {
    await context.route('**/*.chaoxing.com/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('/tone.wav')) return route.fulfill({ contentType: 'audio/wav', body: wav() });
      if (url.pathname.includes('/work/doHomeWorkNew')) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: questionHtml });
      if (url.pathname.includes('/ananas/modules/video/')) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: playerHtml });
      const scenario = (url.searchParams.get('courseid') || '').replace('confirm-test-', '');
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: courseHtml(scenario) });
    });
    async function run(scenario, verify) {
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
        await panel.locator('#toggle').click();
        await page.waitForFunction(() => window.mainClicks === 1, null, { timeout: 12000 });
        await verify(page, panel);
        const chapter = page.frames().find(frame => frame.url().includes('/work/doHomeWorkNew'));
        if (chapter) {
          assert.equal(await chapter.evaluate(() => window.submitClicks), 0);
          assert.equal(await chapter.evaluate(() => window.selections), 0);
        }
        console.log(`PASS ${scenario}`);
      } catch (error) {
        await page.screenshot({ path: path.join(artifacts, `next-confirm-failure-${scenario}.png`) }).catch(() => {});
        console.error(`${scenario} status:`, await page.locator('#cx-auto-next-panel').locator('#status').textContent().catch(() => 'unavailable'));
        throw error;
      } finally { await page.close(); }
    }
    // Each tab has its own course key and control state, so fixtures can run together.
    await Promise.all([
      run('transition', async page => {
        await page.waitForFunction(() => window.confirmClicks === 1, null, { timeout: 8000 });
        await page.waitForFunction(() => new URL(location.href).searchParams.get('chapterId') === '2');
        await page.frameLocator('#lesson').locator('video').waitFor({ state: 'attached', timeout: 8000 });
        const player = page.frames().find(frame => frame.url().includes('/ananas/modules/video/'));
        assert.ok(player, 'confirmation leads to the next video frame');
        await player.waitForFunction(() => !document.querySelector('video').paused, null, { timeout: 8000 });
        assert.equal(await page.evaluate(() => window.mainClicks), 1);
        assert.equal(await page.evaluate(() => window.confirmClicks), 1);
        assert.ok(await player.evaluate(() => window.playClicks) >= 1, 'the new video play control is clicked');
      }),
      run('sticky', async page => {
        await page.waitForFunction(() => window.confirmClicks === 1, null, { timeout: 8000 });
        await page.waitForTimeout(4500);
        assert.equal(await page.evaluate(() => window.confirmClicks), 1, 'a warning still visible after clicking is not clicked repeatedly');
        assert.equal(await page.evaluate(() => window.mainClicks), 1);
      }),
      run('unrelated', async page => {
        await page.waitForTimeout(4500);
        assert.equal(await page.evaluate(() => window.confirmClicks), 0, 'a different warning must not be accepted');
        assert.equal(await page.evaluate(() => window.mainClicks), 1);
      }),
      run('paused', async (page, panel) => {
        await panel.locator('#toggle').click();
        await page.locator('#unfinished-dialog').evaluate(dialog => { dialog.hidden = false; });
        await page.waitForTimeout(4500);
        assert.equal(await page.evaluate(() => window.confirmClicks), 0, 'pausing cancels the second next click');
      })
    ]);
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(artifacts, 'navigation-confirm-test-result.txt'),
      `All 4 unfinished-learning confirmation scenarios passed.\nExtension tested: ${extension}\n`, 'utf8');
  } finally { await context.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
