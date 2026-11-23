// Direct module regressions in isolated Edge pages. All markup and feedback are
// fixtures; this script never visits a course URL or uses a real account.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

const modulePath = path.join(path.resolve(process.env.CX_EXTENSION_DIR || 'extension'), 'quiz.js');

function quizHtml({ count = 3, type = 'radio', includeSubmit = true,
  disabledSubmit = false, disabledInputs = false, hiddenInputs = false, continueShown = false } = {}) {
  const options = Array.from({ length: count }, (_, index) => `<li class="ans-videoquiz-opt">
    <label><input id="choice-${index}" type="${type}" name="popup-options" value="${String.fromCharCode(97 + index)}"
      ${disabledInputs ? 'disabled' : ''} ${hiddenInputs ? 'style="display:none"' : ''}>
      选项 ${String.fromCharCode(65 + index)}</label></li>`).join('');
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>视频弹题状态测试</title>
    <style>body{font:16px system-ui}.ans-videoquiz{display:block;width:600px;padding:20px}.ans-videoquiz-opt{padding:7px}label{display:block}button{padding:8px}</style>
    <video></video>
    <section class="ans-videoquiz" data-question-id="test-question-1">
      <div class="tkTopic"><h3 class="tkItem_title">请为这个模拟问题选择答案</h3><ul>${options}</ul></div>
      <span id="spanNot" hidden>回答错误</span><span id="spanYes" hidden>回答正确</span>
      <span id="videoquiz-submitting" hidden>正在提交</span>
      ${includeSubmit ? `<button id="videoquiz-submit" ${disabledSubmit ? 'disabled' : ''}>提交</button>` : ''}
      <button id="videoquiz-continue" ${continueShown ? '' : 'hidden'}>继续播放</button>
    </section>
    <script>
      window.testTime = 100000;
      Date.now = () => window.testTime;
      window.submissions = [];
      window.continueClicks = 0;
      document.addEventListener('click', event => {
        if (event.target.id === 'videoquiz-submit') {
          window.submissions.push([...document.querySelectorAll('.ans-videoquiz-opt input:checked')].map(input => input.value));
        }
        if (event.target.id === 'videoquiz-continue') window.continueClicks++;
      });
    </script></html>`;
}

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  let passed = 0;
  try {
    async function scenario(name, options, run) {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      try {
        await page.setContent(quizHtml(options));
        await page.addScriptTag({ path: modulePath });
        const step = (advance = 0) => page.evaluate(milliseconds => {
          window.testTime += milliseconds;
          return CxVideoQuiz.step(document, { enabled: true, revision: 'test' });
        }, advance);
        const submissions = () => page.evaluate(() => window.submissions);
        await run({ page, step, submissions });
        assert.deepEqual(errors, []);
        passed++;
        console.log(`PASS ${name}`);
      } finally { await page.close(); }
    }

    await scenario('late-rendered submit recovers without resetting the question', { includeSubmit: false }, async ({ page, step, submissions }) => {
      const waiting = await step();
      assert.equal(waiting.attempts, 0);
      assert.match(waiting.status, /等待/);
      await page.evaluate(() => {
        const button = document.createElement('button');
        button.id = 'videoquiz-submit'; button.textContent = '提交';
        document.querySelector('.ans-videoquiz').append(button);
      });
      const result = await step(2000);
      assert.equal(result.attempts, 1);
      assert.deepEqual(await submissions(), [['a']]);
    });

    await scenario('temporarily disabled submit becomes usable', { disabledSubmit: true }, async ({ page, step, submissions }) => {
      assert.equal((await step()).attempts, 0);
      await page.evaluate(() => { document.querySelector('#videoquiz-submit').disabled = false; });
      assert.equal((await step(2000)).attempts, 1);
      assert.deepEqual(await submissions(), [['a']]);
    });

    await scenario('temporarily disabled options become usable', { disabledInputs: true }, async ({ page, step, submissions }) => {
      assert.equal((await step()).attempts, 0);
      await page.evaluate(() => { document.querySelectorAll('.ans-videoquiz-opt input').forEach(input => { input.disabled = false; }); });
      assert.equal((await step(2000)).attempts, 1);
      assert.deepEqual(await submissions(), [['a']]);
    });

    await scenario('stale wrong feedback while submitting never advances another choice', {}, async ({ page, step, submissions }) => {
      await step();
      await page.evaluate(() => { document.querySelector('#spanNot').hidden = false; });
      assert.equal((await step(2000)).attempts, 2);
      await page.evaluate(() => { document.querySelector('#videoquiz-submitting').hidden = false; });
      for (let index = 0; index < 3; index++) {
        const waiting = await step(2000);
        assert.equal(waiting.attempts, 2);
        assert.match(waiting.status, /正在提交/);
      }
      assert.deepEqual(await submissions(), [['a'], ['b']]);
      await page.evaluate(() => {
        document.querySelector('#videoquiz-submitting').hidden = true;
        document.querySelector('#spanNot').hidden = true;
        document.querySelector('#spanYes').hidden = false;
        document.querySelector('#videoquiz-continue').hidden = false;
      });
      await step(2000);
      assert.equal(await page.evaluate(() => window.continueClicks), 1);
      assert.deepEqual(await submissions(), [['a'], ['b']]);
    });

    await scenario('feedback text inserted inside an option does not reset tried choices', {}, async ({ page, step, submissions }) => {
      await step();
      const before = await page.evaluate(() => CxVideoQuiz.inspect(document).key);
      await page.evaluate(() => {
        const feedback = document.createElement('span');
        feedback.className = 'answer-wrong'; feedback.textContent = '回答错误，请重新选择';
        document.querySelector('.ans-videoquiz-opt').append(feedback);
      });
      assert.equal(await page.evaluate(() => CxVideoQuiz.inspect(document).key), before);
      assert.equal((await step(2000)).attempts, 2);
      assert.deepEqual(await submissions(), [['a'], ['b']]);
    });

    await scenario('visible continue waits for positive feedback and is clicked once', { continueShown: true }, async ({ page, step, submissions }) => {
      await step();
      await step(2000);
      assert.equal(await page.evaluate(() => window.continueClicks), 0);
      assert.deepEqual(await submissions(), [['a']]);
      await page.evaluate(() => { document.querySelector('#spanYes').hidden = false; });
      await step(); await step(2000);
      assert.equal(await page.evaluate(() => window.continueClicks), 1);
      await page.evaluate(() => { document.querySelector('.ans-videoquiz').hidden = true; });
      const solved = await step();
      assert.equal(solved.active, false);
      assert.equal(solved.solved, true);
    });

    await scenario('checkbox exhaustion is bounded and never repeats submitted combinations', { count: 2, type: 'checkbox' }, async ({ page, step, submissions }) => {
      await step();
      for (let index = 1; index <= 3; index++) {
        await page.evaluate(version => {
          const feedback = document.querySelector('#spanNot');
          feedback.hidden = false; feedback.textContent = `回答错误 ${version}`;
        }, index);
        const result = await step(2000);
        if (index === 3) assert.match(result.status, /已尝试全部选项组合/);
      }
      for (let index = 0; index < 3; index++) {
        assert.equal((await step(2000)).attempts, 3);
      }
      assert.deepEqual(await submissions(), [['a'], ['b'], ['a', 'b']]);
    });

    await scenario('hidden radio inputs inside visible labels can be selected', { count: 2, hiddenInputs: true }, async ({ page, step, submissions }) => {
      assert.equal(await page.locator('#choice-0').isVisible(), false);
      assert.equal(await page.locator('.ans-videoquiz-opt label').first().isVisible(), true);
      assert.equal((await step()).attempts, 1);
      await page.evaluate(() => { document.querySelector('#spanNot').hidden = false; });
      assert.equal((await step(2000)).attempts, 2);
      assert.deepEqual(await submissions(), [['a'], ['b']]);
    });

    await scenario('ordinary chapter-test controls are never answered or submitted', {}, async ({ page, step, submissions }) => {
      await page.evaluate(() => {
        const root = document.querySelector('.ans-videoquiz');
        root.className = 'chapter-test'; root.removeAttribute('data-question-id');
        document.querySelector('video').remove();
      });
      assert.equal((await step()).active, false);
      assert.equal((await step(2000)).active, false);
      assert.deepEqual(await submissions(), []);
      assert.equal(await page.locator('input:checked').count(), 0);
    });
    await scenario('correct feedback followed by immediate popup closure emits one resume pulse', {}, async ({ page, step }) => {
      await step();
      await page.evaluate(() => {
        document.querySelector('#spanYes').hidden = false;
        document.querySelector('.ans-videoquiz').hidden = true;
      });
      const closed = await step(2000);
      assert.equal(closed.active, false);
      assert.equal(closed.solved, true);
      assert.equal((await step()).solved, false);
      assert.equal(await page.evaluate(() => window.continueClicks), 0);
    });
    await scenario('manual popup dismissal without correct feedback never grants resume', {}, async ({ page, step }) => {
      await step();
      await page.evaluate(() => { document.querySelector('.ans-videoquiz').hidden = true; });
      assert.equal((await step(2000)).solved, false);
    });
    await scenario('video-quiz-like controls in a non-video page stay untouched', {}, async ({ page, step, submissions }) => {
      await page.evaluate(() => document.querySelector('video').remove());
      assert.equal((await step()).active, false);
      assert.deepEqual(await submissions(), []);
    });
    console.log(`All ${passed} direct quiz-state browser regressions passed.`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
