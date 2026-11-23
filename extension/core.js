/* Shared DOM inspection and decision rules. No platform API calls. */
(() => {
  "use strict";
  const ids = new WeakMap();
  const targets = new Map();
  let sequence = 0;
  const idFor = element => {
    if (!ids.has(element)) ids.set(element, String(++sequence));
    return ids.get(element);
  };
  const normalize = text => String(text || "").replace(/[\s\u200b<>《》«»‹›→←❯❮＞＜]/g, "");
  const isNextText = text => /^(?:下一节|下节|下一章|下一章节|下一(?:个)?(?:视频|任务|知识点))$/.test(normalize(text));
  const visible = element => {
    if (!element.isConnected || !element.getClientRects().length) return false;
    const view = element.ownerDocument.defaultView;
    for (let current = element; current; current = current.parentElement) {
      const style = view.getComputedStyle(current);
      if (current.hidden || current.getAttribute("aria-hidden") === "true" ||
        style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
    }
    return true;
  };
  const disabled = element => Boolean(element.disabled || element.closest(
    '[disabled], [aria-disabled="true"], [inert], .disabled, .disable, .locked, .lock'
  ));
  const describe = element => (element.innerText || element.textContent || element.value ||
    element.getAttribute("aria-label") || element.title || "").trim().slice(0, 80);
  const videoModulePath = /\/ananas\/modules\/(?:zt\/)?video(?:\/|$)/i;
  const playerPath = /\/ananas\/modules\/(?:zt\/)?(?:video|videoquiz)(?:\/|$)/i;
  const videoIframe = 'iframe.ans-insertvideo, iframe[type="video"], iframe[data-type="video"]';
  const playerShell = '.video-js, .ans-video, [data-video-player]';
  const nextControlSelector = 'a, button, [role="button"], input[type="button"], input[type="submit"], [onclick]';
  const dialogSelector = '[role="dialog"], [role="alertdialog"], .layui-layer, .el-message-box, .ant-modal, .modal, .x-window, .x-message-box, .popDiv, .popDialog, .alertDialog, .cxDialog, .dialog, .dialog-box, .confirm-box';
  const unfinishedWarning = /(?:(?:学习|任务点|章节|任务).{0,24}(?:未完成|尚未完成|没有完成)|(?:未完成|尚未完成|没有完成).{0,16}(?:学习|任务点|章节|任务))/;
  const taskOwnerSelector = '[data-jobid], [data-job-id], [jobid]';
  const quizPath = /\/ananas\/modules\/(?:zt\/)?work(?:\/|$)|\/work\/(?:doHomeWork(?:New)?|doWork|studentWork)(?:\/|$)/i;
  const quizAttachment = '.ans-insertwork, iframe[type="work"], iframe[type="quiz"], iframe[data-type="work"]';
  const quizContent = '[id^="question"], .TiMu, .question-item, .questionItem, .quiz-question, .mark_table';
  const signedMediaParams = /^(?:auth_key|wstime|wssecret|expires|expire|expiration|x-(?:amz|oss)-(?:algorithm|credential|date|expires|signedheaders|security-token|signature))$/i;

  function httpUrl(value, doc) {
    if (!value) return null;
    try {
      const url = new URL(value, doc.baseURI || doc.URL);
      return ['http:', 'https:'].includes(url.protocol) ? url : null;
    } catch { return null; }
  }

  function videoFrameUrl(frame) {
    for (const name of ['src', 'data-src']) {
      const url = httpUrl(frame.getAttribute(name), frame.ownerDocument);
      if (url && (videoModulePath.test(url.pathname) || frame.matches(videoIframe))) {
        url.hash = '';
        return url.href;
      }
    }
    return '';
  }

  function taskFor(element) {
    return element?.closest('.ans-attach-ct') || element?.closest('.ans-job-finished') ||
      element?.closest(taskOwnerSelector) || null;
  }

  function ownsSinglePlayer(task, element) {
    if (task === element) return true;
    const players = [...task.querySelectorAll('video, iframe')].filter(player =>
      taskFor(player) === task && (player.tagName === 'VIDEO' || videoFrameUrl(player) || player.matches(videoIframe)));
    return players.length === 1 && players[0] === element;
  }

  function taskState(task, element = task) {
    const markers = [...task.querySelectorAll('.ans-job-icon')]
      .filter(marker => (taskFor(marker.parentElement) || marker.parentElement) === task);
    const completedContainer = element.closest('.ans-job-finished');
    const completed = Boolean(completedContainer &&
      (completedContainer === task || task.contains(completedContainer))) || markers.some(marker => {
      if (marker.classList.contains('ans-job-finished')) return true;
      const labels = [marker.title, marker.getAttribute('aria-label'), marker.textContent].map(normalize);
      return labels.some(label => /^(?:视频|文档|文稿|课件|PPT|音频|图书)?(?:任务点)?已完成[。.!！]?$/i.test(label)) &&
        !labels.some(label => /未完成|没有完成|尚未完成/.test(label));
    });
    return { required: completed || Boolean(markers.length || taskId(element)), completed };
  }

  function attachmentTask(element) {
    const task = taskFor(element);
    return task ? taskState(task, element) : { required: false, completed: false };
  }

  function videoTask(element) {
    const task = taskFor(element);
    return task && ownsSinglePlayer(task, element) ? taskState(task, element) : { required: false, completed: false };
  }

  function taskId(element) {
    if (!element) return '';
    const task = taskFor(element);
    for (const target of [element, task]) {
      if (!target) continue;
      for (const name of ['data-jobid', 'data-job-id', 'jobid']) {
        const value = target.getAttribute(name)?.trim();
        if (validIdentity(value)) return value;
      }
    }
    return '';
  }

  function validIdentity(value) {
    return Boolean(value && value.length <= 256 && !/^(?:0|null|undefined|false)$/i.test(value));
  }

  function completionKey(video, source, singleVideo, parentFrame) {
    const localTask = taskFor(video);
    const parentTask = taskFor(parentFrame);
    const jobId = (localTask && ownsSinglePlayer(localTask, video) ? taskId(video) : '') ||
      (singleVideo && parentTask && ownsSinglePlayer(parentTask, parentFrame) ? taskId(parentFrame) : '');
    if (jobId) return `task:jobid:${jobId}`;
    const doc = video.ownerDocument;
    const playerUrl = singleVideo ? httpUrl(doc.URL, doc) : null;
    if (playerUrl && videoModulePath.test(playerUrl.pathname)) {
      const params = new Map([...playerUrl.searchParams].map(([name, value]) => [name.toLowerCase(), value]));
      for (const name of ['jobid', 'objectid', 'videoid']) {
        const value = params.get(name);
        if (validIdentity(value)) return `task:${name}:${value}`;
      }
    }
    const media = httpUrl(source, doc);
    if (!media) return '';
    media.username = '';
    media.password = '';
    media.hash = '';
    // Remove known signing parameters while preserving asset selectors in the query.
    for (const name of [...media.searchParams.keys()]) {
      if (signedMediaParams.test(name)) media.searchParams.delete(name);
    }
    media.searchParams.sort();
    return `source:${media.href}`;
  }

  function videoDetails(doc) {
    const elements = [...doc.querySelectorAll('video')];
    const singleVideo = elements.length === 1;
    let parentFrame = null;
    // The parent wrapper can supply a stable media key. Its task status is
    // resolved with the other frame snapshots.
    try { parentFrame = doc.defaultView?.frameElement || null; } catch { /* cross-origin */ }
    return elements.map(video => {
      const source = video.currentSrc || video.src || video.querySelector('source')?.src || '';
      const task = videoTask(video);
      return {
        id: idFor(video), source,
        completionKey: completionKey(video, source, singleVideo, parentFrame),
        taskRequired: task.required,
        platformCompleted: task.completed,
        ended: video.ended && Number.isFinite(video.duration) && video.duration > 0,
        paused: video.paused,
        duration: Number.isFinite(video.duration) ? video.duration : null,
        currentTime: video.currentTime || 0,
        error: Boolean(video.error)
      };
    });
  }

  function nextElements(doc, selector) {
    if (selector) {
      try { return [...doc.querySelectorAll(selector)].filter(visible); }
      catch { return []; }
    }
    return [...doc.querySelectorAll(nextControlSelector)]
      .filter(element => [element.innerText || element.textContent, element.value,
        element.getAttribute("aria-label"), element.title].some(isNextText))
      .filter(visible)
      // An outer onclick wrapper and its inner link are one target.
      .filter((element, index, all) => !all.some((other, otherIndex) => otherIndex !== index && element.contains(other)));
  }

  function warningRoot(button) {
    const dialog = button.closest(dialogSelector);
    if (dialog) return unfinishedWarning.test(normalize(dialog.textContent).slice(0, 600)) ? dialog : null;
    const doc = button.ownerDocument;
    for (let root = button.parentElement, depth = 0; root && depth < 5; root = root.parentElement, depth++) {
      if (root.matches('body, html, main, #mainid, #pageDiv')) break;
      const position = doc.defaultView.getComputedStyle(root).position;
      if (!['fixed', 'absolute'].includes(position) || root.querySelector('video, iframe, [id^="question"], .TiMu, .question-item')) continue;
      const text = normalize(root.textContent);
      if (text.length <= 600 && unfinishedWarning.test(text)) return root;
    }
    return null;
  }

  function navigationControls(doc, selector) {
    const normal = nextElements(doc, "");
    const warnings = new Map(normal.map(button => [button, warningRoot(button)]).filter(([, root]) => root));
    const candidates = (selector ? nextElements(doc, selector) : normal)
      .filter(element => !element.closest(dialogSelector) && !warnings.has(element) && !warningRoot(element));
    return { candidates, confirmations: [...warnings.keys()] };
  }

  function pageKey(doc) {
    try {
      const url = new URL(doc.URL);
      const identity = [...url.searchParams.entries()]
        .filter(([name]) => /^(?:courseid|chapterid|knowledgeid|num|workid|workanswerid)$/i.test(name))
        .map(([name, value]) => [name.toLowerCase(), value])
        .sort(([left], [right]) => left.localeCompare(right));
      return `${url.origin}${url.pathname}:${JSON.stringify(identity)}`;
    } catch { return ""; }
  }

  const loadingIndicator = '[aria-busy="true"], .loading, .loading-mask, .loadings, .layui-layer-loading';
  const loadingText = /正在加载|加载中|请稍候|loading/i;
  const emptyText = /^(?:(?:本章节?|当前章节?|本节|本课程|当前页面)?(?:暂无|没有|无)(?:(?:学习|课程|章节)?内容|课程|任务点)(?:可学习)?|本节无任务)[。.!！]*$/;
  const chapterChrome = 'script, style, noscript, template, link, meta, #cx-auto-next-panel, #content1, #prevNextFocus, #cardFocus, #cardFocusEnd, nav, aside, header, footer, [role="navigation"], .prevNext, .ans-job-icon, .chapter-title, .chapterTitle, .chapter_title, .chapter-name, .chapterName, .knowledge-title, .knowledgeTitle, .tit_name';
  const previewChrome = '#mainid > .prev_title_pos, #mainid > .prev_title, #mainid > #prev_tab, #mainid > .iconBox';
  const materialRegion = 'article, [data-lesson-content], .ans-attach-ct, ' + taskOwnerSelector;
  const emptyContainer = '.nullpage, [class*="empty" i], [id*="empty" i], [class*="no-data" i], [class*="nodata" i], [class*="no-content" i], [class*="nocontent" i]';
  const illustration = 'picture, img:not(picture img), svg:not(svg svg)';

  function chapterHeading(scope) {
    const candidates = [...scope.querySelectorAll('h1,h2,h3,h4,[role="heading"]')].filter(element =>
      visible(element) && !element.closest(materialRegion + ', ' + chapterChrome + ', ' + dialogSelector) &&
      !emptyText.test(normalize(element.textContent)) &&
      !element.querySelector('iframe, audio, video, img, picture, svg, object, embed, table, .ans-job-icon'));
    if (candidates.length) return candidates.length === 1 ? candidates[0] : null;
    // Some chapter names are rendered as a short, large line of ordinary text.
    const candidatesByStyle = [...scope.querySelectorAll('p, div, span, strong')].filter(element => {
      if (element.childElementCount || !element.textContent.trim() ||
        element.closest(materialRegion + ', ' + chapterChrome + ', ' + dialogSelector)) return false;
      const text = element.textContent.trim();
      return text.length <= 48 && !/[。！？：；\n]/.test(text) && !emptyText.test(normalize(text)) &&
        Number.parseFloat(element.ownerDocument.defaultView.getComputedStyle(element).fontSize) >= 22 && visible(element);
    });
    return candidatesByStyle.length === 1 ? candidatesByStyle[0] : null;
  }

  function isIllustratedEmptyPanel(node) {
    if (!node.matches('div, section, figure, p, center') || !emptyText.test(normalize(node.textContent)) ||
      node.closest(materialRegion) || node.querySelector(materialRegion + ', iframe, audio, video, canvas, object, embed, table, input, button, .ans-job-icon')) return false;
    const graphics = [...node.querySelectorAll(illustration)].filter(visible);
    if (graphics.length !== 1) return false;
    const [graphic] = graphics;
    if (graphic.closest('figure') && graphic.closest('figure') !== node &&
      !emptyText.test(normalize(graphic.closest('figure').textContent))) return false;
    const message = [...node.children].find(child => emptyText.test(normalize(child.textContent)));
    if (message && !message.contains(graphic) &&
      (message.matches(emptyContainer) || message.querySelector(illustration))) return false;
    const label = normalize(graphic.getAttribute('aria-label') || graphic.getAttribute('alt') ||
      graphic.querySelector('img')?.getAttribute('alt'));
    return node.matches(emptyContainer) || !label || emptyText.test(label) || /空状态|空白页|插图/.test(label);
  }

  function framePath(frame) {
    return httpUrl(frame.getAttribute('data-src') || frame.getAttribute('src'), frame.ownerDocument)?.pathname || '';
  }

  function quizFrame(frame) {
    return frame.matches(quizAttachment) || quizPath.test(framePath(frame));
  }

  function chapterTasks(scope, quizDocument) {
    const owners = new Set([...scope.querySelectorAll('.ans-job-icon')]
      .map(marker => taskFor(marker.parentElement) || marker.parentElement));
    for (const element of scope.querySelectorAll(taskOwnerSelector + ', .ans-job-finished')) owners.add(taskFor(element) || element);
    return [...owners].flatMap(owner => {
      if (!visible(owner)) return [];
      const { required, completed } = taskState(owner);
      if (!required) return [];
      const media = owner.matches('iframe, video, audio, embed, object') ? [owner] :
        [...owner.querySelectorAll('iframe, video, audio, embed, object')];
      const quiz = media.length ? media.every(item => item.tagName === 'IFRAME' && quizFrame(item)) :
        quizDocument || owner.matches(quizContent) ||
        Boolean(owner.querySelector(quizContent) && !hasChapterMaterial(owner, false));
      return [{ id: idFor(owner), completed, quiz }];
    });
  }

  function hasChapterMaterial(scope, chapter, preview = false) {
    const heading = chapter ? chapterHeading(scope) : null;
    if (chapter && isIllustratedEmptyPanel(scope)) return false;
    const pending = [...scope.childNodes];
    while (pending.length) {
      const node = pending.pop();
      if (node.nodeType === 3) {
        const text = normalize(node.textContent);
        if (text && !emptyText.test(text)) return true;
        continue;
      }
      if (node.nodeType !== 1 || node === heading || node.matches(chapterChrome) ||
        (preview && node.matches(previewChrome)) ||
        node.matches(dialogSelector) || node.matches(quizContent) || (chapter && isIllustratedEmptyPanel(node))) continue;
      const style = node.ownerDocument.defaultView.getComputedStyle(node);
      if (node.hidden || node.getAttribute('aria-hidden') === 'true' || style.display === 'none' ||
        style.visibility === 'hidden' || style.visibility === 'collapse') continue;
      if (node.matches(nextControlSelector)) {
        const label = normalize(describe(node));
        if (isNextText(label) || /^(?:上一节|上节|上一章|上一章节|返回课程|返回|目录|提交(?:答案|作业|测验)?|保存|暂存|重做)$/.test(label)) continue;
      }
      if (node.tagName === 'IFRAME') {
        if (quizFrame(node) || node.hasAttribute('srcdoc') || /\/knowledge\/cards\/?$/i.test(framePath(node))) continue;
        if (node.getAttribute('src') === 'about:blank' && !node.getAttribute('data-src')) continue;
        return true;
      }
      if (node.matches('audio,video,img,picture,canvas,svg,object,embed,table,textarea,[contenteditable="true"]')) return true;
      pending.push(...node.childNodes);
    }
    return false;
  }

  function chapterDetails(doc) {
    const page = doc.getElementById('pageDiv');
    const content = page && visible(page) ? page : [...doc.querySelectorAll('.ans-cc')].find(visible);
    const scope = content || doc.querySelector('#mainid, main') || doc.body;
    if (!scope) return { loading: true };
    const loading = doc.readyState !== "complete" || scope.matches(loadingIndicator) ||
      [...scope.querySelectorAll(loadingIndicator + ', [role="progressbar"]')].some(element =>
        visible(element) && (!element.matches('[role="progressbar"]') || element.matches(loadingIndicator) ||
          loadingText.test(element.getAttribute("aria-label") || element.textContent)));
    const contentFrameUrls = [...scope.querySelectorAll('iframe')].flatMap(frame => {
      if (!visible(frame)) return [];
      if (frame.hasAttribute('srcdoc')) return ['about:srcdoc'];
      const url = httpUrl(frame.getAttribute('data-src') || frame.getAttribute('src'), doc);
      if (!url || !(url.hostname === 'chaoxing.com' || url.hostname.endsWith('.chaoxing.com')) ||
        !/\/knowledge\/cards\/?$/i.test(url.pathname)) return [];
      url.hash = "";
      return [url.href];
    });
    const questionKey = [...scope.querySelectorAll(quizContent)]
      .filter(visible).map(element => element.id || idFor(element));
    const path = httpUrl(doc.URL, doc)?.pathname || '';
    const preview = /\/mycourse\/studentstudy\/?$/i.test(path);
    const quizDocument = quizPath.test(path);
    const hasQuiz = quizDocument || Boolean(questionKey.length) || [...scope.querySelectorAll('iframe')].some(quizFrame);
    const hasMaterial = quizDocument
      ? [...scope.querySelectorAll('article, [data-lesson-content]')].some(element =>
        visible(element) && !element.closest(quizContent) && hasChapterMaterial(element, false))
      : hasChapterMaterial(scope, preview || /\/knowledge\/cards\/?$/i.test(path), preview);
    return { loading, contentFrameUrls, questionKey, hasQuiz, hasMaterial, tasks: chapterTasks(scope, quizDocument) };
  }

  function snapshot(doc, selector = "") {
    targets.clear();
    let selectorError = false;
    if (selector) {
      try { doc.querySelector(selector); } catch { selectorError = true; }
    }
    const navigation = navigationControls(doc, selector);
    const remember = element => {
      const id = idFor(element);
      targets.set(id, element);
      return { id, label: describe(element), disabled: disabled(element) };
    };
    return { ...inspectMedia(doc), ...chapterDetails(doc),
      candidates: navigation.candidates.map(remember), confirmations: navigation.confirmations.map(remember),
      selectorError, pageKey: pageKey(doc) };
  }

  function inspectMedia(doc) {
    const videos = videoDetails(doc);
    const videoAttachments = [...doc.querySelectorAll('iframe')].flatMap(frame => {
      const url = videoFrameUrl(frame);
      return url || frame.matches(videoIframe) ? [{ id: idFor(frame), url, ...videoTask(frame) }] : [];
    });
    const path = httpUrl(doc.URL, doc)?.pathname || "";
    const shells = [...doc.querySelectorAll(playerShell)].filter(visible);
    const unloadedVideo = shells.some(shell => !shell.querySelector('video, iframe') && shell.tagName !== 'VIDEO');
    const videoContext = Boolean(videos.length || videoAttachments.length || playerPath.test(path) ||
      shells.length);
    const activeVideoQuiz = [...doc.querySelectorAll('.ans-videoquiz, .vjs-videoquiz, .video-quiz, .videoquiz, #videoquiz, .ans-videoquiz-opts')]
      .some(visible);
    return { videos, videoContext, videoAttachments, unloadedVideo,
      playerDocument: videoModulePath.test(path), activeVideoQuiz };
  }

  function revealVideo(doc, id) {
    const player = [...doc.querySelectorAll('iframe')].find(frame => ids.get(frame) === id);
    if (player && visible(player)) player.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
  }

  function clickNext(id, selector = "", confirmation = false) {
    const element = targets.get(String(id));
    if (!element || !visible(element) || disabled(element)) return false;
    const controls = navigationControls(element.ownerDocument, selector);
    if (!(confirmation ? controls.confirmations : controls.candidates).includes(element)) return false;
    element.click();
    return true;
  }

  function missingChildContent(frames) {
    for (const { frameId, snapshot } of frames) {
      const expected = snapshot.contentFrameUrls || [];
      if (!expected.length) continue;
      const childUrls = frames.filter(frame => frame.parentFrameId === frameId && frame.url)
        .map(frame => frame.url.split('#', 1)[0]);
      for (const url of expected) {
        const index = childUrls.indexOf(url);
        if (index < 0) return true;
        childUrls.splice(index, 1);
      }
    }
    return false;
  }

  function availableControl(frames, kind) {
    const parent = frames.find(frame => frame.frameId === 0);
    const ordered = parent ? [parent, ...frames.filter(frame => frame !== parent)] : frames;
    for (const frame of ordered) {
      if (frame.snapshot.documentViewer) continue;
      const button = frame.snapshot[kind]?.find(candidate => !candidate.disabled);
      if (button) return { ...button, frameId: frame.frameId, documentId: frame.documentId, epoch: frame.epoch };
    }
  }

  function assess(frames) {
    if (!frames.length || frames.some(frame => frame.error)) {
      return { ready: false, status: "正在等待播放器页面响应…" };
    }
    if (frames.some(frame => frame.snapshot.selectorError)) {
      return { ready: false, status: "自定义选择器格式有误，请在设置中修改。" };
    }
    if (frames.some(frame => frame.snapshot.activeVideoQuiz || frame.snapshot.quiz?.active)) {
      return { ready: false, status: "视频弹题正在处理，完成后继续播放。" };
    }
    const videos = frames.flatMap(frame => frame.snapshot.videos);
    if (frames.some(frame => frame.pendingVideo ?? (frame.snapshot.unloadedVideo ||
      (frame.snapshot.playerDocument && !frame.snapshot.videos.length)))) {
      return { ready: false, status: "本节仍有视频正在加载，全部视频结束后才会切换下一节。" };
    }
    if (frames.some(frame => frame.snapshot.loading ||
      (!videos.length && frame.pendingVideo === undefined && frame.snapshot.videoContext)) ||
      missingChildContent(frames)) {
      return { ready: false, status: "正在等待课程页面加载…" };
    }
    const unfinished = videos.filter(video => !isVideoPlayed(video));
    if (unfinished.some(video => video.error)) return { ready: false, status: "视频加载出错，请先处理播放器提示。" };
    const finished = videos.length - unfinished.length;
    if (finished !== videos.length) {
      const paused = unfinished.every(video => video.paused);
      return { ready: false, status: paused
        ? `等待视频播放（已完成 ${finished}/${videos.length}）；请按播放器提示继续。`
        : `正在播放，完成后切换（已完成 ${finished}/${videos.length}）。` };
    }
    if (videos.some(video => !isVideoCompleted(video))) {
      return { ready: false, status: "视频已播完，正在等待学习通确认视频任务点。" };
    }
    const documents = frames.flatMap(frame => frame.snapshot.documentTasks || []);
    const read = documents.filter(task => task.completed).length;
    if (read !== documents.length) {
      return { ready: false, status: `正在处理文稿或 PPT（已完成 ${read}/${documents.length}），等待学习通确认任务点。` };
    }
    const tasks = frames.flatMap(frame => frame.snapshot.documentViewer ? [] : frame.snapshot.tasks || []);
    if (tasks.some(task => !task.completed && !task.quiz)) {
      return { ready: false, status: "本节还有未完成的任务点，完成后继续。" };
    }
    const hasQuiz = frames.some(frame => frame.snapshot.hasQuiz);
    const hasMaterial = frames.some(frame => frame.snapshot.hasMaterial && !frame.snapshot.documentViewer);
    const hasCompletedWork = videos.length || documents.length || tasks.some(task => task.completed && !task.quiz);
    if (!hasCompletedWork && hasMaterial) {
      return { ready: false, status: "本节还有学习内容，请在当前页继续。" };
    }
    const mode = hasCompletedWork ? (videos.length ? "video" : "task") : hasQuiz ? "quiz" : "empty";
    const target = availableControl(frames, "candidates");
    const confirmation = availableControl(frames, "confirmations");
    const label = { video: "本节视频已全部完成", task: "本节学习任务已完成", quiz: "本节为答题页", empty: "本节为空白页" }[mode];
    const signature = JSON.stringify([mode, frames.map(frame => [frame.documentId,
      frame.snapshot.pageKey || "", frame.snapshot.questionKey || "",
      frame.snapshot.videos.map(video => [video.id, video.source, video.duration]),
      (frame.snapshot.documentTasks || []).map(task => [task.id, task.url]),
      (frame.snapshot.tasks || []).filter(task => !task.quiz).map(task => task.id)]).sort()]);
    const mayConfirm = mode === "empty" || mode === "quiz" || tasks.some(task => task.quiz && !task.completed);
    return { eligible: true, ready: Boolean(target), mode, signature, label, target,
      confirmation: mayConfirm ? confirmation : undefined, blockedConfirmation: Boolean(confirmation && !mayConfirm),
      status: target ? label : "未找到可用的下一节按钮，可能已到末节或下一节尚未解锁。" };
  }

  function isVideoPlayed(video) {
    return Boolean(video.ended || video.platformCompleted || (!video.taskRequired && video.completed));
  }

  function isVideoCompleted(video) {
    return video.taskRequired ? Boolean(video.platformCompleted) : isVideoPlayed(video);
  }

  globalThis.CxAutoNext = { snapshot, clickNext, assess, inspectMedia, videoDetails, isNextText, isVideoCompleted, isVideoPlayed,
    attachmentTask, disabled, httpUrl, idFor, visible, revealVideo };
})();
