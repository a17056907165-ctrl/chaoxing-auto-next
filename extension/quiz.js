// Stateful trials inside video-player popups only. Chapter tests are navigation-only.
(() => {
  "use strict";
  const documents = new WeakMap();
  const visible = element => {
    if (!element?.isConnected || !element.getClientRects().length) return false;
    for (let node = element; node; node = node.parentElement) {
      const style = element.ownerDocument.defaultView.getComputedStyle(node);
      if (node.hidden || node.getAttribute("aria-hidden") === "true" || style.display === "none" ||
        ["hidden", "collapse"].includes(style.visibility)) return false;
    }
    return true;
  };
  const usable = element => visible(element) && !element.matches(':disabled, [disabled], [aria-disabled="true"], .disabled');
  const find = (root, selector) => [...root.querySelectorAll(selector)].find(usable);
  const shown = (root, selector) => [...root.querySelectorAll(selector)].some(visible);
  const roots = '.ans-videoquiz, #videoquiz, [data-video-quiz]';
  const rightSelectors = '#spanYes, #spanRight, #spanCorrect, .answer-correct, [data-quiz-result="correct"]';
  const wrongSelectors = '#spanNot, #spanNotBack, #spanNotBackPoint, .answer-wrong, [data-quiz-result="wrong"]';
  const feedbackNodes = '#spanNot, #spanNotBack, #spanNotBackPoint, #spanYes, #spanRight, #spanCorrect, #videoquiz-submitting, .answer-wrong, .answer-correct, .ans-videoquiz-feedback, [data-quiz-result], [role="alert"], [aria-busy]';

  function documentRecord(doc) {
    let record = documents.get(doc);
    if (record) return record;
    record = { questions: new Map(), current: null, enabled: false, revision: null, feedbackVersion: 0 };
    const Observer = doc.defaultView?.MutationObserver;
    if (Observer && doc.documentElement) {
      record.observer = new Observer(changes => {
        if (changes.some(change => {
          const element = change.target.nodeType === 1 ? change.target : change.target.parentElement;
          return element?.closest(feedbackNodes) || [...(change.addedNodes || [])].some(node =>
            node.nodeType === 1 && (node.matches(feedbackNodes) || node.querySelector(feedbackNodes)));
        })) record.feedbackVersion++;
      });
      record.observer.observe(doc.documentElement, { subtree: true, childList: true, characterData: true,
        attributes: true, attributeFilter: ['class', 'style', 'hidden', 'aria-busy', 'data-quiz-result'] });
    }
    documents.set(doc, record);
    return record;
  }

  function choices(count, multiple) {
    if (!Number.isInteger(count) || count < 2 || count > (multiple ? 6 : 12)) return [];
    if (!multiple) return Array.from({ length: count }, (_, index) => [index]);
    return Array.from({ length: (1 << count) - 1 }, (_, index) => index + 1)
      .sort((a, b) => a.toString(2).replace(/0/g, "").length - b.toString(2).replace(/0/g, "").length || a - b)
      .map(mask => Array.from({ length: count }, (_, index) => index).filter(index => mask & (1 << index)));
  }

  function inspect(doc) {
    // A chapter exercise must never become a trial target just because it has inputs.
    if (!doc.querySelector('video') && !/\/ananas\/modules\/(?:video|videoquiz)\//i.test(doc.URL || "")) return null;
    const root = [...doc.querySelectorAll(roots)].find(visible);
    if (!root) return null;
    const topic = [...root.querySelectorAll('.tkTopic')].find(visible) || root;
    const inputs = [...topic.querySelectorAll('input[type="radio"], input[type="checkbox"]')]
      .filter(input => visible(input.closest('.ans-videoquiz-opt, label, li') || input));
    const title = topic.querySelector('.tkItem_title, .ans-videoquiz-title, [data-question-title]')?.textContent?.trim() || "";
    const source = doc.querySelector('video')?.currentSrc || doc.querySelector('video')?.src || "";
    const key = JSON.stringify([source, root.getAttribute('data-question-id'), title,
      inputs.map(input => [input.id, input.name, input.type, input.value])]);
    return { root, topic, inputs, key };
  }

  function confirmedBeforeClose(root) {
    if (!root) return false;
    const internallyShown = element => {
      for (let node = element; node && node !== root; node = node.parentElement) {
        const style = root.ownerDocument.defaultView.getComputedStyle(node);
        if (node.hidden || node.getAttribute('aria-hidden') === 'true' || style.display === 'none' ||
          ['hidden', 'collapse'].includes(style.visibility)) return false;
      }
      return true;
    };
    return [...root.querySelectorAll(rightSelectors)].some(internallyShown) &&
      ![...root.querySelectorAll(wrongSelectors)].some(internallyShown);
  }

  function step(doc, settings = {}) {
    const record = documentRecord(doc);
    if (record.revision !== settings.revision || record.enabled !== (settings.enabled === true)) {
      record.questions.clear();
      record.current = null;
      record.revision = settings.revision;
      record.enabled = settings.enabled === true;
    }
    const quiz = inspect(doc);
    if (!quiz) {
      const prior = record.current;
      const solved = prior?.phase === 'continuing' || Boolean(prior?.confirmedSuccess) ||
        Boolean(prior?.phase === 'awaiting' && confirmedBeforeClose(prior.root));
      record.current = null;
      return { active: false, solved, status: solved ? "视频弹题已完成，继续播放。" : "视频弹题：等待弹题" };
    }
    if (!settings.enabled) return { active: true, solved: false, status: "视频弹题自动尝试已关闭。" };
    let state = record.questions.get(quiz.key);
    if (!state) {
      state = { phase: 'ready', tried: 0, at: 0, message: '', busySince: 0, root: quiz.root, confirmedSuccess: false };
      record.questions.set(quiz.key, state);
      if (record.questions.size > 100) record.questions.delete(record.questions.keys().next().value);
    }
    record.current = state;
    const result = status => ({ active: true, solved: false, attempts: state.tried, status });
    const { root, topic, inputs } = quiz;
    if (state.phase === 'blocked') return result(state.message);
    if (state.phase === 'continuing') return result("已点击继续播放，等待弹题关闭…");
    const wrong = shown(root, wrongSelectors) ||
      [...root.querySelectorAll('.ans-videoquiz-feedback, [role="alert"]')].some(element => visible(element) && /回答错误|答错|答案不正确/.test(element.textContent));
    const right = shown(root, rightSelectors) ||
      [...root.querySelectorAll('.ans-videoquiz-feedback, [role="alert"]')].some(element => visible(element) && /回答正确|答对/.test(element.textContent));
    const continuation = find(root, '#videoquiz-continue, .ans-videoquiz-continue');
    const busy = shown(root, '#videoquiz-submitting, [aria-busy="true"]');
    if (right && !wrong && !busy) state.confirmedSuccess = true;
    if (continuation && !wrong && right && !busy) {
      state.phase = 'continuing';
      continuation.click();
      return result("视频弹题已答对，正在继续播放。");
    }
    const block = message => { state.phase = 'blocked'; state.message = message; return result(message); };
    const waitForControls = message => {
      if (!state.busySince) state.busySince = Date.now();
      return Date.now() - state.busySince > 12000 ? block(`${message}，请手动检查。`) : result(`${message}，正在等待…`);
    };
    if (/只能(?:回答|作答|提交)一次|仅(?:有|能)(?:一次|1次)|剩余(?:作答|提交)?次数[：:\s]*[01](?!\d)/.test(root.textContent)) {
      return block("视频弹题存在次数限制，等待手动处理。");
    }
    if (state.phase === 'awaiting') {
      const elapsed = Date.now() - state.at;
      if (busy) {
        state.seenBusy = true;
        if (elapsed > 20000) return block("视频弹题提交超时，已停止重复提交。");
        return result("视频弹题：正在提交，等待结果…");
      }
      if (elapsed < 1800) return result("视频弹题：等待提交结果…");
      const fresh = record.feedbackVersion > state.feedbackVersion || state.seenBusy || !state.wrongBefore;
      if (!wrong || !fresh) {
        if (right && !continuation) return result("视频弹题已答对，等待播放器继续。");
        if (elapsed > 12000) return block("视频弹题未返回明确结果，已停止重复提交。");
        return result("视频弹题：等待对错反馈…");
      }
      const retry = find(root, '.ans-videoquiz-retry, #videoquiz-retry, [data-quiz-retry]') ||
        [...root.querySelectorAll('button, a, [role="button"]')].find(element => usable(element) &&
          /^(?:重新(?:选择|作答|答题)|重试|再试一次)$/.test((element.textContent || "").trim()));
      if (retry) {
        state.phase = 'ready';
        retry.click();
        return result("本次答案错误，重新选择下一组选项…");
      }
      if (!inputs.length || inputs.some(input => input.disabled)) return waitForControls("答错后尚未找到可重选的选项");
      state.phase = 'ready';
    }
    const submit = find(root, '#videoquiz-submit, .ans-videoquiz-submit');
    if (!submit || busy) return waitForControls("弹题提交按钮尚未就绪");
    if (topic.querySelector('textarea, input[type="text"], [contenteditable="true"]')) {
      return block("视频弹题包含填空或文字输入，等待手动处理。");
    }
    if (!inputs.length || inputs.some(input => input.disabled)) return waitForControls("视频弹题选项尚未就绪");
    state.busySince = 0;
    const multiple = inputs.every(input => input.type === 'checkbox');
    if (!multiple && !inputs.every(input => input.type === 'radio')) return block("视频弹题题型无法识别，等待手动处理。");
    if (!multiple && new Set(inputs.map(input => input.name).filter(Boolean)).size > 1) {
      return block("弹题同时显示多个题目，等待手动处理。");
    }
    const combinations = choices(inputs.length, multiple);
    if (!combinations.length) return block("视频弹题选项过多或无法识别，等待手动处理。");
    if (state.tried >= combinations.length) return block("已尝试全部选项组合，仍未通过，请手动检查。");
    const selection = combinations[state.tried];
    for (let index = 0; index < inputs.length; index++) {
      const wanted = selection.includes(index);
      if (multiple ? inputs[index].checked !== wanted : wanted && !inputs[index].checked) inputs[index].click();
    }
    if (!visible(root) || !usable(submit) || inspect(doc)?.key !== quiz.key) return result("弹题页面发生变化，正在重新检查…");
    if (inputs.some((input, index) => input.checked !== selection.includes(index))) {
      return block("弹题选项未能完整选择，等待手动处理。");
    }
    state.tried++;
    state.at = Date.now();
    state.phase = 'awaiting';
    state.seenBusy = false;
    state.wrongBefore = wrong;
    record.observer?.takeRecords();
    state.feedbackVersion = record.feedbackVersion;
    submit.click();
    return result(`视频弹题：已尝试第 ${state.tried} 组，等待反馈。`);
  }
  function summary(frames, enabled) {
    if (!enabled) return "视频弹题自动尝试已关闭";
    const active = frames.find(frame => frame.snapshot?.quiz?.active);
    return active?.snapshot.quiz.status || "视频弹题：等待弹题";
  }
  globalThis.CxVideoQuiz = { step, inspect, choices, summary };
})();
