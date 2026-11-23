// Start a new video through its player control, then the standard HTML5 API.
// Videos are queued, including an optional selection made across player frames.
// A manual pause stays paused; a successfully handled video quiz grants one resume.
(() => {
  "use strict";
  const states = new WeakMap();
  const documents = new WeakMap();
  const PLAY_TIMEOUT_MS = 1500;
  const controlSelector = '.vjs-big-play-button, .vjs-play-control, button, [role="button"], [aria-label], [title]';
  const sourceFor = video => video.currentSrc || video.src || video.querySelector("source")?.src || "";

  function visible(element) {
    if (!element || !element.isConnected || !element.getClientRects().length) return false;
    const view = element.ownerDocument.defaultView;
    for (let current = element; current; current = current.parentElement) {
      const style = view.getComputedStyle(current);
      if (current.hidden || current.getAttribute("aria-hidden") === "true" ||
        style.display === "none" || ["hidden", "collapse"].includes(style.visibility)) return false;
    }
    return true;
  }

  function playControl(video) {
    const container = video.closest('.video-js, [data-video-player], .video-player, .ans-video, .vjs-player') || video.parentElement;
    if (!container) return null;
    // A shared wrapper cannot tell us which generic button belongs to this video.
    // Use that video's native API instead of risking a click on another player.
    if (container.querySelectorAll('video').length > 1) return null;
    return [...container.querySelectorAll(controlSelector)].find(element => {
      if (!visible(element) || element.disabled || element.closest('[disabled], [aria-disabled="true"], [inert], .disabled, .vjs-disabled')) return false;
      const labels = [element.getAttribute("aria-label"), element.title, element.textContent]
        .filter(Boolean).map(label => String(label).trim());
      if (labels.some(label => /暂停|\bpause\b/i.test(label))) return false;
      return element.matches('.vjs-big-play-button, .vjs-play-control') ||
        labels.some(label => /^(?:播放|播放视频|开始播放|继续播放|play(?: video)?|start playback)$/i.test(label));
    }) || null;
  }

  function contextFor(doc, settings) {
    const key = JSON.stringify([settings.enabled === true, settings.revision]);
    let context = documents.get(doc);
    if (!context || context.key !== key) {
      context = { key, enabled: settings.enabled === true, quizActive: false,
        solvedLatch: false, resume: 0, selectedVideo: null, token: {} };
      documents.set(doc, context);
    }
    const quizActive = settings.quizActive === true;
    if (context.quizActive !== quizActive) {
      context.quizActive = quizActive;
      context.token = {};
    }
    if (settings.quizSolved === true && !context.solvedLatch) {
      context.resume++;
      context.token = {};
    }
    context.solvedLatch = settings.quizSolved === true;
    return context;
  }

  async function settlePlay(promise) {
    let timer;
    try {
      return await Promise.race([
        Promise.resolve(promise).then(() => "resolved", () => "rejected"),
        new Promise(resolve => { timer = setTimeout(() => resolve("timeout"), PLAY_TIMEOUT_MS); })
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  function stop(doc) {
    const context = documents.get(doc);
    if (context) {
      context.enabled = false;
      context.token = {};
    }
    documents.delete(doc);
    for (const video of doc.querySelectorAll("video")) states.delete(video);
  }

  async function update(doc, settings = {}) {
    const context = contextFor(doc, settings);
    const videos = [...doc.querySelectorAll("video")];
    const externalSelection = Object.prototype.hasOwnProperty.call(settings, "activeVideoId");
    let selectedIndex = -1;
    if (externalSelection) {
      if (typeof settings.activeVideoId === "string" && Array.isArray(settings.videoIds)) {
        selectedIndex = videos.findIndex((_video, index) =>
          typeof settings.videoIds[index] === "string" && settings.videoIds[index] === settings.activeVideoId);
      }
    } else {
      // Preserve a video already playing (including one started by the user).
      // Otherwise the first unfinished video holds the queue, even if paused.
      selectedIndex = videos.findIndex(video => !video.ended && !video.paused);
      if (selectedIndex < 0) selectedIndex = videos.findIndex(video => !video.ended);
    }
    const selectedVideo = videos[selectedIndex] || null;
    if (context.selectedVideo !== selectedVideo) {
      context.selectedVideo = selectedVideo;
      context.token = {};
    }
    const token = context.token;
    return await Promise.all(videos.map(async video => {
      if (!context.enabled) {
        states.delete(video);
        return { status: "off" };
      }
      if (video.ended) return { status: "ended" };
      // Do not mark queued players as attempted: each gets its first normal
      // start only after the selected player has genuinely finished.
      if (video !== selectedVideo) return { status: "queued" };
      if (context.quizActive) return { status: "waiting", reason: "quiz" };
      const source = sourceFor(video);
      const key = JSON.stringify([source, context.key, context.resume]);
      let state = states.get(video);
      if (!state || state.key !== key) {
        state = { key, attempted: false, status: "waiting", pending: null };
        states.set(video, state);
      }
      if (state.pending) return await state.pending;
      if (video.error) return { status: "blocked", reason: "media-error" };
      if (!video.paused) {
        state.attempted = true;
        state.status = "playing";
        return { status: "playing" };
      }
      if (state.attempted) return { status: state.status === "blocked" ? "blocked" : "paused" };
      const control = playControl(video);
      if (!control && !visible(video)) return { status: "waiting", reason: "hidden" };
      // Some players only assign the video source after their visible play button is clicked.
      if (!control && video.readyState < 1) return { status: "waiting", reason: "loading" };
      state.attempted = true;
      const current = () => documents.get(doc) === context && context.token === token && context.enabled &&
        !context.quizActive && context.selectedVideo === video && states.get(video) === state &&
        video.isConnected && sourceFor(video) === source;
      const cancelled = () => ({ status: documents.get(doc)?.enabled ? "waiting" : "off", reason: "cancelled" });
      state.pending = (async () => {
        try {
          if (!current()) return cancelled();
          if (control) {
            try { control.click(); } catch { /* The native API remains available. */ }
          }
          if (!current()) return cancelled();
          let outcome = "resolved";
          if (video.paused) outcome = await settlePlay(video.play());
          if (!current()) return cancelled();
          if (!video.paused) {
            state.status = "started";
            return { status: "started" };
          }
          state.status = "blocked";
          return { status: "blocked", reason: outcome === "timeout" ? "timeout" : "autoplay" };
        } catch {
          if (!current()) return cancelled();
          state.status = "blocked";
          return { status: "blocked", reason: "autoplay" };
        }
      })();
      const pending = state.pending;
      try {
        return await pending;
      } finally {
        if (state.pending === pending) state.pending = null;
      }
    }));
  }

  function summary(frames, enabled) {
    if (!enabled) return "自动播放已关闭";
    const results = frames.flatMap(frame => frame.snapshot?.playback || []);
    if (!results.length) return "自动播放：等待视频";
    if (results.some(result => result.status === "blocked")) return "自动播放未成功，请按播放器提示点击播放。";
    if (results.some(result => result.status === "started")) return "已自动点击播放";
    if (results.some(result => result.status === "waiting" && result.reason === "quiz")) return "等待视频弹题处理后继续播放";
    if (results.some(result => result.status === "playing")) return "视频正在播放";
    if (results.some(result => result.status === "paused")) return "视频已暂停；重新启用可尝试播放。";
    if (results.every(result => result.status === "ended")) return "本页视频已结束";
    if (results.some(result => result.status === "queued")) return "视频正在排队，前一个视频结束后继续播放。";
    return "自动播放：等待播放器加载";
  }

  globalThis.CxAutoPlayback = { update, summary, stop };
})();
