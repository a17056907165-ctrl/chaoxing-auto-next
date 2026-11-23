// Runs the unpacked extension in a separate Edge profile using only fixtures.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const extension = path.resolve(process.env.CX_EXTENSION_DIR || 'extension');
const artifacts = path.resolve('artifacts');
const courseOrigin = 'https://mooc1.chaoxing.com';
const viewerOrigin = 'https://mooc2.chaoxing.com';
const cloudPreviewOrigin = 'https://pan-yz.chaoxing.com';
const cloudPreviewUrl = `${cloudPreviewOrigin}/screen/v2/nested-presentation`;
const videoOrigin = 'https://mooc3.chaoxing.com';
const videoUrl = `${videoOrigin}/ananas/modules/video/index.html?jobid=mixed-video`;
const cardsUrl = `${courseOrigin}/mooc-ans/knowledge/cards?courseid=documents-video-and-preview&knowledgeid=1`;
const courseUrl = scenario => `${courseOrigin}/mycourse/studentstudy?courseid=documents-${scenario}&chapterId=1`;
const viewerUrl = (format, id) =>
  `${viewerOrigin}/ananas/modules/${id === 'nested-slides' ? 'zt/' : ''}${format}/index.html?jobid=${id}`;

function attachment(format, id, status = 'pending') {
  const viewer = `<iframe title="${id}" src="${viewerUrl(format, id)}"></iframe>`;
  if (status === 'optional') return `<div class="ans-attach-ct">${viewer}</div>`;
  const complete = status === 'complete';
  return `<div class="ans-attach-ct${complete ? ' ans-job-finished' : ''}" data-jobid="${id}">
    <span class="ans-job-icon" title="任务点${complete ? '已完成' : '未完成'}"></span>${viewer}</div>`;
}

function courseHtml(scenario) {
  const content = {
    pdf: attachment('pdf', 'reader'),
    mixed: attachment('pdf', 'reader') + attachment('ppt', 'slides'),
    nested: attachment('ppt', 'nested-slides'),
    'video-and-preview': `<iframe id="cards" title="章节内容" src="${cardsUrl}"></iframe>`,
    'document-scroll': attachment('pdf', 'window-reader'),
    'no-required': attachment('pdf', 'finished', 'complete') + attachment('ppt', 'optional', 'optional'),
    paused: attachment('pdf', 'reader')
  }[scenario];
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>课件任务点测试</title>
    <style>body{font:16px system-ui;margin:24px}main{width:800px}iframe{display:block;width:700px;height:280px;border:0;margin:18px 0}</style>
    <main id="mainid"><section id="pageDiv">${content}</section><button id="next">下一节</button></main>
    <script>${attachmentProgress()}
      window.nextClicks = 0;
      document.querySelector('#next').onclick = () => window.nextClicks++;
    </script></html>`;
}

function attachmentProgress() {
  return `window.reached = [];
    addEventListener('message', event => {
      const id = event.data?.documentFixture;
      const viewer = [...document.querySelectorAll('iframe')].find(frame => frame.title === id);
      if (event.origin === ${JSON.stringify(viewerOrigin)} && viewer?.contentWindow === event.source) {
        window.reached.push(id);
      }
    });
    window.markComplete = id => {
      const owner = [...document.querySelectorAll('[data-jobid]')].find(task => task.dataset.jobid === id);
      if (!owner || !window.reached.includes(id)) throw new Error('Viewer has not reached the end');
      owner.classList.add('ans-job-finished');
      owner.querySelector('.ans-job-icon').title = '任务点已完成';
    };`;
}

function mixedCards() {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>含文稿与视频的章节</title>
    <style>body{margin:0}iframe{display:block;width:680px;height:270px;border:0}#video-task{margin-top:760px}</style>
    <section id="pageDiv">
      ${attachment('ppt', 'nested-slides')}
      <div id="video-task" class="ans-attach-ct" data-jobid="mixed-video">
        <span class="ans-job-icon" title="视频任务点未完成"></span>
        <iframe id="video-frame" title="章节视频" src="${videoUrl}"></iframe>
      </div>
    </section>
    <script>${attachmentProgress()}
      window.videoEnded = false;
      addEventListener('message', event => {
        if (event.origin === ${JSON.stringify(videoOrigin)} &&
            event.source === document.querySelector('#video-frame').contentWindow &&
            event.data?.mixedVideoEnded === true) {
          window.videoEnded = true;
        }
      });
      window.markVideoComplete = () => {
        if (!window.videoEnded) throw new Error('Video has not finished');
        const owner = document.querySelector('#video-task');
        owner.classList.add('ans-job-finished');
        owner.querySelector('.ans-job-icon').title = '视频任务点已完成';
      };
    </script></html>`;
}

