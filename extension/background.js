"use strict";
importScripts("core.js");
const { isVideoCompleted, isVideoPlayed } = globalThis.CxAutoNext;
const allowed = url => {
  try {
    const parsed = new URL(url);
    return ["http:", "https:"].includes(parsed.protocol) &&
      (parsed.hostname === "chaoxing.com" || parsed.hostname.endsWith(".chaoxing.com"));
  } catch { return false; }
};
const keyFor = (tabId, course) => `cx-next:${tabId}:${course}`;
const guardKeyFor = tabId => `cx-next-guard:${tabId}`;
const controlQueues = new Map();

function courseFor(message, sender) {
  if (typeof message.course === "string" && message.course) return message.course;
  const url = new URL(sender.url);
  return url.searchParams.get("courseid") || url.searchParams.get("courseId") || `${url.hostname}${url.pathname}`;
}

async function broadcastGuard(tabId, control) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "CX_GUARD", epoch: control.epoch, enabled: control.enabled });
  } catch { /* A page may be navigating before its content script is available. */ }
}

function writeControl(tabId, course, enabled) {
  const previous = controlQueues.get(tabId) || Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    const guardKey = guardKeyFor(tabId);
    const courseKey = keyFor(tabId, course);
    const saved = await chrome.storage.session.get([guardKey, courseKey]);
    const control = { course,
      enabled: enabled === undefined ? Boolean(saved[courseKey]?.enabled) : Boolean(enabled),
      epoch: Math.max(Date.now(), (Number(saved[guardKey]?.epoch) || 0) + 1) };
    await chrome.storage.session.set({ [guardKey]: control, [courseKey]: { enabled: control.enabled } });
    await broadcastGuard(tabId, control);
    return control;
  });
  controlQueues.set(tabId, operation);
  return operation;
}

async function readControl(tabId, course) {
  await controlQueues.get(tabId)?.catch(() => {});
  const key = guardKeyFor(tabId);
  const saved = await chrome.storage.session.get(key);
  if (saved[key]) return saved[key];
  // Older installed versions may only have the course activation record.
  return await writeControl(tabId, course, undefined);
}

const canAct = (control, course, epoch) => control.enabled && control.course === course && control.epoch === epoch;

function chapterScope(course, sender, frames) {
  const fieldsFor = url => new Map([...url.searchParams].map(([name, value]) => [name.toLowerCase(), value]));
  const fields = fieldsFor(new URL(sender.url));
  const chapters = new Set();
  for (const frame of frames) {
    const url = new URL(frame.url);
    if (!/\/knowledge\/cards\/?$/i.test(url.pathname)) continue;
    const params = fieldsFor(url);
    const chapter = params.get("knowledgeid") || params.get("chapterid");
    if (chapter) chapters.add(chapter);
  }
  // Same-document navigation can replace the cards without changing the outer URL.
  if (chapters.size > 1) return null;
  const chapter = [...chapters][0] || fields.get("chapterid") || fields.get("knowledgeid");
  return chapter ? JSON.stringify([course, fields.get("clazzid") || "", fields.get("cpi") || "", chapter]) : null;
}

function inheritVideoTasks(frames) {
  for (const parent of frames) {
    const attachments = parent.snapshot?.videoAttachments || [];
    for (const task of attachments) {
      if (!task.required || !task.url || attachments.filter(item => item.url === task.url).length !== 1) continue;
      const viewers = frames.filter(frame => frame.parentFrameId === parent.frameId &&
        frame.url?.split('#', 1)[0] === task.url);
      if (viewers.length !== 1) continue;
      for (const viewer of viewers) {
        for (const video of viewer.snapshot?.videos || []) {
          video.taskRequired = true;
          if (task.completed) video.platformCompleted = true;
        }
        viewers.push(...frames.filter(frame => frame.parentFrameId === viewer.frameId));
      }
    }
  }
}

async function readProgress(course, sender, frames) {
  const scope = chapterScope(course, sender, frames);
  const counts = new Map();
  for (const frame of frames) {
    for (const video of frame.snapshot?.videos || []) {
      if (video.completionKey) counts.set(video.completionKey, (counts.get(video.completionKey) || 0) + 1);
    }
  }

  const byDocument = new Map();
  const keys = [];
  for (const frame of frames) {
    const links = [];
    for (const video of frame.snapshot?.videos || []) {
      if (video.taskRequired || !scope || counts.get(video.completionKey) !== 1) continue;
      const storageKey = `cx-video-done:${scope}:${video.completionKey}`;
      links.push({ id: video.id, completionKey: video.completionKey, storageKey });
      keys.push(storageKey);
    }
    byDocument.set(frame.documentId, links);
  }
  const saved = keys.length ? await chrome.storage.local.get(keys).catch(() => ({})) : {};
  for (const frame of frames) {
    for (const video of frame.snapshot?.videos || []) {
      const link = byDocument.get(frame.documentId).find(item => item.id === video.id);
      if (link && saved[link.storageKey] === true) video.completed = true;
    }
  }
  return byDocument;
}

