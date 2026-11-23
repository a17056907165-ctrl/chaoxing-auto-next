// Prefer the requested HTML5 rate; incomplete menus must not lower that target.
// A rejected/reset target gets at most one lower-menu fallback per source/revision.
(() => {
  "use strict";
  const states = new WeakMap();
  const near = (a, b) => Math.abs(a - b) < 0.01;
  const rates = [1.25, 1.5, 1.75, 2, 2.5, 3, 4];

  function playerScope(video, doc) {
    const player = video.closest?.('.video-js, [data-video-player], .video-player, .ans-video, .vjs-player');
    if (player) return player;
    const parent = video.parentElement;
    if (parent?.querySelectorAll?.('video').length === 1) return parent;
    // With several unwrapped videos there is no reliable owner for a shared menu.
    return doc.querySelectorAll('video').length === 1 ? doc : null;
  }

  function displayed(element, doc, scope) {
    for (let node = element; node; node = node.parentElement) {
      const style = doc.defaultView.getComputedStyle(node);
      if (node.hidden || node.getAttribute?.('aria-hidden') === 'true' || style.display === 'none' ||
        ['hidden', 'collapse'].includes(style.visibility)) return false;
      if (node === scope) break;
    }
    return true;
  }

  function restriction(scope, doc) {
    if (!scope) return false;
    const controls = [...scope.querySelectorAll('.vjs-playback-rate')];
    const usable = element => !element.matches('[disabled], [aria-disabled="true"], .disabled, .vjs-disabled, .vjs-hidden') &&
      displayed(element, doc, scope);
    if (controls.length && !controls.some(usable)) return true;
    const hints = scope.querySelectorAll('[title], [aria-label], [data-original-title], .vjs-playback-rate');
    return [...hints].some(element => {
      if (!displayed(element, doc, scope)) return false;
      const text = `${element.title || ""} ${element.getAttribute("aria-label") || ""} ${element.getAttribute("data-original-title") || ""} ${element.textContent || ""}`;
      return text.length < 300 && /(?:不可|不能|禁止|不支持|不允许|无法|未开放)倍速/.test(text.replace(/\s/g, ""));
    });
  }

  function lowerMenuRate(scope, requested) {
    if (!scope) return null;
    const menuRates = [...scope.querySelectorAll('.vjs-playback-rate .vjs-menu-item')].flatMap(element => {
      const labels = ['data-rate', 'data-value', 'aria-label', 'title']
        .map(name => element.getAttribute?.(name) || '').concat(element.textContent || '');
      return labels.flatMap(label => {
        const plain = String(label).trim();
        if (/^\d+(?:\.\d+)?$/.test(plain)) return [Number(plain)];
        return [...plain.matchAll(/(\d+(?:\.\d+)?)\s*[xX×倍]/g)].map(match => Number(match[1]));
      });
    }).filter(rate => Number.isFinite(rate) && rate > 1 && rate < requested && !near(rate, requested));
    return menuRates.length ? Math.max(...menuRates) : null;
  }

  function update(doc, settings = {}) {
    const enabled = settings.enabled === true;
    const requested = rates.includes(settings.rate) ? settings.rate : 2;
    return [...doc.querySelectorAll("video")].map(video => {
      const actual = () => Number(video.playbackRate) || 1;
      if (!enabled) {
        states.delete(video);
        return { status: "off", rate: actual() };
      }
      const source = video.currentSrc || video.src || video.querySelector("source")?.src || "";
      const key = JSON.stringify([source, requested, settings.revision]);
      let state = states.get(video);
      if (!state || state.key !== key) {
        state = { key, attempted: false, fallbackAttempted: false, applied: null, status: "waiting" };
        states.set(video, state);
      }
      const scope = playerScope(video, doc);
      const blocked = restriction(scope, doc);
      const accept = () => {
        state.applied = actual();
        state.status = state.applied > 1 ? "checking" : "blocked";
      };
      const fallback = () => {
        if (state.fallbackAttempted || blocked || video.paused || video.ended || video.error) return false;
        state.fallbackAttempted = true;
        // Keep an accepted lower rate from player clamping instead of writing again.
        if (actual() > 1) return false;
        const lower = lowerMenuRate(scope, requested);
        if (!lower) return false;
        try {
          video.playbackRate = lower;
          accept();
          return actual() > 1;
        } catch { return false; }
      };
      if (state.attempted) {
        const rate = actual();
        if (state.applied !== null && !near(rate, state.applied)) {
          state.status = "blocked";
          fallback();
        }
        else if (state.status === "checking") state.status = near(rate, requested) ? "applied" : "limited";
        return { status: state.status, rate: actual() };
      }
      if (blocked) {
        // A delayed player menu may become available later; no rate write was made.
        state.status = "blocked";
        return { status: "blocked", rate: actual() };
      }
      // Wait until playback: some players reset speed during initialization.
      if (video.readyState < 1 || video.paused || video.ended || video.error) {
        return { status: "waiting", rate: actual() };
      }
      state.attempted = true;
      try {
        if (!near(actual(), requested)) video.playbackRate = requested;
        accept();
        if (state.applied <= 1) fallback();
      } catch {
        state.status = "blocked";
        if (actual() > 1) accept();
        else fallback();
      }
      return { status: state.status, rate: actual() };
    });
  }

  function summary(frames, enabled) {
    if (!enabled) return "自动倍速已关闭";
    const paired = frames.flatMap(frame => (frame.snapshot?.speeds || []).map((result, index) =>
      ({ result, video: frame.snapshot?.videos?.[index] })));
    const unfinished = paired.filter(({ video }) => !(video?.ended || video?.completed || video?.platformCompleted));
    const playing = unfinished.filter(item => item.video?.paused === false);
    const results = (playing.length ? playing : unfinished).map(item => item.result);
    if (paired.length && !results.length) return "本节视频已结束";
    if (!results.length) return "自动倍速：等待视频";
    if (results.some(result => result.status === "checking")) return "自动倍速：正在确认是否生效…";
    const active = results.filter(result => ["applied", "limited", "blocked"].includes(result.status));
    if (!active.length) return "自动倍速：开始播放后尝试设置";
    const actual = [...new Set(active.map(result => `${result.rate}×`))].join(" / ");
    return active.some(result => result.status === "blocked")
      ? `倍速受限或被恢复，保持播放器当前速度（${actual}）`
      : `当前倍速：${actual}`;
  }
  globalThis.CxAutoSpeed = { update, summary, rates };
})();
