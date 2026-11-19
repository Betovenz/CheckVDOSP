// RedNote Helper - Injected Script (runs in MAIN world to intercept RedNote's API responses)
(() => {
  "use strict";

  if (window.__RH_INJECTED__) return;
  window.__RH_INJECTED__ = true;

  window.__RH_MEDIA_CACHE__ = {};

  function extractStreams(videoObj) {
    if (!videoObj) return null;
    const streams = videoObj.media?.stream || {};
    let candidates = [];
    for (const [group, lst] of Object.entries(streams)) {
      if (!Array.isArray(lst)) continue;
      for (const s of lst) {
        const u = s?.masterUrl || (s?.backupUrls && s.backupUrls[0]) || "";
        if (!u) continue;
        const codec = `${s.videoCodec || ""} ${group}`.toLowerCase();
        const isH264 = codec.includes("264") || codec.includes("avc");
        const size = s.size || 0;
        candidates.push({ isH264, size, url: u });
      }
    }
    if (candidates.length > 0) {
      candidates.sort((a, b) => {
        if (a.isH264 !== b.isH264) return a.isH264 ? -1 : 1;
        return a.size - b.size;
      });
      return candidates[0].url.replace(/^http:\/\//, "https://");
    }
    const originKey = videoObj.consumer?.originVideoKey;
    if (originKey) {
      return `https://sns-video-bd.xhscdn.com/${originKey}`;
    }
    return null;
  }

  function processNoteItem(note, noteId) {
    if (!note) return;
    const nid = (noteId || note.noteId || note.id || "").toLowerCase();
    if (!nid || nid.length < 16) return;

    const title = (note.title || note.desc || "").trim() || `RedNote_${nid}`;
    const videoUrl = extractStreams(note.video);
    const images = (note.imageList || note.imagesList || [])
      .map((img) => img.urlDefault || img.urlPre || img.url)
      .filter(Boolean);

    const data = {
      noteId: nid,
      title: title.slice(0, 70),
      type: videoUrl ? "video" : (images.length ? "image" : "unknown"),
      videoUrl: videoUrl,
      images: images,
    };

    window.__RH_MEDIA_CACHE__[nid] = data;
    window.postMessage({ type: "__RH_MEDIA_CAPTURED__", item: data }, "*");
  }

  function scanData(obj) {
    if (!obj || typeof obj !== "object") return;

    if (obj.noteCard || obj.note_card) {
      processNoteItem(obj.noteCard || obj.note_card, obj.id);
    }
    if (obj.note && (obj.note.video || obj.note.imageList)) {
      processNoteItem(obj.note, obj.note.noteId || obj.id);
    }
    if (obj.video || obj.imageList) {
      processNoteItem(obj, obj.noteId || obj.id);
    }

    if (Array.isArray(obj.items)) obj.items.forEach(scanData);
    if (Array.isArray(obj.notes)) obj.notes.forEach(scanData);
    if (Array.isArray(obj.feeds)) obj.feeds.forEach(scanData);
    if (Array.isArray(obj.data)) obj.data.forEach(scanData);
    if (obj.noteDetailMap && typeof obj.noteDetailMap === "object") {
      for (const [k, v] of Object.entries(obj.noteDetailMap)) {
        processNoteItem(v.note || v, k);
      }
    }
  }

  // Intercept window.fetch
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const resp = await origFetch.apply(this, args);
    try {
      const url = typeof args[0] === "string" ? args[0] : args[0]?.url || "";
      if (
        url.includes("/api/sns/web/") ||
        url.includes("/feed") ||
        url.includes("/search/notes") ||
        url.includes("/item/")
      ) {
        const clone = resp.clone();
        clone
          .json()
          .then((json) => {
            if (json?.data) scanData(json.data);
            else scanData(json);
          })
          .catch(() => {});
      }
    } catch (e) {}
    return resp;
  };

  // Intercept XMLHttpRequest
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._rh_url = url;
    return origOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener("load", function () {
      try {
        if (
          this._rh_url &&
          (this._rh_url.includes("/api/sns/web/") ||
            this._rh_url.includes("/feed") ||
            this._rh_url.includes("/search/notes") ||
            this._rh_url.includes("/item/"))
        ) {
          const json = JSON.parse(this.responseText);
          if (json?.data) scanData(json.data);
          else scanData(json);
        }
      } catch (e) {}
    });
    return origSend.apply(this, args);
  };

  // Scan window.__INITIAL_STATE__ periodically
  function scanInitialState() {
    try {
      const s = window.__INITIAL_STATE__;
      if (!s) return;
      if (s.search?.feeds) scanData(s.search.feeds);
      if (s.feed?.feeds) scanData(s.feed.feeds);
      if (s.note?.noteDetailMap) scanData(s.note.noteDetailMap);
    } catch (e) {}
  }

  setInterval(scanInitialState, 1500);
  scanInitialState();

  console.log("[RedNote Helper] Injected API interceptor active.");
})();