async function frameSnapshot(tabId, frame, message) {
  const snapshot = await chrome.tabs.sendMessage(tabId, message, { documentId: frame.documentId });
  if (!Array.isArray(snapshot?.videos)) throw new Error("No snapshot");
  return snapshot;
}

function unloadedPlayer(frame, frames) {
  if (!frame.snapshot) return null;
  const children = frames.filter(child => child.parentFrameId === frame.frameId);
  const loaded = candidate => Boolean(candidate.snapshot?.videos.length) ||
    frames.some(child => child.parentFrameId === candidate.frameId && loaded(child));
  const available = children.filter(loaded);
  for (const attachment of frame.snapshot.videoAttachments || []) {
    const index = available.findIndex(child => child.url.split('#', 1)[0] === attachment.url);
    if (index >= 0) available.splice(index, 1);
    else if (!attachment.completed) return attachment;
  }
  if (frame.snapshot.unloadedVideo || (frame.snapshot.playerDocument && !loaded(frame))) return {};
  return null;
}

function nextDocument(frames) {
  for (const host of frames) {
    const tasks = host.snapshot?.documentTasks || [];
    const task = tasks.find(item => !item.completed);
    if (!task) continue;
    const viewers = task.url ? frames.filter(frame =>
      frame.parentFrameId === host.frameId && frame.url.split('#', 1)[0] === task.url) : [];
    const viewer = viewers.length === 1 && tasks.filter(item => item.url === task.url).length === 1 ? viewers[0] : null;
    let scrollFrame;
    if (viewer) {
      const queue = [viewer];
      for (const frame of queue) {
        if (!frame.snapshot?.hasInnerPreview && (frame === viewer || frame.snapshot?.documentViewer)) scrollFrame = frame;
        queue.push(...frames.filter(child => child.parentFrameId === frame.frameId));
      }
    }
    return { id: task.id, hostId: host.documentId, viewerId: scrollFrame?.documentId };
  }
}