function videoHtml() {
  const video = `<video controls width="620" height="180" preload="auto" src="/mixed-tone.wav"></video>
    <button class="vjs-big-play-button" type="button" aria-label="播放视频">播放</button>`;
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>正在加载章节视频</title>
    <div class="video-js" aria-busy="true">视频加载中</div>
    <script>
      window.playCount = 0;
      window.loadVideo = () => {
        const player = document.querySelector('.video-js');
        player.innerHTML = ${JSON.stringify(video)};
        player.removeAttribute('aria-busy');
        const video = player.querySelector('video');
        video.addEventListener('playing', () => window.playCount++);
        video.addEventListener('ended', () => {
          parent.postMessage({ mixedVideoEnded: true }, ${JSON.stringify(courseOrigin)});
        });
        player.querySelector('button').onclick = function () { video.play(); this.hidden = true; };
      };
    </script></html>`;
}

function mixedVideoMedia() {
  const samples = 8000 * 5;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
  return wav;
}

function viewerHtml(format, id, reportOrigin = courseOrigin) {
  const documentScroll = id === 'window-reader' || id === 'nested-slides';
  const presentation = format === 'ppt';
  const previewId = presentation ? 'presentationPreview' : 'viewerContainer';
  const pageMarkup = `<article><h2>${presentation ? 'PPT 幻灯片' : '课程文稿'}</h2></article>`;
  const pages = pageMarkup.repeat(2);
  const footer = `<footer class="preview-toolbar">
    <button id="zoom-out" type="button" aria-label="缩小">−</button>
    <button id="zoom-in" type="button" aria-label="放大">+</button>
    <button id="nextPage" type="button">下一页</button>
    <button id="assistant" type="button">AI 助教</button>
  </footer>`;
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>文稿课件</title>
    <style>
      body{margin:0;font:14px system-ui}
      .preview-shell{height:100vh;display:flex;flex-direction:column;background:#e9edf2}
      .preview-row{min-height:0;display:flex;flex:1}
      .preview-scroll{flex:1;overflow-y:auto;overflow-anchor:none}
      .preview-sidebar{width:58px;height:85px;overflow-y:auto}
      .preview-sidebar div{height:230px}
      article{box-sizing:border-box;height:300px;margin:12px 25px;padding:15px;background:white}
      .preview-toolbar{display:flex;gap:8px;padding:6px 12px;background:#eff1f4}
      .fixed-toolbar{position:fixed;bottom:0;left:0;right:0}
    </style>
    ${documentScroll ? `<section>${pages}</section><div class="fixed-toolbar">${footer}</div>` : `
      <section class="preview-shell">
        <section class="preview-row">
          ${presentation ? '<div class="preview-sidebar"><div>缩略图</div></div>' : ''}
          <div class="preview-scroll" id="${previewId}">${pages}</div>
        </section>
        ${footer}
      </section>`}
    <script>
      window.toolbarClicks = [];
      document.querySelector('.preview-toolbar').addEventListener('click', e => window.toolbarClicks.push(e.target.id));
      const scroller = ${documentScroll ? 'document.scrollingElement' : `document.getElementById(${JSON.stringify(previewId)})`};
      let reported = false;
      let loadingMore = false;
      let loadedMore = ${!presentation || documentScroll};
      ${documentScroll ? 'document' : 'scroller'}.addEventListener('scroll', () => {
        if (scroller.scrollTop <= 0 || scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop > 2) return;
        if (!loadedMore) {
          if (!loadingMore) {
            loadingMore = true;
            setTimeout(() => {
              scroller.insertAdjacentHTML('beforeend', ${JSON.stringify(pageMarkup)});
              loadedMore = true;
            }, 450);
          }
          return;
        }
        if (!reported) {
          reported = true;
          parent.postMessage({documentFixture: ${JSON.stringify(id)}}, ${JSON.stringify(reportOrigin)});
        }
      });
    </script></html>`;
}

