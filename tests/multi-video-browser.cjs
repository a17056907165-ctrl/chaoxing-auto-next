// End-to-end checks of the unpacked extension in an isolated Edge profile.
// Every course/player response is synthetic. No real course or account is used.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const extension = path.resolve(process.env.CX_EXTENSION_DIR || 'extension');
const artifacts = path.resolve('artifacts');
fs.mkdirSync(artifacts, { recursive: true });
const courseUrl = scenario => `https://mooc1.chaoxing.com/mycourse/studentstudy?courseid=multi-test-${scenario}&chapterId=1`;

function wav(seconds) {
  const samples = Math.round(8000 * seconds), bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40);
  return bytes;
}

function videoMarkup(id, scenario) {
  return `<div class="video-js" data-video-player><video id="${id}" controls preload="auto" width="660" height="150" src="/tone.wav?scenario=${scenario}&part=${id}"></video>
    <button class="vjs-big-play-button" aria-label="播放视频" onclick="this.parentElement.querySelector('video').play();this.hidden=true">播放</button>
    ${scenario === 'speed' ? '<div class="vjs-playback-rate"><span>倍速</span><ul><li class="vjs-menu-item">1.5×</li></ul></div>' : ''}</div>`;
}

const eventScript = `
  function attachVideoEvents() {
    for(const video of document.querySelectorAll('video')) {
      if(video.dataset.watched)continue;
      video.dataset.watched='yes';
      for(const event of ['play','pause','ended'])video.addEventListener(event,()=>{
        top.postMessage({fixture:'multi-video',event,videoId:video.id,time:Date.now()},'*');
      });
    }
  }
  attachVideoEvents();`;

