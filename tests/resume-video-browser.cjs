// Regression checks with real media in an isolated Edge profile.
// Playwright supplies every course response. No real course or account is used.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const extension = path.resolve(process.env.CX_EXTENSION_DIR || 'extension');
const artifacts = path.resolve('artifacts');
fs.mkdirSync(artifacts, { recursive: true });

function courseUrl(scenario, chapter = 1) {
  return `https://mooc1.chaoxing.com/mycourse/studentstudy?courseid=resume-test-${scenario}&chapterId=${chapter}`;
}

function wav(seconds) {
  const samples = Math.round(8000 * seconds);
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40);
  return bytes;
}

function courseHtml(scenario, chapter) {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>续看测试</title>
    <style>body{font:16px system-ui}iframe{display:block;width:710px;height:1420px;border:0}</style>
    <body><main id="mainid"><h2 class="chapter-title">同一节里的三个视频</h2>
      <iframe id="cards" src="/mooc-ans/knowledge/cards?scenario=${scenario}&knowledgeid=${chapter}"></iframe>
      <div id="prevNextFocus"><button id="next">下一节</button></div>
    </main><script>
      window.fixtureEvents = [];
      addEventListener('message', event => {
        if (event.data?.fixture === 'resume-video') window.fixtureEvents.push(event.data);
      });
      document.querySelector('#next').addEventListener('click', () => window.fixtureEvents.push({ event: 'next', at: Date.now() }));
    </script></body></html>`;
}

function cardsHtml(scenario) {
  const players = [1, 2, 3].map(part => {
    const completed = scenario === 'platform' && part === 1;
    return `<div class="ans-attach-ct${completed ? ' ans-job-finished' : ''}">
      ${completed ? '<span class="ans-job-icon" title="任务点已完成"></span>' : ''}
      <iframe id="player-${part}" src="https://mooc2.chaoxing.com/ananas/modules/video/index.html?scenario=${scenario}&part=${part}"></iframe>
    </div>`;
  });
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>课程内容</title>
    <style>body{margin:0}iframe{display:block;width:680px;height:200px;border:0}
      .ans-attach-ct{margin-bottom:380px}</style>
    <body><div id="pageDiv">${players.join('')}</div></body></html>`;
}

function videoHtml(scenario, part) {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>模拟播放器</title>
    <body><div class="video-js" data-video-player>
      <video controls preload="auto" width="660" height="150" src="/tone.wav?scenario=${scenario}&part=${part}"></video>
      <button class="vjs-big-play-button" aria-label="播放视频" onclick="this.previousElementSibling.play();this.hidden=true">播放</button>
    </div><script>
      const video = document.querySelector('video');
      for (const event of ['play', 'pause', 'ended']) {
        video.addEventListener(event, () => top.postMessage({ fixture: 'resume-video', event, part: ${part}, at: Date.now() }, '*'));
      }
    </script></body></html>`;
}

async function configure(page, scenario) {
  await page.goto(courseUrl(scenario));
  const panel = page.locator('#cx-auto-next-panel');
  await page.waitForFunction(() => {
    const root = document.querySelector('#cx-auto-next-panel')?.shadowRoot;
    return root && !root.querySelector('#toggle').disabled;
  });
  await panel.locator('summary').click();
  await panel.locator('#auto-speed').setChecked(false);
  await panel.locator('#save').click();
  await panel.locator('#toggle').click();
}

function waitForEvent(page, event, part) {
  return page.waitForFunction(({ event, part }) => window.fixtureEvents.some(item =>
    item.event === event && (part === undefined || item.part === part)), { event, part }, { timeout: 15000 });
}

async function checkAdvance(page, remaining) {
  await waitForEvent(page, 'next');
  await page.waitForTimeout(1600);
  const events = await page.evaluate(() => window.fixtureEvents);
  const next = events.findIndex(item => item.event === 'next');
  assert.equal(events.filter(item => item.event === 'next').length, 1, 'one next click per chapter visit');
  assert.deepEqual(events.filter(item => item.event === 'play').map(item => item.part), remaining, 'only remaining videos play in order');
  assert.deepEqual(events.slice(0, next).filter(item => item.event === 'ended').map(item => item.part), remaining,
    'the next click waits for all remaining videos to end');
  if (remaining.length) {
    const lastEnd = Math.max(...events.slice(0, next).filter(item => item.event === 'ended').map(item => item.at));
    assert.ok(events[next].at - lastEnd < 3000, 'remaining videos advance immediately after the final completion');
  }
}

(async () => {
  const context = await chromium.launchPersistentContext(path.join(artifacts, `edge-resume-${Date.now()}`), {
    channel: 'msedge', headless: true, viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--autoplay-policy=no-user-gesture-required']
  });
  const errors = [];
  try {
    await context.route('**/*.chaoxing.com/**', async route => {
      const url = new URL(route.request().url());
      const scenario = url.searchParams.get('scenario') || url.searchParams.get('courseid')?.replace('resume-test-', '');
      const part = Number(url.searchParams.get('part'));
      if (url.pathname.endsWith('/tone.wav')) {
        return route.fulfill({ contentType: 'audio/wav', body: wav(part === 2 ? 3.2 : 1.7) });
      }
      let body;
      if (url.pathname.includes('/ananas/modules/video/')) body = videoHtml(scenario, part);
      else if (url.pathname.includes('/knowledge/cards')) body = cardsHtml(scenario);
      else body = courseHtml(scenario, Number(url.searchParams.get('chapterId')));
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body });
    });

    async function run(scenario, verify) {
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      try {
        await configure(page, scenario);
        await verify(page);
        console.log(`PASS ${scenario}`);
      } catch (error) {
        console.error(scenario, await page.evaluate(() => window.fixtureEvents).catch(() => []));
        console.error('Status:', await page.locator('#cx-auto-next-panel').locator('#status').textContent({ timeout: 2000 }).catch(() => 'unavailable'));
        throw error;
      } finally {
        await page.close();
      }
    }

    const results = await Promise.allSettled([
      run('reload', async page => {
        await waitForEvent(page, 'ended', 1);
        const second = page.frames().find(frame => new URL(frame.url()).searchParams.get('part') === '2');
        assert.ok(second);
        await second.waitForFunction(() => document.querySelector('video').currentTime > 0.2, null, { timeout: 8000 });
        await second.locator('video').evaluate(video => video.pause());
        assert.equal(await second.locator('video').evaluate(video => video.ended), false);
        await page.reload();
        await checkAdvance(page, [2, 3]);
        await page.reload();
        await checkAdvance(page, []);
        await page.goto(courseUrl('reload', 2));
        await waitForEvent(page, 'play', 1);
        assert.equal(await page.evaluate(() => window.fixtureEvents.some(item => item.event === 'next')), false,
          'completion saved in a different chapter cannot skip this chapter');
      }),
      run('platform', async page => {
        const third = await page.frameLocator('#cards').locator('#player-3').boundingBox();
        assert.ok(third.y > page.viewportSize().height, 'third player is below the initial viewport');
        await checkAdvance(page, [2, 3]);
      })
    ]);
    const failures = results.filter(result => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Resume video checks failed');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
