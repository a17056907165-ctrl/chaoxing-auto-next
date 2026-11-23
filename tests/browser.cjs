// Exercises the real unpacked extension in an isolated Edge profile.
// All course responses are fixtures; no real account or course is accessed.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const extension = path.resolve(process.env.CX_EXTENSION_DIR || 'extension');
const artifacts = path.resolve('artifacts');
fs.mkdirSync(artifacts, { recursive: true });
const courseUrl = (scenario, chapter = 1) => `https://mooc1.chaoxing.com/mooc2-ans/mycourse/studentstudy?courseid=${scenario}&chapterId=${chapter}`;

function wav(seconds = 0.4) {
  const samples = Math.round(8000 * seconds), data = Buffer.alloc(44 + samples * 2);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(8000, 24); data.writeUInt32LE(16000, 28); data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(samples * 2, 40);
  return data;
}
function topHtml(scenario) {
  const multi = scenario === 'multi';
  const task = scenario === 'task' ? '<div class="ans-attach-ct"><span class="ans-job-icon" title="任务点未完成"></span></div>' : '';
  const next = scenario === 'last' ? '' : `<a id="next" href="#" onclick="event.preventDefault(); window.clicks++">下一节 &gt;</a>`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>自动下一节 · 模拟课程测试</title>
    <style>body{font:16px system-ui;background:#f2f6f7;color:#233a44;margin:60px}main{max-width:860px;background:white;padding:32px;border-radius:16px}iframe{width:100%;height:245px;border:0}a{display:inline-block;background:#e4eeee;color:#185d56;padding:12px 22px;border-radius:8px;text-decoration:none;margin-top:18px}</style></head>
    <body><main><h1>模拟课程 · 第一节</h1><p>此页面用于验证播放结束后立即切换、暂停与按钮状态。</p>
    <iframe src="https://mooc2.chaoxing.com/ananas/modules/video/index.html?part=1&scenario=${scenario}"></iframe>
    ${multi ? '<iframe src="https://mooc3.chaoxing.com/ananas/modules/video/index.html?part=2"></iframe>' : ''}
    ${task}${next}</main><script>window.clicks=0;</script></body></html>`;
}

(async () => {
  const context = await chromium.launchPersistentContext(path.join(artifacts, `edge-profile-${Date.now()}`), {
    channel: 'msedge', headless: true, viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--autoplay-policy=no-user-gesture-required']
  });
  try {
    await context.route('**/*.chaoxing.com/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('/tone.wav')) return route.fulfill({ contentType: 'audio/wav', body: wav(url.searchParams.has('long') ? 12 : url.searchParams.has('pause') ? 2.4 : 0.4) });
      if (url.pathname.includes('/ananas/')) {
        const scenario = url.searchParams.get('scenario') || '';
        const long = scenario.startsWith('speed');
        const reset = scenario === 'speed-reset' ? `<script>
          const video=document.querySelector('video');window.rateEvents=0;
          video.addEventListener('ratechange',()=>{window.rateEvents++;if(video.playbackRate!==1)video.playbackRate=1;});
          </script>` : '';
        const lock = scenario === 'speed-locked' ? '<button class="vjs-playback-rate" aria-disabled="true">倍速</button>' : '';
        return route.fulfill({ contentType: 'text/html', body:
          `<!doctype html><meta charset="utf-8"><video controls preload="auto" width="760" height="225" src="/tone.wav${long ? '?long=1' : scenario === 'pause' ? '?pause=1' : ''}"></video>${lock}${reset}` });
      }
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: topHtml(url.searchParams.get('courseid')) });
    });
    const page = await context.newPage();
    const problems = [];
    page.on('pageerror', error => problems.push(error.message));
    const panel = () => page.locator('#cx-auto-next-panel');
    const status = () => panel().locator('#status');
    const clicks = () => page.evaluate(() => window.clicks);
    async function open(scenario) {
      await page.goto(courseUrl(scenario));
      await panel().locator('#toggle').waitFor();
      await page.waitForFunction(() => !document.querySelector('#cx-auto-next-panel')?.shadowRoot.querySelector('#toggle').disabled);
      await panel().locator('summary').click();
      await panel().locator('#auto-play').uncheck();
      if (scenario === 'pause') await panel().locator('#auto-speed').uncheck();
      await panel().locator('#save').click();
      await panel().locator('#toggle').click();
      await page.waitForTimeout(1800);
    }
    async function finish(index = 0) {
      const frame = page.frames().filter(frame => frame.url().includes('/ananas/'))[index];
      assert.ok(frame, 'fixture player loaded');
      await frame.locator('video').evaluate(video => video.play());
      await frame.waitForFunction(() => document.querySelector('video').ended);
    }
    async function immediateNext() {
      const started = Date.now();
      await page.waitForFunction(() => window.clicks === 1, null, { timeout: 3000 });
      assert.ok(Date.now() - started < 3000, 'a completed video advances without a countdown');
    }
    async function stays() {
      await page.waitForTimeout(2200);
      assert.equal(await clicks(), 0);
    }

    await open('normal');
    assert.match(await status().textContent(), /等待视频播放/);
    await finish();
    await immediateNext();
    await page.screenshot({ path: path.join(artifacts, 'extension-preview.png') });
    await page.waitForTimeout(2200);
    assert.equal(await clicks(), 1, 'one ended chapter must not click repeatedly');
    console.log('PASS real extension + cross-origin media completion + one-shot navigation');

    await open('idle');
    assert.equal(await panel().locator('#delay').count(), 0);
    assert.equal(await panel().locator('#cancel').count(), 0);
    await stays();
    console.log('PASS removed delay/cancel controls and unfinished media stays put');

    await open('pause');
    const pausedPlayer = page.frames().find(frame => frame.url().includes('/ananas/'));
    await pausedPlayer.locator('video').evaluate(video => video.play());
    await pausedPlayer.waitForFunction(() => document.querySelector('video').currentTime > 0.1);
    await panel().locator('#toggle').click();
    await pausedPlayer.waitForFunction(() => document.querySelector('video').ended);
    await stays();
    assert.equal(await panel().locator('.badge').textContent(), '已暂停');
    console.log('PASS pausing before completion prevents the immediate next click');

    await open('multi');
    await finish(0);
    await stays();
    assert.match(await status().textContent(), /1\/2/);
    await finish(1); await immediateNext();
    console.log('PASS all videos in multiple frames must finish');

    await open('task');
    await page.locator('#next').evaluate(element => element.setAttribute('aria-disabled', 'true'));
    await finish(); await stays();
    await page.locator('#next').evaluate(element => element.removeAttribute('aria-disabled'));
    await stays();
    assert.match(await status().textContent(), /未完成的任务点/);
    await page.locator('.ans-attach-ct').evaluate(element => element.classList.add('ans-job-finished'));
    await immediateNext();
    console.log('PASS locked button and pending task each prevent navigation');

    await open('last');
    await finish(); await stays();
    assert.match(await status().textContent(), /未找到可用/);
    console.log('PASS last chapter stays put');

    await page.goto(courseUrl('normal', 2));
    await panel().locator('#toggle').waitFor();
    await page.waitForFunction(() => document.querySelector('#cx-auto-next-panel').shadowRoot.querySelector('.badge').textContent === '已启用');
    const otherTab = await context.newPage();
    await otherTab.goto(courseUrl('normal'));
    await otherTab.waitForFunction(() => document.querySelector('#cx-auto-next-panel')?.shadowRoot.querySelector('.badge').textContent === '已暂停');
    console.log('PASS same-tab course continuation and new-tab isolation');

    await open('speed-normal');
    let player = page.frames().find(frame => frame.url().includes('/ananas/'));
    assert.equal(await player.locator('video').evaluate(video => video.playbackRate), 1, 'paused media stays untouched');
    await player.locator('video').evaluate(video => video.play());
    await player.waitForFunction(() => document.querySelector('video').playbackRate === 2);
    await page.waitForFunction(() => document.querySelector('#cx-auto-next-panel').shadowRoot.querySelector('#speed-status').textContent === '当前倍速：2×');
    await page.screenshot({ path: path.join(artifacts, 'extension-speed-preview.png') });
    await panel().locator('#speed').selectOption('1.5');
    await panel().locator('#save').click();
    await player.waitForFunction(() => document.querySelector('video').playbackRate === 1.5);
    // Closing the automatic setting must not overwrite a later manual choice.
    await panel().locator('#auto-speed').uncheck();
    await panel().locator('#save').click();
    await page.waitForTimeout(1700);
    await player.locator('video').evaluate(video => { video.pause(); video.playbackRate = 1.25; });
    await page.waitForTimeout(1700);
    assert.equal(await player.locator('video').evaluate(video => video.playbackRate), 1.25);
    console.log('PASS default 2x, selectable speed and automatic-speed switch in cross-origin player');

    await open('speed-reset');
    player = page.frames().find(frame => frame.url().includes('/ananas/'));
    await player.locator('video').evaluate(video => video.play());
    await page.waitForFunction(() => /倍速受限/.test(document.querySelector('#cx-auto-next-panel').shadowRoot.querySelector('#speed-status').textContent));
    await page.waitForTimeout(3500);
    assert.equal(await player.locator('video').evaluate(video => video.playbackRate), 1);
    assert.equal(await player.evaluate(() => window.rateEvents), 2, 'one speed attempt and one platform reset; no repeated writes');
    console.log('PASS platform reset is respected without repeated speed attempts');

    await open('speed-locked');
    player = page.frames().find(frame => frame.url().includes('/ananas/'));
    await player.locator('video').evaluate(video => video.play());
    await page.waitForTimeout(1900);
    assert.equal(await player.locator('video').evaluate(video => video.playbackRate), 1);
    assert.match(await panel().locator('#speed-status').textContent(), /倍速受限/);
    console.log('PASS disabled platform speed control is respected');
    assert.deepEqual(problems, []);
    fs.writeFileSync(path.join(artifacts, 'browser-test-result.txt'), `All 10 Edge end-to-end scenarios passed.\nExtension tested: ${extension}\n`, 'utf8');
  } finally {
    await context.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