function playerHtml(scenario, part) {
  const id = part === '2' ? 'second' : 'first';
  const lazy = scenario === 'lazy' && part === '2';
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>模拟视频播放器</title>
    <style>body{margin:0;font:14px system-ui}.video-js{position:relative;margin-bottom:12px}video{display:block;background:#eaf0f0}button{padding:8px 20px}</style>
    <body>${lazy ? '<div class="video-js" data-video-player><span role="progressbar">正在加载第二个视频…</span></div>' : videoMarkup(id, scenario)}
    <script>${eventScript}
      ${lazy ? `addEventListener('message',event=>{
        if(event.data?.type!=='fixture-load-lazy')return;
        document.body.innerHTML=${JSON.stringify(videoMarkup(id, scenario))};
        attachVideoEvents();
      });` : ''}
    </script></body></html>`;
}

function cardsHtml(scenario) {
  const same = ['same-frame', 'manual'].includes(scenario);
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>模拟课程内容</title>
    <style>body{margin:0;font:14px system-ui}iframe{display:block;width:700px;height:210px;border:0}video{background:#eaf0f0}</style>
    <body><div id="pageDiv">${same ? videoMarkup('first', scenario) + videoMarkup('second', scenario) :
      `<iframe id="player-first" src="https://mooc2.chaoxing.com/ananas/modules/video/index.html?scenario=${scenario}&part=1"></iframe>
       ${scenario === 'speed' ? '' : `<iframe id="player-second" src="https://mooc3.chaoxing.com/ananas/modules/video/index.html?scenario=${scenario}&part=2"></iframe>`}`}
    </div><script>${eventScript}
      addEventListener('message',event=>{
        if(event.data?.type==='fixture-load-lazy')document.querySelector('#player-second')?.contentWindow.postMessage(event.data,'*');
      });
    </script></body></html>`;
}

function courseHtml(scenario) {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>多视频播放测试</title>
    <style>body{font:16px system-ui;margin:30px;background:#f0f5f5}main{width:750px;padding:22px;background:white}iframe{width:710px;height:450px;border:0}button{padding:10px}</style>
    <body><main id="mainid"><h2 class="chapter-title">同一节里的多个视频</h2>
    <iframe id="cards" src="https://mooc1.chaoxing.com/mooc-ans/knowledge/cards?scenario=${scenario}&courseid=multi-test-${scenario}&knowledgeid=1"></iframe>
    <div id="prevNextFocus"><button id="next">下一节</button></div></main>
    <script>
      window.events=[];window.nextClicks=0;window.nextAt=0;window.earlyNext=false;window.maxPlaying=0;
      const playing=new Set();
      addEventListener('message',event=>{
        const data=event.data;if(data?.fixture!=='multi-video')return;
        window.events.push(data);
        if(data.event==='play')playing.add(data.videoId);else playing.delete(data.videoId);
        window.maxPlaying=Math.max(window.maxPlaying,playing.size);
        ${scenario === 'lazy' ? `if(data.event==='ended'&&data.videoId==='first')setTimeout(()=>{
          document.querySelector('#cards').contentWindow.postMessage({type:'fixture-load-lazy'},'*');
        },6500);` : ''}
      });
      document.querySelector('#next').addEventListener('click',()=>{
        window.nextClicks++;
        window.nextAt=Date.now();
        const ended=new Set(window.events.filter(event=>event.event==='ended').map(event=>event.videoId));
        if(!ended.has('first')||!ended.has('second'))window.earlyNext=true;
      });
    </script></body></html>`;
}

(async () => {
  const context = await chromium.launchPersistentContext(path.join(artifacts, `edge-multi-${Date.now()}`), {
    channel: 'msedge', headless: true, viewport: { width: 1280, height: 1000 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--autoplay-policy=no-user-gesture-required']
  });
  const errors = [];
  try {
    await context.route('**/*.chaoxing.com/**', async route => {
      const url = new URL(route.request().url());
      const scenario = url.searchParams.get('scenario') || (url.searchParams.get('courseid') || '').replace('multi-test-', '');
      if (url.pathname.endsWith('/tone.wav')) return route.fulfill({ contentType: 'audio/wav', body: wav(scenario === 'manual' ? 25 : scenario === 'speed' ? 15 : 2.4) });
      if (url.pathname.includes('/ananas/modules/video/')) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: playerHtml(scenario, url.searchParams.get('part')) });
      if (url.pathname.includes('/knowledge/cards')) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: cardsHtml(scenario) });
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
        await panel.locator('#auto-speed').setChecked(scenario === 'speed');
        await panel.locator('#speed').selectOption('2');
        await panel.locator('#save').click();
        await panel.locator('#toggle').click();
        await verify(page);
        console.log(`PASS ${scenario}`);
      } catch (error) {
        console.error(`${scenario}:`, await page.evaluate(() => ({ events: window.events, nextClicks: window.nextClicks, maxPlaying: window.maxPlaying })).catch(() => 'unavailable'));
        console.error('Status:', await page.locator('#cx-auto-next-panel').locator('#status').textContent().catch(() => 'unavailable'));
        await page.screenshot({ path: path.join(artifacts, `multi-failure-${scenario}.png`) }).catch(() => {});
        throw error;
      } finally { await page.close(); }
    }
    async function allFinishedThenNext(page) {
      await page.waitForFunction(() => window.nextClicks === 1, null, { timeout: 35000 });
      const result = await page.evaluate(() => ({ events: window.events, maxPlaying: window.maxPlaying, earlyNext: window.earlyNext, nextAt: window.nextAt }));
      assert.equal(result.earlyNext, false, 'next section must wait for both real ended events');
      assert.equal(result.maxPlaying, 1, 'only one video is automatically played at a time');
      const firstEnd = result.events.findIndex(event => event.videoId === 'first' && event.event === 'ended');
      const secondPlay = result.events.findIndex(event => event.videoId === 'second' && event.event === 'play');
      assert.ok(firstEnd >= 0 && secondPlay > firstEnd, 'second starts only after first ended');
      const lastEnd = Math.max(...result.events.filter(event => event.event === 'ended').map(event => event.time));
      assert.ok(result.nextAt - lastEnd < 3000, 'the final ended event advances without a fixed countdown');
      await page.waitForTimeout(1700);
      assert.equal(await page.evaluate(() => window.nextClicks), 1, 'one finished chapter clicks next only once');
    }
    const results = await Promise.allSettled([
      run('same-frame', allFinishedThenNext),
      run('cross-frame', allFinishedThenNext),
      run('lazy', async page => {
        await page.waitForFunction(() => window.events.some(event => event.event === 'ended' && event.videoId === 'first'), null, { timeout: 10000 });
        await page.waitForTimeout(5600);
        assert.equal(await page.evaluate(() => window.nextClicks), 0, 'unloaded second player prevents premature navigation');
        await allFinishedThenNext(page);
      }),
      run('speed', async page => {
        const player = page.frames().find(frame => frame.url().includes('/ananas/modules/video/'));
        assert.ok(player);
        await player.waitForFunction(() => document.querySelector('video').playbackRate === 2, null, { timeout: 10000 });
        assert.equal(await player.locator('video').evaluate(video => video.paused), false);
        await page.waitForTimeout(1700);
        assert.equal(await player.locator('video').evaluate(video => video.playbackRate), 2, 'partial 1.5x menu does not lower accepted 2x');
      }),
      run('manual', async page => {
        const cards = page.frames().find(frame => frame.url().includes('/knowledge/cards'));
        assert.ok(cards);
        await cards.waitForFunction(() => !document.querySelector('#first').paused, null, { timeout: 10000 });
        await page.waitForTimeout(500);
        await cards.locator('#first').evaluate(video => video.pause());
        await page.waitForTimeout(4500);
        assert.equal(await cards.locator('#first').evaluate(video => video.paused), true);
        assert.equal(await cards.locator('#second').evaluate(video => video.paused), true);
        assert.equal(await page.evaluate(() => window.nextClicks), 0);
      })
    ]);
    const failures = results.filter(result => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Multi-video browser checks failed');
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(artifacts, 'multi-video-browser-result.txt'),
      `All 5 multi-video/speed Edge scenarios passed.\nExtension tested: ${extension}\n`, 'utf8');
  } finally { await context.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
