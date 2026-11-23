(() => {
  "use strict";
  const core = globalThis.CxAutoNext;
  const documents = globalThis.CxDocuments;
  const guard = { epoch: -1, enabled: false };
  const acceptGuard = message => {
    if (!Number.isFinite(message.epoch) || message.epoch < guard.epoch) return false;
    if (message.epoch > guard.epoch) {
      guard.epoch = message.epoch;
      guard.enabled = message.enabled === true;
    } else if (message.enabled === false) guard.enabled = false;
    return true;
  };
  const canMutate = epoch => epoch === guard.epoch && guard.enabled;
  const progressBindings = new WeakMap();
  document.addEventListener?.("ended", event => {
    if (!event.isTrusted || event.target.tagName !== "VIDEO" || !event.target.ended) return;
    if (guard.enabled) chrome.runtime.sendMessage({ type: "CX_VIDEO_ENDED", epoch: guard.epoch }).catch(() => {});
    const binding = progressBindings.get(event.target);
    if (!binding) return;
    const index = [...document.querySelectorAll("video")].indexOf(event.target);
    const video = core.videoDetails(document)[index];
    if (video?.ended && video.id === binding.id && video.completionKey === binding.completionKey) {
      chrome.storage.local.set({ [binding.storageKey]: true }).catch(() => {});
    }
  }, true);
  const inspectDocuments = () => ({ documentTasks: documents.inspect(document), ...documents.viewerDetails(document) });
  const chapterSnapshot = selector => ({ ...core.snapshot(document, selector), ...inspectDocuments() });
  const inspection = (selector = "") => ({ ...chapterSnapshot(selector), speeds: [], playback: [],
    quiz: { active: Boolean(globalThis.CxVideoQuiz.inspect(document)), solved: false,
      status: "自动处理已暂停或当前检测已过期。" } });
  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message?.type === "CX_INSPECT") {
      respond({ ...core.inspectMedia(document), ...inspectDocuments(),
        quiz: { active: Boolean(globalThis.CxVideoQuiz.inspect(document)) } });
      return false;
    }
    if (message?.type === "CX_GUARD") {
      if (acceptGuard(message) && !guard.enabled) globalThis.CxAutoPlayback.stop(document);
      respond({ ok: true, epoch: guard.epoch });
      return false;
    }
    if (message?.type === "CX_SNAPSHOT") {
      acceptGuard(message);
      (async () => {
        if (message.inspectionOnly || !canMutate(message.epoch)) {
          respond(inspection(message.selector));
          return;
        }
        const quiz = globalThis.CxVideoQuiz.step(document, message.quiz);
        const observedVideos = core.videoDetails(document);
        if (Array.isArray(message.progress)) {
          const elements = document.querySelectorAll("video");
          observedVideos.forEach((video, index) => {
            const link = message.progress.find(item => item.id === video.id && item.completionKey === video.completionKey);
            if (link && elements[index]) progressBindings.set(elements[index], link);
            else if (elements[index]) progressBindings.delete(elements[index]);
          });
        }
        const playback = await globalThis.CxAutoPlayback.update(document, {
          ...message.playback, videoIds: observedVideos.map(video => video.id),
          quizActive: quiz.active || message.playback?.quizActive, quizSolved: quiz.solved
        });
        // A pause/updated control epoch may arrive while native play() is pending.
        if (!canMutate(message.epoch)) {
          respond(inspection(message.selector));
          return;
        }
        const speeds = globalThis.CxAutoSpeed.update(document, message.speed);
        if (message.revealVideo) core.revealVideo(document, message.revealVideo);
        if (message.revealDocument) documents.reveal(document, message.revealDocument);
        if (message.readDocument) documents.scrollToBottom(document);
        respond({ ...chapterSnapshot(message.selector), speeds, quiz, playback });
      })().catch(error => respond({ error: error.message }));
      return true;
    }
    else if (message?.type === "CX_CLICK") respond({ clicked: canMutate(message.epoch) &&
      core.clickNext(message.id, message.selector, message.confirmation === true) });
    return false;
  });
  if (window !== window.top || !/\/mycourse\/studentstudy\/?$/i.test(location.pathname)) return;
  if (document.getElementById("cx-auto-next-panel")) return;

  const url = new URL(location.href);
  const course = url.searchParams.get("courseid") || url.searchParams.get("courseId") || `${url.hostname}${url.pathname}`;
  const checkboxes = { autoPlay: "#auto-play", autoQuiz: "#auto-quiz", autoSpeed: "#auto-speed" };
  let enabled = false;
  let preferences = { selector: "", autoSpeed: true, speed: 2, autoQuiz: true, autoPlay: true };
  let lastJump = null;
  let active = false;
  let checkAgain = false;
  let generation = 0;
  let speedRevision = 0;
  let quizRevision = 0;
  let playRevision = 0;
  let saveQueue = Promise.resolve();
  const runId = `${Date.now()}:${Math.random()}`;

  const host = document.createElement("div");
  host.id = "cx-auto-next-panel";
  host.style.cssText = "position:fixed;right:18px;bottom:18px;z-index:2147483647;";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>
      :host { all:initial; font:14px/1.65 system-ui,"Microsoft YaHei",sans-serif; color:#172b32; }
      * { box-sizing:border-box; } .panel { width:316px; max-height:calc(100vh - 36px); overflow:auto; padding:18px; background:#fff; border:1px solid #d9e6e6; border-radius:16px; box-shadow:0 10px 40px #152b3329; }
      header { display:flex; justify-content:space-between; align-items:center; gap:12px; } strong { font-size:16px; }
      .badge { color:#41616b; background:#edf3f4; border-radius:20px; padding:2px 9px; font-size:12px; white-space:nowrap; }
      p { margin:12px 0; min-height:46px; overflow-wrap:anywhere; } button { cursor:pointer; font:inherit; border:0; border-radius:8px; padding:8px 12px; }
      #toggle { background:#14635a; color:white; width:100%; }
      details { margin-top:12px; border-top:1px solid #e5eded; padding-top:10px; } summary { cursor:pointer; font-size:12px; color:#526f76; }
      label { display:block; margin-top:10px; font-size:12px; } input,select { display:block; width:100%; margin-top:4px; padding:7px; border:1px solid #cddbdc; border-radius:6px; font:inherit; }
      .check { display:flex; align-items:center; gap:7px; } .check input { width:auto; margin:0; } .substatus { display:block; color:#526f76; font-size:12px; margin:0 0 8px; overflow-wrap:anywhere; }
      small { display:block; color:#637b80; font-size:11px; margin-top:8px; } #save { background:#edf3f4; margin-top:10px; width:100%; }
      [hidden] { display:none !important; } .collapse { background:none; color:#637b80; padding:0 4px; font-size:18px; }
      .panel.compact { width:auto; padding:10px 14px; } .compact .body,.compact .badge { display:none; }
    </style>
    <section class="panel" aria-label="学习通自动下一节">
      <header><strong>自动下一节</strong><span class="badge">已暂停</span><button class="collapse" title="收起或展开" aria-label="收起或展开">−</button></header>
      <div class="body">
        <p id="status" role="status" aria-live="polite">正在初始化…</p>
        <span id="speed-status" class="substatus" role="status">自动倍速：默认尝试 2×</span>
        <span id="quiz-status" class="substatus" role="status">视频弹题：等待弹题</span>
        <span id="play-status" class="substatus" role="status">自动播放：等待视频</span>
        <button id="toggle" disabled>启用自动切换</button>
        <details><summary>播放、弹题与切换设置</summary>
          <label class="check"><input id="auto-play" type="checkbox" checked>自动点击视频播放</label>
          <label class="check"><input id="auto-quiz" type="checkbox" checked>视频弹题自动尝试选项</label>
          <label class="check"><input id="auto-speed" type="checkbox" checked>自动设置倍速（不生效时保持平台速度）</label>
          <label>目标倍速<select id="speed"><option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="1.75">1.75×</option><option value="2" selected>2×（默认）</option><option value="2.5">2.5×</option><option value="3">3×</option><option value="4">4×</option></select></label>
          <label>下一节按钮的 CSS 选择器（留空自动识别）<input id="selector" type="text" placeholder="自动识别“下一节”按钮" autocomplete="off"></label>
          <button id="save">保存设置</button>
          <small>视频和课件任务点完成后切换。章节题目可以略过，空白页直接切换。</small>
        </details>
      </div>
    </section>`;
  document.documentElement.appendChild(host);
  const get = selector => root.querySelector(selector);
  const status = text => { if (get("#status").textContent !== text) get("#status").textContent = text; };
  const render = () => {
    get(".badge").textContent = enabled ? "已启用" : "已暂停";
    get("#toggle").textContent = enabled ? "暂停自动切换" : "启用自动切换";
    if (!enabled) {
      get("#speed-status").textContent = "自动设置倍速已暂停";
      get("#quiz-status").textContent = "视频弹题自动尝试已暂停";
      get("#play-status").textContent = "自动播放已暂停";
    }
  };
  const request = async message => {
    const response = await chrome.runtime.sendMessage(message);
    if (response?.error && !Array.isArray(response)) throw new Error(response.error);
    return response;
  };
  const save = () => {
    const message = { type: "CX_SAVE", course, enabled, preferences: { ...preferences } };
    saveQueue = saveQueue.catch(() => {}).then(() => request(message));
    saveQueue.catch(() => status("设置保存失败，请刷新页面后重试。"));
    return saveQueue;
  };
  const invalidate = () => {
    generation++;
    if (lastJump) lastJump.confirmUntil = 0;
    render();
  };

  get(".collapse").addEventListener("click", () => {
    const compact = get(".panel").classList.toggle("compact");
    get(".collapse").textContent = compact ? "+" : "−";
  });
  get("#toggle").addEventListener("click", () => {
    enabled = !enabled;
    if (enabled) { speedRevision++; quizRevision++; playRevision++; }
    invalidate();
    save();
    status(enabled ? "已启用，正在检测当前视频…" : "已暂停，可手动继续学习。");
    if (enabled) tick();
  });
  get("#save").addEventListener("click", () => {
    const selector = get("#selector").value.trim();
    try { if (selector) document.querySelector(selector); }
    catch { return status("CSS 选择器格式不正确，设置未保存。"); }
    const options = Object.fromEntries(Object.entries(checkboxes).map(([name, path]) => [name, get(path).checked]));
    if (options.autoQuiz !== preferences.autoQuiz) quizRevision++;
    if (options.autoPlay !== preferences.autoPlay) playRevision++;
    preferences = { ...options, selector, speed: Number(get("#speed").value) };
    speedRevision++;
    invalidate();
    save();
    status("设置已保存。");
    if (enabled) tick();
  });

  const sendNext = (target, confirmation = false) => request({ type: "CX_NEXT", course,
    epoch: target.epoch, documentId: target.documentId, id: target.id, selector: preferences.selector, confirmation });

  async function tick() {
    if (!enabled) return;
    if (active) {
      checkAgain = true;
      return;
    }
    active = true;
    const ticket = generation;
    try {
      await saveQueue;
      if (!enabled || ticket !== generation) return;
      const frames = await request({ type: "CX_COLLECT", course, selector: preferences.selector,
        speed: { enabled: preferences.autoSpeed, rate: preferences.speed, revision: `${runId}:${speedRevision}` },
        quiz: { enabled: preferences.autoQuiz, revision: `${runId}:${quizRevision}` },
        playback: { enabled: preferences.autoPlay, revision: `${runId}:${playRevision}` } });
      if (!enabled || ticket !== generation) return;
      get("#speed-status").textContent = globalThis.CxAutoSpeed.summary(frames, preferences.autoSpeed);
      get("#quiz-status").textContent = globalThis.CxVideoQuiz.summary(frames, preferences.autoQuiz);
      get("#play-status").textContent = globalThis.CxAutoPlayback.summary(frames, preferences.autoPlay);
      const result = core.assess(frames);
      if (lastJump && result.eligible && result.signature === lastJump.signature) {
        // This prompt belongs to a jump we started from the same eligible page.
        if (result.confirmation && Date.now() <= lastJump.confirmUntil) {
          lastJump.confirmUntil = 0;
          const response = await sendNext(result.confirmation, true);
          if (!enabled || ticket !== generation) return;
          status(response?.clicked ? "已确认下一节，等待跳转…" : "提示按钮已变化，请手动检查。");
        } else status(result.blockedConfirmation ? "学习通提示还有任务未完成，已停留在本节。" : "已点击下一节，等待页面更新…");
        return;
      }
      if (!result.ready) {
        status(result.status);
        return;
      }
      lastJump = { signature: result.signature, confirmUntil: 0 };
      const response = await sendNext(result.target);
      if (!enabled || ticket !== generation) return;
      if (response?.clicked) {
        lastJump.confirmUntil = Date.now() + 20000;
        checkAgain = true;
      }
      status(response?.clicked ? "已点击下一节，等待页面更新…" : "按钮状态发生变化，本节已停止自动切换。请手动检查。");
    } catch {
      status("扩展连接中断，请刷新课程页面；如刚更新扩展，请重新启用。");
    } finally {
      active = false;
      render();
      if (checkAgain) {
        checkAgain = false;
        void tick();
      }
    }
  }

  request({ type: "CX_LOAD", course }).then(saved => {
    enabled = Boolean(saved.enabled);
    preferences.selector = typeof saved.preferences?.selector === "string" ? saved.preferences.selector : "";
    preferences.speed = globalThis.CxAutoSpeed.rates.includes(saved.preferences?.speed) ? saved.preferences.speed : 2;
    const options = saved.preferences || {};
    for (const [name, path] of Object.entries(checkboxes)) {
      preferences[name] = typeof options[name] === "boolean" ? options[name] : true;
      get(path).checked = preferences[name];
    }
    get("#selector").value = preferences.selector;
    get("#speed").value = String(preferences.speed);
    get("#toggle").disabled = false;
    render();
    status(enabled ? "已恢复启用状态，正在检测课程…" : "打开课程章节，点击启用后自动处理播放与切换。");
    chrome.runtime.onMessage.addListener(message => {
      if (message?.type === "CX_CHECK") void tick();
    });
    window.addEventListener("load", tick, true);
    tick();
    setInterval(tick, 1500);
  }).catch(() => status("扩展初始化失败，请刷新课程页面。"));
})();