function previewWrapper() {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>课件预览容器</title>
    <style>
      body{margin:0;font:14px system-ui}
      #img{height:calc(100vh - 38px);overflow:hidden}
      iframe{width:100%;height:calc(100% + 6px);border:0;display:block}
      footer{height:38px}
    </style>
    <div id="img"><iframe title="课件预览" id="panView" src="${cloudPreviewUrl}"></iframe></div>
    <footer><button id="nextPage">下一页</button><button id="assistant">AI 助教</button></footer>
    <script>
      window.toolbarClicks = [];
      document.querySelector('footer').addEventListener('click', e => window.toolbarClicks.push(e.target.id));
      addEventListener('message', event => {
        if (event.origin === ${JSON.stringify(cloudPreviewOrigin)} &&
            event.source === document.querySelector('#panView').contentWindow &&
            event.data?.documentFixture === 'nested-slides') {
          parent.postMessage(event.data, ${JSON.stringify(courseOrigin)});
        }
      });
    </script></html>`;
}

(async () => {
  fs.mkdirSync(artifacts, { recursive: true });
  const context = await chromium.launchPersistentContext(path.join(artifacts, `edge-documents-${Date.now()}`), {
    channel: 'msedge', headless: true, viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--autoplay-policy=no-user-gesture-required']
  });
  try {
    await context.route('**/*.chaoxing.com/**', async route => {
      const url = new URL(route.request().url());
      if (url.href === `${videoOrigin}/mixed-tone.wav`) {
        await route.fulfill({ contentType: 'audio/wav', body: mixedVideoMedia() });
        return;
      }
      const match = url.pathname.match(/\/ananas\/modules\/(?:zt\/)?(pdf|ppt)\//);
      const course = url.searchParams.get('courseid');
      const job = url.searchParams.get('jobid');
      let body;
      if (url.href === cloudPreviewUrl) body = viewerHtml('ppt', 'nested-slides', viewerOrigin);
      else if (url.href === cardsUrl) body = mixedCards();
      else if (url.href === videoUrl) body = videoHtml();
      else if (match && url.origin === viewerOrigin) body = job === 'nested-slides' ? previewWrapper() : viewerHtml(match[1], job);
      else if (url.origin === courseOrigin && course?.startsWith('documents-')) body = courseHtml(course.slice('documents-'.length));
      if (body) await route.fulfill({ contentType: 'text/html; charset=utf-8', body });
      else await route.abort();
    });
    async function run(scenario, verify, enabled = true) {
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      try {
        await page.goto(courseUrl(scenario));
        await page.waitForFunction(() =>
          document.querySelector('#cx-auto-next-panel')?.shadowRoot.querySelector('#toggle').disabled === false);
        if (enabled) await page.locator('#cx-auto-next-panel').locator('#toggle').click();
        await verify(page);
        const previews = page.frames().filter(frame => [viewerOrigin, cloudPreviewOrigin].includes(new URL(frame.url()).origin));
        for (const viewer of previews) {
          assert.deepEqual(await viewer.evaluate(() => window.toolbarClicks), [], 'preview toolbar stays untouched');
        }
        assert.deepEqual(errors, []);
        console.log(`PASS ${scenario}`);
      } catch (error) {
        const status = await page.locator('#cx-auto-next-panel').locator('#status').textContent().catch(() => '');
        console.error(`${scenario} status:`, status);
        const player = page.frames().find(frame => frame.url() === videoUrl);
        if (player) console.error('fixture player:', await player.evaluate(() => {
          const video = document.querySelector('video');
          return { playCount: window.playCount, exists: Boolean(video), paused: video?.paused,
            ended: video?.ended, position: video?.currentTime, duration: video?.duration, error: video?.error?.message };
        }).catch(() => null));
        throw error;
      } finally {
        await page.close();
      }
    }
    async function noNext(page, ms = 1900) {
      await page.waitForTimeout(ms);
      assert.equal(await page.evaluate(() => window.nextClicks), 0);
    }
    async function completedOnce(page) {
      await page.waitForFunction(() => window.nextClicks === 1, null, { timeout: 4500 });
      await page.waitForTimeout(1700);
      assert.equal(await page.evaluate(() => window.nextClicks), 1);
    }
    async function reach(page, id) {
      await page.waitForFunction(id => window.reached.includes(id), id, { timeout: 12000 });
    }
    async function finish(page, id) {
      await page.evaluate(id => window.markComplete(id), id);
    }
    const scrollTop = locator => locator.evaluate(element => element.scrollTop);

    const results = await Promise.allSettled([
      run('pdf', async page => {
        await reach(page, 'reader');
        await noNext(page);
        await finish(page, 'reader');
        await completedOnce(page);
      }),
      run('mixed', async page => {
        await page.waitForFunction(() => window.reached.length > 0, null, { timeout: 12000 });
        const first = await page.evaluate(() => window.reached[0]);
        const second = first === 'reader' ? 'slides' : 'reader';
        await finish(page, first);
        await reach(page, second);
        await noNext(page);
        const slides = page.frameLocator('iframe[title="slides"]');
        assert.equal(await slides.locator('#presentationPreview article').count(), 3, 'lazy final slide was appended');
        assert.ok(await scrollTop(slides.locator('#presentationPreview')) > 500, 'preview reached the new bottom');
        assert.equal(await scrollTop(slides.locator('.preview-sidebar')), 0, 'sidebar did not scroll');
        await finish(page, second);
        await completedOnce(page);
      }),
      run('document-scroll', async page => {
        await reach(page, 'window-reader');
        await finish(page, 'window-reader');
        await completedOnce(page);
      }),
      run('nested', async page => {
        await reach(page, 'nested-slides');
        await noNext(page);
        const wrapper = page.frameLocator('iframe[title="nested-slides"]');
        assert.equal(await scrollTop(wrapper.locator('#img')), 0, 'the hidden overflow in the wrapper stays untouched');
        assert.ok(await scrollTop(wrapper.frameLocator('#panView').locator('html')) > 0, 'nested reader was scrolled');
        await finish(page, 'nested-slides');
        await completedOnce(page);
      }),
      run('video-and-preview', async page => {
        const cards = page.frames().find(frame => frame.url() === cardsUrl);
        const player = page.frames().find(frame => frame.url() === videoUrl);
        assert.ok(cards && player, 'chapter cards and delayed video iframe loaded');
        assert.ok(await cards.locator('#video-task').evaluate(task =>
          task.getBoundingClientRect().top > innerHeight), 'video starts below the chapter viewport');
        await page.locator('#cx-auto-next-panel').locator('#toggle').click();
        await noNext(page);
        await cards.waitForFunction(() => {
          const frame = document.querySelector('#video-task iframe').getBoundingClientRect();
          return frame.bottom > 0 && frame.top < innerHeight;
        }, null, { timeout: 8000 });
        await player.evaluate(() => window.loadVideo());
        await player.waitForFunction(() => window.playCount > 0, null, { timeout: 12000 });
        assert.equal(await page.evaluate(() => window.nextClicks), 0, 'chapter stays while the video starts');
        await player.waitForFunction(() => document.querySelector('video').ended, null, { timeout: 12000 });
        await cards.waitForFunction(() => window.videoEnded);
        await noNext(page);
        assert.deepEqual(await cards.evaluate(() => window.reached), [],
          'the embedded presentation should wait for the platform video badge');
        const preview = page.frameLocator('#cards').frameLocator('iframe[title="nested-slides"]').frameLocator('#panView');
        assert.equal(await scrollTop(preview.locator('html')), 0, 'the presentation should not begin scrolling yet');
        await cards.evaluate(() => window.markVideoComplete());
        await reach(cards, 'nested-slides');
        await noNext(page);
        await finish(cards, 'nested-slides');
        await completedOnce(page);
      }, false),
      run('no-required', async page => {
        await completedOnce(page);
        assert.deepEqual(await page.evaluate(() => window.reached), []);
        assert.equal(await scrollTop(page.frameLocator('iframe[title="finished"]').locator('#viewerContainer')), 0);
        assert.equal(await scrollTop(page.frameLocator('iframe[title="optional"]').locator('#presentationPreview')), 0);
      }),
      run('paused', async page => {
        await noNext(page);
        assert.deepEqual(await page.evaluate(() => window.reached), []);
        assert.equal(await scrollTop(page.frameLocator('iframe').locator('#viewerContainer')), 0);
      }, false)
    ]);
    const failures = results.filter(result => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Document scenarios failed');
    console.log('All 7 document-task browser scenarios passed.');
  } finally {
    await context.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