async function handle(message, sender) {
  if (message.type === "CX_VIDEO_ENDED") {
    if (!sender.tab || !(allowed(sender.url) || allowed(sender.origin))) return { ok: false };
    const tabId = sender.tab.id;
    await controlQueues.get(tabId)?.catch(() => {});
    const key = guardKeyFor(tabId);
    const saved = await chrome.storage.session.get(key);
    const control = saved[key];
    if (!control?.enabled || control.epoch !== message.epoch) return { ok: false };
    await chrome.tabs.sendMessage(tabId, { type: "CX_CHECK" }, { frameId: 0 }).catch(() => {});
    return { ok: true };
  }
  if (sender.frameId !== 0 || !sender.tab || !allowed(sender.url)) throw new Error("Unsupported sender");
  const tabId = sender.tab.id;
  const course = courseFor(message, sender);
  if (message.type === "CX_LOAD") {
    const control = await writeControl(tabId, course, undefined);
    const preferencesKey = `cx-next-preferences:${course}`;
    const defaults = await chrome.storage.local.get(preferencesKey);
    return { enabled: control.enabled, epoch: control.epoch, preferences: defaults[preferencesKey] || {} };
  }
  if (message.type === "CX_SAVE") {
    const control = await writeControl(tabId, course, Boolean(message.enabled));
    await chrome.storage.local.set({ [`cx-next-preferences:${course}`]: message.preferences });
    return { ok: true, epoch: control.epoch };
  }
  if (message.type === "CX_COLLECT") {
    const initial = await readControl(tabId, course);
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    const eligible = (frames || []).filter(frame => {
      if (frame.url === "about:blank" || frame.url === "about:srcdoc") return true;
      return allowed(frame.url) && (frame.frameId === 0 || !/\.(?:pdf|docx?|pptx?|xlsx?)$/i.test(new URL(frame.url).pathname));
    });
    // Inspect every player before starting any of them, including cross-origin
    // frames. Only one unfinished video is selected for this collection round.
    const inspected = await Promise.all(eligible.map(async frame => {
      try {
        const snapshot = await frameSnapshot(tabId, frame, { type: "CX_INSPECT" });
        return { ...frame, snapshot };
      } catch { return { ...frame, error: true }; }
    }));
    // Empty helper frames may have no content script. Declared player iframes
    // are still tracked from their parent until their video loads.
    const discovered = inspected.filter(frame => !(frame.error && frame.frameId !== 0 && frame.url === "about:blank"));
    inheritVideoTasks(discovered);
    const progress = await readProgress(course, sender, discovered);
    const queue = discovered.filter(frame => !frame.error).sort((left, right) => left.frameId - right.frameId)
      .flatMap(frame => frame.snapshot.videos.filter(video => !isVideoPlayed(video)).map(video => ({ ...video, documentId: frame.documentId })));
    const selected = queue.find(video => video.paused === false) || queue[0];
    const waitingPlayers = discovered.map(frame => ({ frame, pending: unloadedPlayer(frame, discovered) }))
      .filter(item => item.pending);
    const quizActive = discovered.some(frame => frame.snapshot?.quiz?.active || frame.snapshot?.activeVideoQuiz);
    // A pause may arrive during discovery. Check it once before dispatching this batch.
    const control = await readControl(tabId, course);
    const authorized = canAct(control, course, initial.epoch);
    const reveal = authorized && !selected && !quizActive && message.playback?.enabled
      ? waitingPlayers.find(item => item.pending.id) : null;
    const reading = authorized && !quizActive && !waitingPlayers.length &&
      discovered.every(frame => frame.snapshot?.videos.every(isVideoCompleted))
      ? nextDocument(discovered) : null;
    const finished = {};
    const collected = await Promise.all(discovered.map(async frame => {
      try {
        const links = progress.get(frame.documentId) || [];
        const snapshot = await frameSnapshot(tabId, frame,
          { type: "CX_SNAPSHOT", selector: message.selector || "", epoch: control.epoch,
            enabled: control.enabled, inspectionOnly: !authorized,
            progress: authorized ? links : [],
            revealVideo: reveal && reveal.frame.documentId === frame.documentId ? reveal.pending.id : null,
            revealDocument: reading?.hostId === frame.documentId ? reading.id : null,
            readDocument: Boolean(reading?.viewerId && reading.viewerId === frame.documentId),
            speed: authorized ? message.speed : { enabled: false },
            quiz: authorized ? message.quiz : { enabled: false },
            playback: authorized ? { ...message.playback, activeVideoId: selected?.documentId === frame.documentId ? selected.id : null,
              quizActive } : { enabled: false } });
        const before = frame.snapshot?.videos || [];
        for (const video of snapshot.videos) {
          const prior = before.find(item => item.id === video.id && item.completionKey === video.completionKey);
          if (prior?.completed) video.completed = true;
          const link = links.find(item => item.id === video.id && item.completionKey === video.completionKey);
          if (authorized && link && !prior?.completed && (video.ended || prior?.ended)) finished[link.storageKey] = true;
        }
        return { frameId: frame.frameId, parentFrameId: frame.parentFrameId, documentId: frame.documentId,
          url: frame.url, epoch: control.epoch, snapshot };
      } catch {
        return { frameId: frame.frameId, documentId: frame.documentId, error: true };
      }
    }));
    inheritVideoTasks(collected);
    for (const frame of collected) {
      frame.snapshot?.playback?.forEach((_item, index, playback) => {
        const video = frame.snapshot.videos[index];
        if (video && isVideoPlayed(video)) playback[index] = { status: "ended" };
      });
    }
    if (Object.keys(finished).length) await chrome.storage.local.set(finished).catch(() => {});
    return collected.map(frame => frame.error ? frame : { ...frame, pendingVideo: Boolean(unloadedPlayer(frame, collected)) });
  }
  if (message.type === "CX_NEXT") {
    if (typeof message.documentId !== "string") throw new Error("Missing document");
    const control = await readControl(tabId, course);
    if (!canAct(control, course, message.epoch)) return { clicked: false };
    return await chrome.tabs.sendMessage(tabId,
      { type: "CX_CLICK", id: message.id, selector: message.selector || "", epoch: control.epoch,
        confirmation: message.confirmation === true }, { documentId: message.documentId });
  }
  throw new Error("Unknown request");
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!["CX_LOAD", "CX_SAVE", "CX_COLLECT", "CX_NEXT", "CX_VIDEO_ENDED"].includes(message?.type)) return false;
  handle(message, sender).then(respond, error => respond({ error: error.message }));
  return true;
});

chrome.tabs.onRemoved.addListener(async tabId => {
  await controlQueues.get(tabId)?.catch(() => {});
  const values = await chrome.storage.session.get(null);
  const keys = Object.keys(values).filter(key => key.startsWith(`cx-next:${tabId}:`) || key === guardKeyFor(tabId));
  if (keys.length) await chrome.storage.session.remove(keys);
  controlQueues.delete(tabId);
});
