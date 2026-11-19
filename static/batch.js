/**
 * ============================================================================
 * PAGE 3: Batch Studio (ทำหลายคลิปในครั้งเดียว)
 * ============================================================================
 * Each project = its own Shopee product + several source clips + script/voice + layout.
 * Script / voice generation, Chinese censor and the MP4 render all reuse page 2:
 * - API endpoints are the same ones page 2 calls.
 * - Preview + render use window.StudioEngine (studio.js): the project is swapped into the
 *   page-2 engine for as long as it is previewed / recorded, then page 2 gets its state back.
 * Projects are saved on the server (data/batch/) so a batch survives refresh / restart.
 */
(function () {
  const E = () => window.StudioEngine;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => (E() ? E().escapeHtml(s) : String(s ?? ""));
  const toast = (msg, loading = false, dur = 3500) => E()?.toast(msg, loading, dur);
  const enc = encodeURIComponent;

  const GEN_CONCURRENCY = 2;
  const SHOPEE_CONCURRENCY = 3;

  const state = {
    loaded: false,
    projects: [],
    defaults: null,
    genQueue: [], // { pid, mode }
    genActive: 0,
    censorQueue: [], // pid
    censorRunning: false,
    renderRunning: false,
    renderStop: false,
    renderQueue: [], // pid
    renderPid: null,
    pv: { pid: null, runtime: null, token: 0, hudRaf: 0, drag: null, loading: false },
    audioPlayer: null,
    audioPid: null,
    saveScopePending: false,
  };

  // ------------------------------------------------------------------ model helpers
  function uid() {
    return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  }
  const byId = (pid) => state.projects.find((p) => p.id === pid);
  const idxOf = (p) => state.projects.indexOf(p);
  const num2 = (n) => String(n).padStart(2, "0");

  function defaultsFromPage2() {
    const d = E().page2Defaults();
    return {
      voice: d.voice,
      speed: d.speed,
      duration: d.duration,
      angle: d.angle,
      template: d.template,
      showHeader: E().get("showHeader") !== false,
      showSub: E().get("showSubtitles") !== false,
      headerY: Number(E().get("headerPosY") ?? 13.5),
      subY: Number(E().get("subPosY") ?? 77),
      censorOn: true,
      randomize: false,
    };
  }

  function newProject(extra = {}) {
    const d = state.defaults;
    return {
      id: uid(),
      createdAt: Date.now(),
      shopeeUrl: "",
      productTitle: "",
      productName: "",
      productDesc: "",
      productImage: "",
      clips: [],
      voice: d.voice,
      speed: d.speed,
      duration: d.duration,
      angle: d.angle,
      template: d.template,
      header: "",
      script: "",
      scenes: [],
      audioDuration: 0,
      hasAudio: false,
      audioVer: 0,
      voiceStale: false,
      voiceNote: "",
      showHeader: d.showHeader,
      showSub: d.showSub,
      headerY: d.headerY,
      subY: d.subY,
      censorOn: d.censorOn,
      st: { shopee: "idle", script: "idle", voice: "idle", render: "idle" },
      err: {},
      outputPath: "",
      cutSegments: null,
      cutKey: "",
      sel: true,
      ...extra,
    };
  }

  // Transient UI-only fields are prefixed with "_" and never saved
  function serialize(p) {
    const out = {};
    Object.keys(p).forEach((k) => {
      if (!k.startsWith("_")) out[k] = p[k];
    });
    out.clips = (p.clips || []).map((c) => {
      const cc = {};
      Object.keys(c).forEach((k) => {
        if (!k.startsWith("_")) cc[k] = c[k];
      });
      return cc;
    });
    return out;
  }

  let saveTimer = null;
  function saveSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 600);
    updateNavCount();
  }
  async function saveNow() {
    clearTimeout(saveTimer);
    try {
      await fetch("/api/batch/projects", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projects: state.projects.map(serialize), defaults: state.defaults }),
      });
    } catch (_) {}
  }

  let loadPromise = null;
  function load() {
    if (!loadPromise) loadPromise = loadOnce();
    return loadPromise;
  }
  async function loadOnce() {
    // page-2 voice list depends on the saved API keys: wait for them before reading defaults
    try {
      await Promise.race([E().configReady, new Promise((r) => setTimeout(r, 4000))]);
    } catch (_) {}
    state.defaults = defaultsFromPage2();
    try {
      const r = await fetch("/api/batch/projects");
      const d = await r.json();
      if (d.defaults && Object.keys(d.defaults).length) state.defaults = { ...state.defaults, ...d.defaults };
      state.projects = (d.projects || []).map((p) => {
        const np = { ...newProject(), ...p };
        np.st = { shopee: "idle", script: "idle", voice: "idle", render: "idle", ...(p.st || {}) };
        np.err = p.err || {};
        // work that was running when the app closed is no longer running
        Object.keys(np.st).forEach((k) => {
          if (np.st[k] === "busy") np.st[k] = "idle";
        });
        np.clips = (np.clips || []).map((c) => ({ ...c, status: c.status === "downloading" || c.status === "uploading" ? "downloading" : c.status }));
        return np;
      });
    } catch (_) {}
    state.loaded = true;
    // resume clip downloads that were interrupted
    state.projects.forEach((p) =>
      p.clips.forEach((c) => {
        if (c.status === "downloading" && c.platform !== "pc") prefetchClip(c);
      })
    );
    renderAll();
  }

  function voiceMeta(value) {
    return E().voiceOptions().find((v) => v.value === value) || { value, label: value, gender: "Male", disabled: false };
  }
  function enabledVoices() {
    return E().voiceOptions().filter((v) => !v.disabled);
  }

  // ------------------------------------------------------------------ derived status
  function footageStatus(p) {
    if (!p.clips.length) return "idle";
    if (p.clips.some((c) => c.status === "downloading" || c.status === "uploading")) return "busy";
    if (p.clips.every((c) => c.status === "error")) return "error";
    return "done";
  }
  function readyClips(p) {
    return p.clips.filter((c) => c.status === "ready");
  }
  function censorStatus(p) {
    if (!p.censorOn) return "skip";
    if (p._censorBusy) return "busy";
    if (p.err.censor) return "error";
    const rc = readyClips(p);
    if (rc.length && rc.every((c) => c.censoredUrl)) return "done";
    return "idle";
  }
  function stepStatus(p, key) {
    if (key === "foot") return footageStatus(p);
    if (key === "censor") return censorStatus(p);
    if (key === "voice" && p.hasAudio && p.voiceStale && p.st.voice !== "busy") return "stale";
    return p.st[key] || "idle";
  }
  function audioUrl(p) {
    return p.hasAudio ? `/api/batch/audio/${enc(p.id)}?v=${p.audioVer || 0}` : "";
  }
  function clipFileUrl(c) {
    return `/api/studio/clip-file?platform=${enc(c.platform)}&id=${enc(c.itemId)}&direct_url=${enc(c.directUrl || "")}`;
  }
  function fileStem(p) {
    const name = (p.productName || p.header || p.productTitle || "คลิป").replace(/\(.*?\)/g, " ").trim().slice(0, 40);
    return `${num2(idxOf(p) + 1)}_${name}`;
  }

  // ------------------------------------------------------------------ small UI pieces
  const STEPS = [
    ["foot", "ฟุตเทจ", "🎞️"],
    ["script", "บท", "📝"],
    ["voice", "เสียง", "🎙️"],
    ["censor", "เซนเซอร์", "🀄"],
    ["render", "เรนเดอร์", "🎬"],
  ];
  const CHIP_CLS = {
    idle: "bg-slate-800/80 text-slate-500 border-slate-700",
    busy: "b-shimmer text-white border-indigo-400/60",
    done: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
    error: "bg-rose-500/20 text-rose-300 border-rose-500/60",
    skip: "bg-slate-900 text-slate-600 border-slate-800 line-through",
    stale: "bg-amber-500/15 text-amber-300 border-amber-500/50",
  };
  const CHIP_MARK = { idle: "", busy: "…", done: "✓", error: "!", skip: "", stale: "↻" };
  const CHIP_TIP = { idle: "ยังไม่ทำ", busy: "กำลังทำ", done: "เสร็จ", error: "มีปัญหา", skip: "ไม่เซนเซอร์", stale: "บท/เสียงเปลี่ยน ต้องพากย์ใหม่" };

  function chips(p, withLabel) {
    return `<div class="flex flex-wrap gap-1">${STEPS.map(([k, l, i]) => {
      const s = stepStatus(p, k);
      return `<span title="${l}: ${CHIP_TIP[s]}" class="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md border text-[10px] font-bold ${CHIP_CLS[s]}">${i}${withLabel ? " " + l : ""} ${CHIP_MARK[s]}</span>`;
    }).join("")}</div>`;
  }

  function optionsHtml(list, value) {
    return list
      .map((o) => `<option value="${esc(o.value)}" ${String(o.value) === String(value) ? "selected" : ""} ${o.disabled ? "disabled" : ""}>${esc(o.label)}</option>`)
      .join("");
  }
  function shortLabel(label) {
    return String(label).replace(/\s*\(.*$/, "").replace(/^[^\wก-๙]+/, "").trim() || label;
  }
  function shortOptions(list) {
    return list.map((o) => ({ ...o, label: shortLabel(o.label) }));
  }

  function thumbSrc(p) {
    const c = p.clips.find((x) => x.thumb);
    if (c) return c.thumb;
    if (p.productImage) return `/api/proxy-image?url=${enc(p.productImage)}`;
    return "";
  }

  // ------------------------------------------------------------------ card
  function clipStrip(p) {
    const items = p.clips
      .map((c) => {
        const busy = c.status === "downloading" || c.status === "uploading";
        const err = c.status === "error";
        const pct = Math.max(0, Math.min(100, Math.round(c._pct || 0)));
        return `<div class="relative group/clip w-9 h-14 rounded-md overflow-hidden border ${err ? "border-rose-500" : c.censoredUrl && p.censorOn ? "border-emerald-500/60" : "border-slate-600"} bg-slate-800 shrink-0" title="${esc(c.title)}${c.sourceUrl ? " · ลิงก์: " + esc(c.sourceUrl) : ""}${err ? " — " + esc(c.error || "โหลดไม่สำเร็จ") : ""}">
          ${c.thumb ? `<img src="${esc(c.thumb)}" class="w-full h-full object-cover" alt="" onerror="this.remove()">` : `<div class="w-full h-full flex items-center justify-center text-sm">${c.platform === "pc" ? "💻" : "🎞️"}</div>`}
          ${busy ? `<div class="absolute inset-0 bg-black/60 flex items-center justify-center text-[9px] font-bold text-white">${c.status === "uploading" ? "⬆" : pct + "%"}</div>` : ""}
          ${err ? `<div class="absolute inset-0 bg-rose-900/60 flex items-center justify-center text-xs">!</div>` : ""}
          <button type="button" data-act="clip-remove" data-key="${esc(c.key)}" class="hidden group-hover/clip:flex absolute top-0 right-0 w-4 h-4 bg-black/80 text-[9px] text-white items-center justify-center" title="เอาคลิปนี้ออก">✕</button>
        </div>`;
      })
      .join("");
    return `<div class="flex items-center gap-1 overflow-x-auto pb-0.5">${items}
      <button type="button" data-act="clip-panel" class="w-9 h-14 rounded-md border border-dashed ${p.clips.length ? "border-slate-600 text-slate-400" : "border-fuchsia-500/70 text-fuchsia-300"} hover:border-fuchsia-400 hover:text-fuchsia-300 text-sm shrink-0" title="เพิ่มฟุตเทจ">＋</button>
      <span class="text-[10px] text-slate-500 ml-1 shrink-0">${p.clips.length ? `${p.clips.length} คลิป` : "ยังไม่มีฟุตเทจ"}</span>
    </div>`;
  }

  function clipPanel(p) {
    if (!p._clipPanel) return "";
    return `<div class="rounded-xl bg-slate-950/80 border border-fuchsia-500/40 p-2 space-y-2">
      <textarea data-field="_linkDraft" rows="2" placeholder="วางลิงก์ Douyin / RedNote / Bilibili (หลายลิงก์ได้)" class="w-full px-2 py-1.5 rounded-lg bg-slate-900 border border-slate-700 text-[11px] text-white placeholder-slate-500 focus:outline-none focus:border-fuchsia-500">${esc(p._linkDraft || "")}</textarea>
      <div class="flex flex-wrap gap-1.5">
        <button type="button" data-act="clip-links" class="px-2.5 py-1 rounded-lg bg-fuchsia-600 hover:bg-fuchsia-500 text-[11px] font-bold text-white" ${p._linkBusy ? "disabled" : ""}>${p._linkBusy ? "⏳ กำลังดึง…" : "⬇️ โหลดลิงก์"}</button>
        <label class="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-[11px] font-bold text-slate-200 cursor-pointer">💻 จากเครื่อง<input type="file" data-act="clip-files" accept="video/*" multiple class="hidden"></label>
        <button type="button" data-act="clip-page2" class="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-[11px] font-bold text-slate-200" title="คัดลอกคลิปทั้งหมดที่อยู่ในคิวหน้า 2">📥 คลิปจากหน้า 2</button>
        <button type="button" data-act="clip-panel" class="ml-auto px-2 py-1 rounded-lg text-[11px] text-slate-400 hover:text-white">ปิด</button>
      </div>
    </div>`;
  }

  function shopeeRow(p) {
    const busy = p.st.shopee === "busy";
    return `<div class="flex items-center gap-2 p-1.5 rounded-xl bg-slate-950/70 border ${p.productTitle ? "border-orange-500/30" : "border-dashed border-orange-500/50"}">
      ${p.productImage
        ? `<img src="/api/proxy-image?url=${enc(p.productImage)}" class="w-9 h-9 rounded-lg object-cover bg-white shrink-0" alt="" title="รูปสินค้าจาก Shopee" onerror="this.style.visibility='hidden'">`
        : `<div class="w-9 h-9 rounded-lg border border-dashed border-slate-600 flex items-center justify-center text-base text-slate-500 shrink-0">🛒</div>`}
      <input data-field="shopeeUrl" value="${esc(p.shopeeUrl)}" placeholder="วางลิงก์สินค้า Shopee (หรือพิมพ์ชื่อสินค้า)" class="flex-1 min-w-0 px-2 py-1.5 rounded-lg bg-slate-900 border border-slate-700 text-[11px] text-white placeholder-slate-500 focus:outline-none focus:border-orange-500">
      <button type="button" data-act="shopee" class="px-2.5 py-1.5 rounded-lg bg-orange-600 hover:bg-orange-500 text-[11px] font-bold text-white shrink-0" ${busy ? "disabled" : ""}>${busy ? "⏳" : "📥 ดึง"}</button>
    </div>`;
  }

  function errorBox(p) {
    const msgs = [];
    if (p.err.shopee) msgs.push(`🛒 ${p.err.shopee}`);
    if (p.err.script) msgs.push(`📝 ${p.err.script}`);
    if (p.err.voice) msgs.push(`🎙️ ${p.err.voice} — ลองเปลี่ยนเสียง หรือกดพากย์ใหม่`);
    if (p.err.censor) msgs.push(`🀄 ${p.err.censor}`);
    if (p.err.render) msgs.push(`🎬 ${p.err.render}`);
    if (!msgs.length) return "";
    return `<div class="text-[10px] text-rose-200 bg-rose-500/10 border border-rose-500/30 rounded-md px-2 py-1 space-y-0.5">${msgs.map((m) => `<div>⚠️ ${esc(m)}</div>`).join("")}</div>`;
  }

  function audioBar(p) {
    if (!p.hasAudio) return "";
    const playing = state.audioPid === p.id && state.audioPlayer && !state.audioPlayer.paused;
    let bars = "";
    for (let k = 0; k < 28; k++) bars += `<div class="flex-1 rounded-sm ${playing ? "bg-indigo-300" : "bg-indigo-400/50"}" style="height:${20 + ((k * 37 + p.id.charCodeAt(p.id.length - 1) * 11) % 80)}%"></div>`;
    return `<div class="flex items-center gap-2 px-2 py-1 rounded-lg bg-slate-950 border ${p.voiceStale ? "border-amber-500/50" : "border-slate-800"}">
      <button type="button" data-act="audio" class="w-6 h-6 rounded-full bg-indigo-600 hover:bg-indigo-500 text-[10px] text-white shrink-0">${playing ? "⏸" : "▶"}</button>
      <div class="flex-1 flex items-end gap-[2px] h-4">${bars}</div>
      <span class="text-[10px] text-slate-400 shrink-0">${p.voiceStale ? "↻ ต้องพากย์ใหม่" : `${Math.round(p.audioDuration || 0)} วิ`}</span>
    </div>`;
  }

  function scriptBox(p) {
    if (p.st.script === "busy") {
      return `<div class="text-[11px] text-indigo-200 italic px-2 py-3 rounded-lg border border-indigo-500/40 b-shimmer text-center">✍️ AI กำลังเขียนบท…</div>`;
    }
    if (!p.script) {
      return `<div class="text-[11px] text-slate-500 italic px-2 py-3 rounded-lg border border-dashed border-slate-800 text-center">ยังไม่มีบท — กด ✨ เจนบท + เสียง</div>`;
    }
    return `<textarea data-field="script" rows="3" class="w-full px-2 py-1.5 rounded-lg bg-slate-950 border border-slate-800 text-[11px] text-slate-200 leading-relaxed resize-y focus:outline-none focus:border-indigo-500" title="แก้บทแล้วกด 🎙️ พากย์ใหม่">${esc(p.script)}</textarea>`;
  }

  function cardHtml(p) {
    const i = idxOf(p);
    const busyGen = p.st.script === "busy" || p.st.voice === "busy";
    const rendering = state.renderPid === p.id;
    const thumb = thumbSrc(p);
    return `<div data-pid="${esc(p.id)}" class="rounded-2xl bg-slate-900/90 border ${rendering ? "border-emerald-400" : p.sel ? "border-indigo-500/50" : "border-slate-800"} p-3 space-y-2.5 flex flex-col">
      <div class="flex items-start gap-2.5">
        <button type="button" data-act="preview" class="w-20 aspect-[9/16] rounded-lg relative overflow-hidden shrink-0 group bg-gradient-to-br from-slate-700 to-slate-900 border border-slate-700" title="เปิดพรีวิว">
          ${thumb ? `<img src="${esc(thumb)}" class="absolute inset-0 w-full h-full object-cover" alt="" onerror="this.remove()">` : `<span class="absolute inset-0 flex items-center justify-center text-2xl">🎬</span>`}
          ${p.header && p.showHeader ? `<span class="absolute inset-x-1 text-[7px] leading-tight font-black text-yellow-300 text-center" style="top:${Math.max(2, p.headerY - 6)}%;-webkit-text-stroke:.4px #000">${esc(p.header)}</span>` : ""}
          <span class="absolute inset-0 bg-black/0 group-hover:bg-black/45 flex items-center justify-center transition"><span class="opacity-0 group-hover:opacity-100 text-white text-lg">▶</span></span>
          ${rendering ? `<span class="absolute inset-0 bg-black/60 flex flex-col items-center justify-center text-[10px] font-bold text-emerald-300">${p._renderPhase === "convert" ? "แปลงไฟล์" : `${p._renderPct || 0}%`}</span>` : ""}
          ${p.st.render === "done" ? `<span class="absolute bottom-1 right-1 text-[8px] px-1 rounded bg-emerald-500 text-black font-bold">MP4</span>` : ""}
        </button>
        <div class="flex-1 min-w-0 space-y-1.5">
          <div class="flex items-center gap-2">
            <input type="checkbox" data-act="sel" ${p.sel ? "checked" : ""} class="w-4 h-4 accent-rose-500 cursor-pointer">
            <span class="text-[10px] text-slate-500 font-mono">#${num2(i + 1)}</span>
            ${p.productTitle ? `<span class="text-[10px] px-1.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30" title="ชื่อ + รายละเอียดสินค้าถูกเก็บไว้ใช้เจนบท (ไม่แสดง)">✓ ดึงรายละเอียดแล้ว</span>` : ""}
          </div>
          <div class="text-xs font-bold line-clamp-2 text-white">${p.productName ? esc(p.productName) : p.productTitle ? esc(p.productTitle) : '<span class="text-slate-500 font-normal">ยังไม่มีสินค้า — วางลิงก์ Shopee ด้านล่าง</span>'}</div>
          ${p.header ? `<div class="text-[11px] text-yellow-300 font-bold truncate">🅷 ${esc(p.header)}</div>` : ""}
          ${chips(p, false)}
        </div>
      </div>
      ${shopeeRow(p)}
      ${clipStrip(p)}
      ${clipPanel(p)}
      <div class="grid grid-cols-2 gap-1.5">
        <select data-field="voice" class="px-2 py-1.5 rounded-lg bg-slate-950 border border-slate-700 text-[11px] text-white focus:outline-none focus:border-orange-500" title="เสียงพากย์">${optionsHtml(shortOptions(E().voiceOptions()), p.voice)}</select>
        <select data-field="angle" class="px-2 py-1.5 rounded-lg bg-slate-950 border border-slate-700 text-[11px] text-white focus:outline-none focus:border-orange-500" title="สไตล์บทพากย์">${optionsHtml(shortOptions(E().angleOptions()), p.angle)}</select>
      </div>
      ${scriptBox(p)}
      ${errorBox(p)}
      ${p.voiceNote ? `<div class="text-[10px] text-amber-300">ℹ️ ${esc(p.voiceNote)}</div>` : ""}
      ${audioBar(p)}
      ${p.outputPath ? `<button type="button" data-act="open-output" class="text-left text-[10px] text-emerald-300 hover:underline truncate" title="${esc(p.outputPath)}">📂 ${esc(p.outputPath.split(/[\\/]/).pop())}</button>` : ""}
      <div class="flex items-center gap-1.5 mt-auto pt-1">
        <label class="flex items-center gap-1.5 text-[11px] text-slate-300 mr-auto cursor-pointer" title="เปิด = เซนเซอร์ตัวหนังสือจีนตอนเรนเดอร์">
          <button type="button" data-act="censor-toggle" class="bsw ${p.censorOn ? "on" : ""}"></button>
          ${p._censorBusy ? `<span class="text-rose-300">🀄 ${p._censorPct || 0}%</span>` : "เซนเซอร์จีน"}
        </label>
        <button type="button" data-act="gen-full" class="px-2 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-[11px] text-slate-200 disabled:opacity-50" ${busyGen ? "disabled" : ""} title="ให้ AI เขียนบทใหม่ + พากย์ใหม่">🔁 เจนบทใหม่</button>
        <button type="button" data-act="gen-voice" class="px-2 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-[11px] font-bold text-white disabled:opacity-50" ${busyGen || !p.script ? "disabled" : ""} title="พากย์ใหม่จากบทในกล่อง (เปลี่ยนเสียงได้)">🎙️ พากย์ใหม่</button>
        <div class="relative b-menu-wrap" tabindex="-1">
          <button type="button" data-act="menu" class="px-2 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-[11px] text-slate-200">⋯</button>
          <div class="b-menu absolute right-0 bottom-full mb-1 z-20 w-48 rounded-xl bg-slate-900 border border-slate-700 shadow-2xl p-1 text-[11px]">
            <button type="button" data-act="to-page2" class="w-full text-left px-2 py-1.5 rounded hover:bg-slate-800 text-slate-200">🛠️ เปิดแก้ละเอียดในหน้า 2</button>
            <button type="button" data-act="duplicate" class="w-full text-left px-2 py-1.5 rounded hover:bg-slate-800 text-slate-200">📑 ทำซ้ำ (เปลี่ยนมุมขาย)</button>
            <button type="button" data-act="reshuffle" class="w-full text-left px-2 py-1.5 rounded hover:bg-slate-800 text-slate-200">🔀 สุ่มตัดฉากใหม่</button>
            <button type="button" data-act="censor-now" class="w-full text-left px-2 py-1.5 rounded hover:bg-slate-800 text-slate-200">🀄 เซนเซอร์โปรเจคนี้เลย</button>
            <button type="button" data-act="delete" class="w-full text-left px-2 py-1.5 rounded hover:bg-slate-800 text-rose-300">🗑️ ลบโปรเจค</button>
          </div>
        </div>
      </div>
    </div>`;
  }

  // Re-render one card but keep the caret where the user is typing
  function refreshCard(p) {
    if (!p) return;
    const grid = $("batchGrid");
    const old = grid?.querySelector(`[data-pid="${CSS.escape(p.id)}"]`);
    if (!old) return;
    const active = document.activeElement;
    let focusField = null;
    let selStart = 0;
    let selEnd = 0;
    if (active && old.contains(active) && active.dataset.field) {
      focusField = active.dataset.field;
      selStart = active.selectionStart ?? 0;
      selEnd = active.selectionEnd ?? 0;
    }
    const tmp = document.createElement("div");
    tmp.innerHTML = cardHtml(p);
    const fresh = tmp.firstElementChild;
    old.replaceWith(fresh);
    if (focusField) {
      const el = fresh.querySelector(`[data-field="${focusField}"]`);
      if (el) {
        el.focus();
        try {
          el.setSelectionRange(selStart, selEnd);
        } catch (_) {}
      }
    }
    if (state.pv.pid === p.id) renderPvBody();
  }

  const pendingRefresh = new Set();
  let refreshRaf = 0;
  function refreshSoon(p) {
    pendingRefresh.add(p.id);
    if (refreshRaf) return;
    refreshRaf = requestAnimationFrame(() => {
      refreshRaf = 0;
      pendingRefresh.forEach((pid) => refreshCard(byId(pid)));
      pendingRefresh.clear();
      renderActionBar();
      renderQueuePanel();
    });
  }

  // ------------------------------------------------------------------ bars
  const selected = () => state.projects.filter((p) => p.sel);

  function renderDefaultsBar() {
    const d = state.defaults;
    const el = $("batchDefaultsBar");
    if (!el) return;
    const sel = (field, list, title) =>
      `<label class="text-[10px] text-slate-400 space-y-0.5"><div>${title}</div><select data-def="${field}" class="px-2 py-1.5 rounded-lg bg-slate-950 border border-slate-700 text-[11px] text-white max-w-[180px]">${optionsHtml(list, d[field])}</select></label>`;
    el.innerHTML = `<div class="flex flex-wrap items-end gap-2.5">
      <div class="text-xs font-bold text-slate-300 mr-1 self-center">⚙️ ค่าเริ่มต้นทุกโปรเจค</div>
      ${sel("voice", shortOptions(E().voiceOptions()), "เสียงพากย์")}
      ${sel("speed", shortOptions(E().speedOptions()), "ความเร็ว")}
      ${sel("duration", shortOptions(E().durationOptions()), "ความยาว")}
      ${sel("angle", shortOptions(E().angleOptions()), "มุมขาย")}
      ${sel("template", E().templates.map((t) => ({ value: t.id, label: t.name })), "Template")}
      <label class="flex items-center gap-1.5 text-[11px] text-slate-300 self-center cursor-pointer"><input type="checkbox" data-def="randomize" ${d.randomize ? "checked" : ""} class="accent-rose-500">🎲 สุ่มเสียง/มุมขายไม่ให้ซ้ำกัน (โปรเจคใหม่)</label>
      <label class="flex items-center gap-1.5 text-[11px] text-slate-300 self-center cursor-pointer"><input type="checkbox" data-def="censorOn" ${d.censorOn ? "checked" : ""} class="accent-rose-500">🀄 เซนเซอร์จีน (โปรเจคใหม่)</label>
      <button type="button" data-def-apply class="ml-auto px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-[11px] font-bold border border-slate-700 text-slate-200">↧ ใช้กับที่เลือก (${selected().length})</button>
    </div>`;
  }

  function renderActionBar() {
    const el = $("batchActionBar");
    if (!el) return;
    const n = selected().length;
    const total = state.projects.length;
    const genBusy = state.genActive > 0 || state.genQueue.length > 0;
    const czCount = selected().filter((p) => p.censorOn).length;
    el.innerHTML = `
      <label class="flex items-center gap-2 text-xs text-slate-300 pr-2 border-r border-slate-700 cursor-pointer"><input type="checkbox" data-bar="sel-all" ${n && n === total ? "checked" : ""} class="w-4 h-4 accent-rose-500">เลือก <b class="text-white">${n}</b>/${total}</label>
      <button type="button" data-bar="add" class="px-3 py-2 rounded-xl bg-orange-600 hover:bg-orange-500 text-xs font-bold text-white">➕ เพิ่มโปรเจค (วางลิงก์ Shopee หลายลิงก์)</button>
      <div class="flex-1"></div>
      <button type="button" data-bar="gen" class="px-3 py-2 rounded-xl bg-gradient-to-r from-orange-500 via-rose-500 to-fuchsia-600 text-xs font-extrabold text-white shadow-lg shadow-rose-500/20 disabled:opacity-60" ${!n ? "disabled" : ""}>${genBusy ? `⏳ กำลังเจน (${state.genActive + state.genQueue.length})` : `✨ เจนบท + เสียง (${n})`}</button>
      <button type="button" data-bar="censor" class="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 border border-rose-500/40 text-rose-200 text-xs font-bold disabled:opacity-60" ${!czCount ? "disabled" : ""}>${state.censorRunning ? `⏳ เซนเซอร์ (${state.censorQueue.length + 1})` : `🀄 เซนเซอร์ที่เปิดไว้ (${czCount})`}</button>
      ${state.renderRunning
        ? `<button type="button" data-bar="stop" class="px-3 py-2 rounded-xl bg-rose-700 hover:bg-rose-600 text-xs font-extrabold text-white">${state.renderStop ? "⏳ จะหยุดหลังอันนี้" : "⏹ หยุดหลังอันนี้"}</button>`
        : `<button type="button" data-bar="render" class="px-3 py-2 rounded-xl bg-gradient-to-r from-emerald-500 to-sky-600 text-xs font-extrabold text-white disabled:opacity-60" ${!n ? "disabled" : ""}>🎬 เรนเดอร์ที่เลือก (${n})</button>`}`;
  }

  function renderQueuePanel() {
    const el = $("batchQueuePanel");
    if (!el) return;
    const done = state.projects.filter((p) => p.st.render === "done").length;
    const rows = [];
    if (state.renderPid) rows.push(byId(state.renderPid));
    state.renderQueue.forEach((pid) => rows.push(byId(pid)));
    const remainSec = rows.filter(Boolean).reduce((s, p) => s + (Number(p.audioDuration) || Number(p.duration) || 20) + 8, 0);
    el.innerHTML = `
      <div class="flex items-center justify-between gap-2">
        <div class="text-xs font-bold text-white">🎬 คิวเรนเดอร์ <span class="text-slate-400 font-normal">(ทีละโปรเจค · เสร็จ ${done}/${state.projects.length})</span></div>
        <button type="button" data-output-dir-open="" class="px-2 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-[10px] font-bold text-slate-200">📂 เปิดโฟลเดอร์</button>
      </div>
      ${rows.filter(Boolean).length
        ? `<div class="space-y-1.5">${rows
            .filter(Boolean)
            .map((p, k) => {
              const cur = p.id === state.renderPid;
              return `<div class="flex items-center gap-2 text-[11px]">
                <span class="w-5 text-slate-500">${num2(idxOf(p) + 1)}</span>
                <span class="flex-1 truncate text-slate-200">${esc(p.productName || p.header || "โปรเจค")}</span>
                ${cur
                  ? `<div class="w-24 h-1.5 rounded bg-slate-800 overflow-hidden"><div class="h-full bg-emerald-400" style="width:${p._renderPhase === "convert" ? 97 : p._renderPct || 0}%"></div></div><span class="w-14 text-right text-emerald-300">${esc(p._renderLabel || "")}</span>`
                  : `<span class="text-slate-500">รอคิว #${k}</span>`}
              </div>`;
            })
            .join("")}</div>
          <div class="text-[10px] text-slate-500">⏱️ เหลืออีกประมาณ ${Math.max(1, Math.round(remainSec / 60))} นาที · ย่อหน้าต่างได้ แต่อย่าปิดแอปหรือรีเฟรช</div>`
        : `<div class="text-[11px] text-slate-500">ยังไม่มีคิว — เลือกโปรเจคแล้วกด 🎬 เรนเดอร์ที่เลือก ระบบจะเรนเดอร์ทีละโปรเจคแล้วเซฟลงโฟลเดอร์ให้</div>`}`;
  }

  function renderAll() {
    if (!state.loaded || !E()) return;
    renderDefaultsBar();
    renderActionBar();
    const grid = $("batchGrid");
    if (grid) {
      grid.innerHTML =
        state.projects.map(cardHtml).join("") +
        `<button type="button" data-bar="add" class="rounded-2xl border-2 border-dashed border-slate-700 hover:border-orange-500 text-slate-500 hover:text-orange-300 min-h-[220px] flex flex-col items-center justify-center gap-1"><span class="text-3xl">＋</span><span class="text-xs font-bold">เพิ่มโปรเจค</span><span class="text-[10px]">วางลิงก์ Shopee ได้หลายลิงก์</span></button>`;
    }
    renderQueuePanel();
    document.querySelectorAll("#pageBatchView [data-output-dir-label]").forEach((el) => {
      el.textContent = E().outputDir() || "…";
      el.title = E().outputDir() || "";
    });
    const rs = $("batchResolutionSelect");
    if (rs) rs.value = E().resolution();
    updateNavCount();
  }

  function updateNavCount() {
    const el = $("navPage3Count");
    if (el) el.textContent = String(state.projects.length);
  }

  // ------------------------------------------------------------------ Shopee
  function applyShopeeProduct(p, product) {
    const E2 = E();
    const cleanCategory = (product.thai_keyword || "").split(/[,|]+/)[0].trim();
    p.shopeeUrl = product.input_url || product.canonical_url || p.shopeeUrl;
    p.productName = product.title || "";
    p.productTitle = cleanCategory ? `${cleanCategory} (${product.title || ""})` : product.title || "";
    const filtered = E2.filterStorePolicyFromDesc(product.description || "");
    const highlights = Array.isArray(product.description_highlights)
      ? product.description_highlights.filter((h) => !E2.STORE_POLICY_WORDS.some((w) => String(h).includes(w))).join(" • ")
      : "";
    p.productDesc = [filtered, highlights].filter(Boolean).join("\n") || cleanCategory || product.title || "";
    p.productImage = product.image || "";
    if (!p.header && cleanCategory) p.header = `${cleanCategory} ใช้งานง่ายสะดวก`;
  }

  async function fetchShopee(p) {
    const url = (p.shopeeUrl || "").trim();
    if (!url) {
      toast("วางลิงก์สินค้า Shopee ในการ์ดก่อนกดดึง");
      return;
    }
    // Plain text instead of a link = the product name typed by hand (when Shopee can't be fetched)
    if (!/^https?:\/\//i.test(url) && !/shopee|shp\.ee/i.test(url)) {
      p.productTitle = url;
      p.productName = url;
      p.productDesc = p.productDesc || "";
      p.st.shopee = "done";
      delete p.err.shopee;
      refreshSoon(p);
      saveSoon();
      toast("ใช้ข้อความนี้เป็นชื่อสินค้าสำหรับเจนบทแล้ว");
      return;
    }
    p.st.shopee = "busy";
    delete p.err.shopee;
    refreshSoon(p);
    try {
      const r = await fetch("/api/studio/shopee-info", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.detail || `HTTP ${r.status}`);
      applyShopeeProduct(p, d.product);
      p.st.shopee = "done";
    } catch (err) {
      p.st.shopee = "error";
      p.err.shopee = err.message || "ดึงข้อมูลสินค้าไม่สำเร็จ";
    }
    refreshSoon(p);
    saveSoon();
  }

  async function runLimited(items, limit, fn) {
    const queue = items.slice();
    const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
      while (queue.length) {
        const it = queue.shift();
        try {
          await fn(it);
        } catch (_) {}
      }
    });
    await Promise.all(workers);
  }

  // ------------------------------------------------------------------ footage
  function splitLinks(text) {
    const urls = String(text || "").match(/https?:\/\/[^\s"'<>，。]+/g);
    if (urls && urls.length) return [...new Set(urls)];
    return String(text || "")
      .split(/\n+/)
      .map((l) => l.trim())
      .filter(Boolean);
  }

  function prefetchClip(c) {
    c.status = "downloading";
    fetch("/api/studio/clip-prefetch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform: c.platform, id: c.itemId, direct_url: c.directUrl || "" }),
    }).catch(() => {});
    ensureProgressPoller();
  }

  let progressTimer = null;
  function ensureProgressPoller() {
    if (progressTimer) return;
    progressTimer = setInterval(async () => {
      const pending = [];
      state.projects.forEach((p) => p.clips.forEach((c) => c.status === "downloading" && c.platform !== "pc" && pending.push([p, c])));
      if (!pending.length) {
        clearInterval(progressTimer);
        progressTimer = null;
        return;
      }
      await Promise.all(
        pending.map(async ([p, c]) => {
          try {
            const r = await fetch(`/api/studio/clip-progress?platform=${enc(c.platform)}&id=${enc(c.itemId)}`);
            const d = await r.json();
            if (d.status === "done") {
              c.status = "ready";
              c._pct = 100;
              saveSoon();
            } else if (d.status === "error") {
              c.status = "error";
              c.error = d.detail || "โหลดคลิปไม่สำเร็จ";
              saveSoon();
            } else {
              c._pct = d.pct || 0;
            }
            refreshSoon(p);
          } catch (_) {}
        })
      );
    }, 800);
  }

  function clipFromItem(item) {
    const platform = item.platform;
    const c = {
      key: `${platform}:${item.id}`,
      platform,
      itemId: String(item.id),
      directUrl: item.direct_video_url || (platform === "xhs" ? item.url || "" : ""),
      title: item.title || `คลิปจาก ${platform}`,
      sourceUrl: item.url || "",
      thumb: item.cover ? `/api/proxy-image?url=${enc(item.cover)}` : "",
      status: "downloading",
      censoredUrl: "",
    };
    c.url = clipFileUrl(c);
    return c;
  }

  function addClipToProject(p, c) {
    if (p.clips.some((x) => x.key === c.key)) return false;
    p.clips.push(c);
    p.cutSegments = null;
    if (p.st.render === "done") p.st.render = "idle";
    return true;
  }

  async function addClipLinks(p) {
    const links = splitLinks(p._linkDraft);
    if (!links.length) {
      toast("วางลิงก์ Douyin / RedNote / Bilibili ก่อน");
      return;
    }
    if (links.some((l) => /shopee|shp\.ee/i.test(l))) {
      toast("ลิงก์ Shopee ให้วางในช่อง 🛒 ด้านบนของการ์ด — ช่องนี้รับเฉพาะลิงก์คลิป", false, 4500);
      return;
    }
    p._linkBusy = true;
    refreshSoon(p);
    const failed = [];
    let added = 0;
    await runLimited(links, 4, async (url) => {
      try {
        const r = await fetch("/api/resolve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url }),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || !d.item) throw new Error(d.detail || `HTTP ${r.status}`);
        const c = clipFromItem(d.item);
        if (addClipToProject(p, c)) {
          added++;
          prefetchClip(c);
        }
      } catch (_) {
        failed.push(url);
      }
    });
    p._linkBusy = false;
    p._linkDraft = failed.join("\n");
    if (!failed.length) p._clipPanel = false;
    refreshSoon(p);
    saveSoon();
    toast(failed.length ? `เพิ่ม ${added} คลิป • ดึงไม่สำเร็จ ${failed.length} ลิงก์ (ค้างไว้ในช่องให้ลองใหม่)` : `🎞️ เพิ่ม ${added} คลิปเข้าโปรเจคแล้ว`, false, 4000);
  }

  async function uploadClipFile(p, file) {
    const tempKey = `pc-up-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const c = { key: tempKey, platform: "pc", itemId: "", directUrl: "", title: file.name, thumb: "", status: "uploading", censoredUrl: "", url: "" };
    p.clips.push(c);
    refreshSoon(p);
    try {
      const fd = new FormData();
      fd.append("file", file, file.name);
      const r = await fetch("/api/studio/upload-clip", { method: "POST", body: fd });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.detail || `HTTP ${r.status}`);
      c.itemId = d.id;
      c.key = `pc:${d.id}`;
      c.url = clipFileUrl(c);
      c.status = "ready";
      p.cutSegments = null;
    } catch (err) {
      c.status = "error";
      c.error = err.message || "อัปโหลดไม่สำเร็จ";
    }
    refreshSoon(p);
    saveSoon();
  }

  async function addClipsFromPage2(p) {
    const list = E().getPage2ClipData();
    if (!list.length) {
      toast("คิวคลิปหน้า 2 ยังว่าง");
      return;
    }
    let added = 0;
    for (const d of list) {
      if (d.platform === "pc") {
        if (d.rawFile) {
          uploadClipFile(p, d.rawFile);
          added++;
        }
        continue;
      }
      if (!d.itemId) continue;
      const c = clipFromItem({ platform: d.platform, id: d.itemId, direct_video_url: d.directUrl, title: d.title });
      c.thumb = d.thumb || "";
      if (addClipToProject(p, c)) {
        added++;
        prefetchClip(c);
      }
    }
    p._clipPanel = false;
    refreshSoon(p);
    saveSoon();
    toast(`📥 คัดลอก ${added} คลิปจากหน้า 2 แล้ว`);
  }

  // ------------------------------------------------------------------ script + voice
  function enqueueGen(p, mode) {
    if (state.genQueue.some((q) => q.pid === p.id) || p.st.script === "busy" || p.st.voice === "busy") return;
    state.genQueue.push({ pid: p.id, mode });
    if (mode === "full") p.st.script = "busy";
    else p.st.voice = "busy";
    delete p.err.script;
    delete p.err.voice;
    refreshSoon(p);
    pumpGen();
  }

  function pumpGen() {
    while (state.genActive < GEN_CONCURRENCY && state.genQueue.length) {
      const job = state.genQueue.shift();
      const p = byId(job.pid);
      if (!p) continue;
      state.genActive++;
      genProject(p, job.mode).finally(() => {
        state.genActive--;
        renderActionBar();
        pumpGen();
      });
    }
    renderActionBar();
  }

  async function genProject(p, mode) {
    const keys = E().keys();
    const vm = voiceMeta(p.voice);
    const base = {
      product_title: p.productTitle,
      product_description: p.productDesc,
      target_duration: Number(p.duration) || 20,
      sales_angle: p.angle,
      voice_name: p.voice,
      voice_gender: vm.gender || "Male",
      api_key: keys.gemini,
      openrouter_api_key: keys.openrouter,
    };
    try {
      if (mode === "full") {
        if (!p.productTitle && !p.productDesc) throw Object.assign(new Error("ยังไม่มีข้อมูลสินค้า — วางลิงก์ Shopee แล้วกด 📥 ดึง ก่อน"), { step: "script" });
        p.st.script = "busy";
        refreshSoon(p);
        const r = await fetch("/api/studio/generate-script", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...base, custom_header: "", rewrite_script: true }),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw Object.assign(new Error(d.detail || "คิดบทไม่สำเร็จ"), { step: "script" });
        if (d.short_headline) p.header = d.short_headline;
        p.script = d.spoken_script || "";
        if (Array.isArray(d.scenes) && d.scenes.length) p.scenes = d.scenes;
        p.st.script = "done";
        p.voiceNote = d.model_used === "template-fallback" ? "AI คิดบทติดจำกัด/ยังไม่ได้ใส่ Key — ใช้บทพื้นฐานแทน" : "";
        refreshSoon(p);
        saveSoon();
      }
      if (!p.script.trim()) throw Object.assign(new Error("ยังไม่มีบทพากย์"), { step: "voice" });
      p.st.voice = "busy";
      refreshSoon(p);
      const r2 = await fetch("/api/studio/generate-all", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...base,
          custom_header: p.header,
          custom_script: p.script,
          speed_rate: p.speed || "+15%",
          rewrite_script: false,
        }),
      });
      const d2 = await r2.json().catch(() => ({}));
      if (!r2.ok) throw Object.assign(new Error(d2.detail || "พากย์เสียงไม่สำเร็จ"), { step: "voice" });
      if (!d2.audio_base64) throw Object.assign(new Error("ไม่ได้ไฟล์เสียงกลับมา"), { step: "voice" });
      const up = await fetch(`/api/batch/audio/${enc(p.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mime: d2.mime_type || "audio/mpeg", audio_base64: d2.audio_base64 }),
      });
      if (!up.ok) throw Object.assign(new Error("บันทึกไฟล์เสียงไม่สำเร็จ"), { step: "voice" });
      if (d2.short_headline) p.header = d2.short_headline;
      p.script = d2.spoken_script || p.script;
      if (Array.isArray(d2.scenes) && d2.scenes.length) p.scenes = d2.scenes;
      p.audioDuration = Math.max(4, Number(d2.audio_duration) || Number(p.duration) || 20);
      p.hasAudio = true;
      p.audioVer = (p.audioVer || 0) + 1;
      p.voiceStale = false;
      if (d2.fallback_notice) p.voiceNote = d2.fallback_notice;
      p.st.voice = "done";
      if (p.st.script !== "done") p.st.script = "done";
      p.cutSegments = null;
      if (p.st.render === "done") p.st.render = "idle";
      if (state.audioPid === p.id) stopCardAudio();
      if (state.pv.pid === p.id) reloadPreviewAudio(p);
    } catch (err) {
      const step = err.step || "voice";
      p.err[step] = err.message || "ไม่สำเร็จ";
      p.st[step] = "error";
      if (step === "script" && p.st.voice === "busy") p.st.voice = p.hasAudio ? "done" : "idle";
      if (step === "voice" && p.st.script === "busy") p.st.script = p.script ? "done" : "idle";
    }
    refreshSoon(p);
    saveSoon();
  }

  function genSelected() {
    const list = selected();
    if (!list.length) return;
    let queued = 0;
    list.forEach((p) => {
      if (p.st.script === "busy" || p.st.voice === "busy") return;
      if (!p.script) {
        enqueueGen(p, "full");
        queued++;
      } else if (!p.hasAudio || p.voiceStale || p.st.voice === "error") {
        enqueueGen(p, "voice");
        queued++;
      }
    });
    if (!queued) {
      toast("โปรเจคที่เลือกมีบทและเสียงครบแล้ว — ถ้าจะทำใหม่กด 🔁 เจนบทใหม่ ในการ์ดนั้น", false, 4500);
    } else {
      toast(`✨ เริ่มเจนบท + เสียง ${queued} โปรเจค (ทำพร้อมกันทีละ ${GEN_CONCURRENCY})`, false, 3500);
    }
  }

  // ------------------------------------------------------------------ Chinese censor
  async function censorProject(p, { force = false } = {}) {
    const targets = readyClips(p).filter((c) => force || !c.censoredUrl);
    if (!targets.length) {
      if (!readyClips(p).length) throw new Error("ยังไม่มีฟุตเทจที่โหลดเสร็จ");
      return;
    }
    p._censorBusy = true;
    p._censorPct = 0;
    delete p.err.censor;
    refreshSoon(p);
    try {
      for (let k = 0; k < targets.length; k++) {
        const c = targets[k];
        const poll = setInterval(async () => {
          try {
            const r = await fetch(`/api/studio/censor-progress?platform=${enc(c.platform)}&id=${enc(c.itemId)}`);
            const d = await r.json();
            if (typeof d.pct === "number") {
              p._censorPct = Math.round(((k + d.pct / 100) / targets.length) * 100);
              refreshSoon(p);
              if (state.pv.pid === p.id) setPvOverlay(`🀄 กำลังสแกนและเซนเซอร์… ${p._censorPct}%`, p._censorPct);
            }
          } catch (_) {}
        }, 500);
        try {
          const r = await fetch("/api/studio/censor-chinese", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ platform: c.platform, id: c.itemId, direct_url: c.directUrl || "", force: true }),
          });
          const d = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(d.detail || `HTTP ${r.status}`);
          c.censoredUrl = d.censored_url || "";
          c.censorHits = Number(d.hits || 0);
        } finally {
          clearInterval(poll);
        }
      }
      if (p.st.render === "done") p.st.render = "idle";
    } catch (err) {
      p.err.censor = err.message || "เซนเซอร์ไม่สำเร็จ";
      throw err;
    } finally {
      p._censorBusy = false;
      refreshSoon(p);
      saveSoon();
    }
  }

  function censorSelected() {
    const list = selected().filter((p) => p.censorOn);
    list.forEach((p) => {
      if (!state.censorQueue.includes(p.id)) state.censorQueue.push(p.id);
    });
    pumpCensor();
  }

  async function pumpCensor() {
    if (state.censorRunning) return;
    state.censorRunning = true;
    renderActionBar();
    while (state.censorQueue.length) {
      const p = byId(state.censorQueue.shift());
      if (!p || !p.censorOn) continue;
      try {
        await censorProject(p);
      } catch (_) {}
      renderActionBar();
    }
    state.censorRunning = false;
    renderActionBar();
  }

  // ------------------------------------------------------------------ engine runtime (preview + render)
  function cutKeyOf(p) {
    return `${readyClips(p).map((c) => c.key).join("|")}#${Math.round(Number(p.audioDuration) || 0)}`;
  }

  // Load a project's clips + voice into the page-2 engine
  async function enterProject(p, canvas, { czView = "after", onProgress } = {}) {
    const clips = readyClips(p);
    if (!clips.length) throw new Error("ยังไม่มีฟุตเทจที่โหลดเสร็จ");
    const runtimeClips = clips.map((c) =>
      E().createRuntimeClip({
        key: c.key,
        platform: c.platform,
        itemId: c.itemId,
        title: c.title,
        url: p.censorOn && czView !== "before" && c.censoredUrl ? c.censoredUrl : c.url,
        thumb: c.thumb,
        duration: c.duration,
      })
    );
    let voiceAudio = null;
    const aUrl = audioUrl(p);
    if (aUrl) {
      voiceAudio = new Audio(aUrl);
      voiceAudio.preload = "auto";
    }
    const total = Math.max(4, Number(p.audioDuration) || Number(p.duration) || 20);
    E().enter(
      {
        clips: runtimeClips,
        cutSegments: [],
        scenes: Array.isArray(p.scenes) && p.scenes.length ? p.scenes : [{ index: 0, start: 0, duration: total, line_top: "", line_bottom: "", full_narration: "" }],
        spokenScript: p.script || "",
        headerText: p.header || "",
        showHeader: p.showHeader !== false,
        showSubtitles: p.showSub !== false,
        headerPosY: Number(p.headerY ?? 13.5),
        subPosY: Number(p.subY ?? 77),
        totalDuration: total,
        voiceAudio,
        voiceAudioDataUrl: aUrl,
        selectedTemplateId: p.template || "clean-no-anim",
        voiceEngineLabel: "",
      },
      canvas
    );
    let progressTimerLocal = null;
    if (onProgress) {
      progressTimerLocal = setInterval(() => {
        const pct = runtimeClips.reduce((s, c) => s + (c.isCaching ? c.cacheProgress || 0 : 100), 0) / runtimeClips.length;
        onProgress(Math.round(pct));
      }, 250);
    }
    const errors = await E().whenClipsReady(runtimeClips);
    if (progressTimerLocal) clearInterval(progressTimerLocal);
    // remember real clip lengths for nicer cut plans next time
    runtimeClips.forEach((rc) => {
      const c = p.clips.find((x) => x.key === rc.id);
      if (c && rc.duration) c.duration = rc.duration;
    });
    const usable = runtimeClips.filter((c) => !c.cacheError);
    if (!usable.length) throw new Error(`โหลดฟุตเทจไม่สำเร็จ: ${errors.join(", ")}`);
    if (usable.length !== runtimeClips.length) E().set("clips", usable);
    const key = cutKeyOf(p);
    if (Array.isArray(p.cutSegments) && p.cutSegments.length && p.cutKey === key) {
      E().set("cutSegments", p.cutSegments);
    } else {
      p.cutSegments = E().buildCutPlan(false);
      p.cutKey = key;
      saveSoon();
    }
    return { clips: runtimeClips, voiceAudio };
  }

  function exitProject(runtime) {
    if (E().isInBatch()) E().leave();
    if (runtime) {
      E().disposeRuntimeClips(runtime.clips);
      if (runtime.voiceAudio) {
        try {
          runtime.voiceAudio.pause();
          runtime.voiceAudio.removeAttribute("src");
        } catch (_) {}
      }
    }
  }

  // ------------------------------------------------------------------ render queue
  async function renderProject(p) {
    if (!readyClips(p).length) throw new Error("ยังไม่มีฟุตเทจ");
    if (!p.hasAudio) throw new Error("ยังไม่มีเสียงพากย์ — กด ✨ เจนบท + เสียง ก่อน");
    if (p.voiceStale) throw new Error("บท/เสียงถูกแก้ ต้องกด 🎙️ พากย์ใหม่ ก่อน");
    if (p.censorOn && readyClips(p).some((c) => !c.censoredUrl)) {
      p._renderLabel = "เซนเซอร์…";
      refreshSoon(p);
      await censorProject(p);
    }
    let runtime = null;
    try {
      p._renderLabel = "โหลดคลิป…";
      p._renderPct = 0;
      refreshSoon(p);
      runtime = await enterProject(p, null);
      p._renderPhase = "record";
      const rec = await E().recordTimelineToBlob(E().resolution(), (pct) => {
        p._renderPct = pct;
        p._renderLabel = `${pct}%`;
        refreshSoon(p);
      });
      exitProject(runtime);
      runtime = null;
      p._renderPhase = "convert";
      p._renderLabel = "แปลงไฟล์…";
      refreshSoon(p);
      const out = await E().convertRecordingToMp4(rec.blob, rec.fps, { saveName: fileStem(p), returnBody: false });
      p.outputPath = out.savedPath || "";
      p.st.render = "done";
      delete p.err.render;
    } finally {
      if (runtime) exitProject(runtime);
      p._renderPhase = "";
      p._renderPct = 0;
      p._renderLabel = "";
    }
  }

  async function renderSelected() {
    if (state.renderRunning) return;
    if (E().isBusy()) {
      toast("หน้า 2 กำลังเรนเดอร์/เซนเซอร์อยู่ รอให้เสร็จก่อน", false, 4000);
      return;
    }
    let list = selected().filter((p) => p.st.render !== "done");
    if (!list.length && selected().length) {
      if (!window.confirm(`โปรเจคที่เลือกเรนเดอร์ครบแล้ว — เรนเดอร์ใหม่ทั้ง ${selected().length} โปรเจค?`)) return;
      list = selected();
    }
    if (!list.length) return;
    closePreview();
    state.renderRunning = true;
    state.renderStop = false;
    state.renderQueue = list.map((p) => p.id);
    renderActionBar();
    renderQueuePanel();
    let ok = 0;
    let fail = 0;
    while (state.renderQueue.length && !state.renderStop) {
      const p = byId(state.renderQueue.shift());
      if (!p) continue;
      state.renderPid = p.id;
      p.st.render = "busy";
      delete p.err.render;
      refreshSoon(p);
      try {
        await renderProject(p);
        ok++;
      } catch (err) {
        p.st.render = "error";
        p.err.render = err.message || "เรนเดอร์ไม่สำเร็จ";
        fail++;
      }
      state.renderPid = null;
      refreshSoon(p);
      saveSoon();
    }
    const stopped = state.renderQueue.length;
    state.renderQueue = [];
    state.renderRunning = false;
    state.renderStop = false;
    renderActionBar();
    renderQueuePanel();
    renderAll();
    toast(
      `🎬 เรนเดอร์เสร็จ ${ok} โปรเจค${fail ? ` • ไม่สำเร็จ ${fail}` : ""}${stopped ? ` • หยุดไว้ ${stopped} โปรเจค` : ""} — ไฟล์อยู่ในโฟลเดอร์ ${E().outputDir()}`,
      false,
      8000
    );
  }

  // ------------------------------------------------------------------ preview popup
  function setPvOverlay(html, pct) {
    const ov = $("batchPvOverlay");
    if (!ov) return;
    if (!html) {
      ov.classList.add("hidden");
      ov.innerHTML = "";
      return;
    }
    ov.classList.remove("hidden");
    ov.innerHTML = `<div class="text-sm font-bold text-white">${html}</div>${typeof pct === "number" ? `<div class="w-2/3 h-1.5 rounded bg-white/20 overflow-hidden"><div class="h-full bg-rose-500" style="width:${pct}%"></div></div>` : ""}`;
  }

  async function openPreview(p, { czView } = {}) {
    if (!p) return;
    if (state.renderRunning) {
      toast("กำลังเรนเดอร์อยู่ — เปิดพรีวิวได้หลังเรนเดอร์เสร็จ", false, 3500);
      return;
    }
    if (E().isBusy()) {
      toast("หน้า 2 กำลังเรนเดอร์/เซนเซอร์อยู่ รอให้เสร็จก่อน", false, 3500);
      return;
    }
    stopCardAudio();
    teardownPreviewRuntime();
    const token = ++state.pv.token;
    state.pv.pid = p.id;
    p._czView = czView || p._czView || "after";
    $("batchPvModal").classList.remove("hidden");
    $("batchPvTitle").textContent = `#${num2(idxOf(p) + 1)} · ${p.productName || p.productTitle || "(ยังไม่มีสินค้า)"}`;
    renderPvBody();
    const canvas = $("batchPvCanvas");
    canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
    if (!readyClips(p).length) {
      setPvOverlay("ยังไม่มีฟุตเทจ — เพิ่มคลิปในการ์ดก่อน");
      return;
    }
    state.pv.loading = true;
    setPvOverlay("⏳ กำลังโหลดคลิป…", 0);
    try {
      const runtime = await enterProject(p, canvas, {
        czView: p._czView,
        onProgress: (pct) => token === state.pv.token && setPvOverlay(`⏳ กำลังโหลดคลิป ${pct}%`, pct),
      });
      if (token !== state.pv.token) {
        exitProject(runtime);
        return;
      }
      state.pv.runtime = runtime;
      state.pv.loading = false;
      setPvOverlay("");
      E().seek(0);
      E().play();
      startHud();
    } catch (err) {
      if (token !== state.pv.token) return;
      state.pv.loading = false;
      setPvOverlay(`⚠️ ${esc(err.message || "เปิดพรีวิวไม่สำเร็จ")}`);
    }
  }

  function teardownPreviewRuntime() {
    cancelAnimationFrame(state.pv.hudRaf);
    state.pv.hudRaf = 0;
    if (state.pv.runtime) {
      exitProject(state.pv.runtime);
      state.pv.runtime = null;
    } else if (E() && E().isInBatch() && !state.renderRunning) {
      E().leave();
    }
  }

  function closePreview() {
    state.pv.token++;
    teardownPreviewRuntime();
    const pid = state.pv.pid;
    state.pv.pid = null;
    state.pv.loading = false;
    $("batchPvModal")?.classList.add("hidden");
    setPvOverlay("");
    if (pid) {
      refreshCard(byId(pid));
      saveSoon();
    }
  }

  function startHud() {
    cancelAnimationFrame(state.pv.hudRaf);
    const tick = () => {
      if (!state.pv.runtime) return;
      const pb = E().playback();
      const scrub = $("batchPvScrub");
      if (scrub && document.activeElement !== scrub) {
        scrub.max = String(pb.totalDuration);
        scrub.value = String(pb.currentTime);
      }
      const t = $("batchPvTime");
      if (t) t.textContent = `${pb.currentTime.toFixed(1)}s / ${pb.totalDuration.toFixed(1)}s`;
      const b = $("batchPvPlayBtn");
      if (b) b.textContent = pb.isPlaying ? "⏸ หยุด" : "▶ เล่น";
      state.pv.hudRaf = requestAnimationFrame(tick);
    };
    state.pv.hudRaf = requestAnimationFrame(tick);
  }

  function reloadPreviewAudio(p) {
    if (!state.pv.runtime) return;
    E().pause();
    if (state.pv.runtime.voiceAudio) state.pv.runtime.voiceAudio.pause();
    const aUrl = audioUrl(p);
    const a = new Audio(aUrl);
    a.preload = "auto";
    state.pv.runtime.voiceAudio = a;
    E().set("voiceAudio", a);
    E().set("voiceAudioDataUrl", aUrl);
    E().set("scenes", p.scenes);
    E().set("headerText", p.header);
    E().set("spokenScript", p.script);
    E().set("totalDuration", Math.max(4, Number(p.audioDuration) || 20));
    p.cutSegments = E().buildCutPlan(false);
    p.cutKey = cutKeyOf(p);
    E().seek(0);
    E().play();
  }

  function pvRange(field, label, min, max, on) {
    return `<div class="flex items-center gap-2">
      <span class="w-20 text-[11px] font-bold text-slate-200">${label}</span>
      <button type="button" data-pv="tog-${field}" class="bsw ${on ? "on" : ""}" title="เปิด/ปิด"></button>
      <input type="range" data-pv-range="${field}" min="${min}" max="${max}" step="0.5" value="${field === "header" ? state.pvP.headerY : state.pvP.subY}" ${on ? "" : "disabled"} class="flex-1 accent-rose-500 disabled:opacity-30">
      <span data-pv-val="${field}" class="w-10 text-right text-[10px] text-slate-400">${Math.round(field === "header" ? state.pvP.headerY : state.pvP.subY)}%</span>
    </div>`;
  }

  function renderPvBody() {
    const p = byId(state.pv.pid);
    const body = $("batchPvBody");
    if (!p || !body) return;
    state.pvP = p;
    const active = document.activeElement;
    const keepField = active && body.contains(active) && active.dataset.pvField ? active.dataset.pvField : null;
    const selS = active?.selectionStart ?? 0;
    const selE = active?.selectionEnd ?? 0;
    const czDone = readyClips(p).length && readyClips(p).every((c) => c.censoredUrl);
    const hits = readyClips(p).reduce((s, c) => s + (Number(c.censorHits) || 0), 0);
    let czAction;
    if (p._censorBusy) {
      czAction = `<div class="flex-1 text-[11px] text-rose-300">⏳ กำลังเซนเซอร์ ${p._censorPct || 0}%</div>`;
    } else if (czDone) {
      czAction = `<div class="inline-flex p-0.5 rounded-lg bg-slate-900 border border-slate-700 text-[11px]">
          <button type="button" data-pv="cz-before" class="px-2 py-1 rounded-md ${p._czView === "before" ? "bg-slate-700 text-white" : "text-slate-400"}">ก่อน</button>
          <button type="button" data-pv="cz-after" class="px-2 py-1 rounded-md ${p._czView !== "before" ? "bg-rose-600 text-white" : "text-slate-400"}">หลัง</button>
        </div>
        <span class="text-[10px] text-emerald-300">✓ เซนเซอร์แล้ว${hits ? ` ${hits} ช่วง` : ""}</span>
        <button type="button" data-pv="cz-now-force" class="ml-auto text-[10px] text-slate-400 hover:text-white underline">สแกนใหม่</button>`;
    } else {
      czAction = `<button type="button" data-pv="cz-now" class="px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-[11px] font-bold text-white">🀄 เซนเซอร์เลย (ดูผลทันที)</button>`;
    }
    const busyGen = p.st.script === "busy" || p.st.voice === "busy";
    body.innerHTML = `${chips(p, true)}
      <div class="rounded-xl bg-slate-950/60 border border-slate-800 p-2.5 space-y-2">
        <div class="flex items-center justify-between"><span class="text-[11px] font-bold text-slate-200">✏️ ข้อความบนจอ</span><span class="text-[10px] text-slate-500">ลากข้อความบนจอขึ้น-ลงได้เลย</span></div>
        <input data-pv-field="header" value="${esc(p.header)}" placeholder="ข้อความ Header" class="w-full px-2.5 py-1.5 rounded-lg bg-slate-900 border border-slate-700 text-xs text-yellow-300 font-bold focus:outline-none focus:border-yellow-400">
        ${pvRange("header", "🅷 Header", 0, 60, p.showHeader !== false)}
        ${pvRange("sub", "💬 Subtitle", 30, 100, p.showSub !== false)}
      </div>
      <div class="rounded-xl bg-slate-950/60 border border-rose-500/30 p-2.5 space-y-2">
        <div class="flex items-center gap-2"><span class="text-[11px] font-bold text-slate-200">🀄 เซนเซอร์ภาษาจีน</span>
          <label class="ml-auto flex items-center gap-1.5 text-[10px] text-slate-400">ใช้ตอนเรนเดอร์ <button type="button" data-pv="cz-toggle" class="bsw ${p.censorOn ? "on" : ""}"></button></label></div>
        <div class="flex flex-wrap items-center gap-2">${czAction}</div>
        ${p.err.censor ? `<div class="text-[10px] text-rose-300">⚠️ ${esc(p.err.censor)}</div>` : ""}
      </div>
      <div class="grid grid-cols-2 gap-2 text-[10px] text-slate-400">
        <label class="space-y-0.5"><div>เสียงพากย์</div><select data-pv-field="voice" class="w-full px-2 py-1.5 rounded-lg bg-slate-950 border border-slate-700 text-[11px] text-white">${optionsHtml(shortOptions(E().voiceOptions()), p.voice)}</select></label>
        <label class="space-y-0.5"><div>มุมขาย</div><select data-pv-field="angle" class="w-full px-2 py-1.5 rounded-lg bg-slate-950 border border-slate-700 text-[11px] text-white">${optionsHtml(shortOptions(E().angleOptions()), p.angle)}</select></label>
        <label class="space-y-0.5"><div>ความยาว (ตอนเจนบท)</div><select data-pv-field="duration" class="w-full px-2 py-1.5 rounded-lg bg-slate-950 border border-slate-700 text-[11px] text-white">${optionsHtml(shortOptions(E().durationOptions()), p.duration)}</select></label>
        <label class="space-y-0.5"><div>Template</div><select data-pv-field="template" class="w-full px-2 py-1.5 rounded-lg bg-slate-950 border border-slate-700 text-[11px] text-white">${optionsHtml(E().templates.map((t) => ({ value: t.id, label: t.name })), p.template)}</select></label>
      </div>
      <textarea data-pv-field="script" rows="4" placeholder="ยังไม่มีบท" class="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-700 text-xs text-slate-100 leading-relaxed focus:outline-none focus:border-indigo-500">${esc(p.script)}</textarea>
      ${errorBox(p)}
      ${p.voiceStale ? `<div class="text-[10px] text-amber-300">↻ บท/เสียงถูกแก้ — กด 🎙️ พากย์ใหม่ ก่อนเรนเดอร์</div>` : ""}
      <div class="flex flex-wrap items-center gap-1.5">
        <button type="button" data-pv="gen-full" class="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-[11px] text-slate-200 disabled:opacity-50" ${busyGen ? "disabled" : ""}>${p.st.script === "busy" ? "⏳ กำลังเขียนบท…" : "🔁 เจนบทใหม่"}</button>
        <button type="button" data-pv="gen-voice" class="px-2.5 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-[11px] font-bold text-white disabled:opacity-50" ${busyGen || !p.script ? "disabled" : ""}>${p.st.voice === "busy" ? "⏳ กำลังพากย์…" : "🎙️ พากย์ใหม่"}</button>
        <button type="button" data-pv="save" class="ml-auto px-4 py-1.5 rounded-lg bg-gradient-to-r from-emerald-500 to-sky-600 text-[11px] font-extrabold text-white">💾 Save</button>
      </div>`;
    if (keepField) {
      const el = body.querySelector(`[data-pv-field="${keepField}"]`);
      if (el) {
        el.focus();
        try {
          el.setSelectionRange(selS, selE);
        } catch (_) {}
      }
    }
  }

  function pvSetPos(field, v) {
    const p = byId(state.pv.pid);
    if (!p) return;
    const val = Math.max(0, Math.min(100, Math.round(Number(v) * 2) / 2));
    if (field === "header") {
      p.headerY = val;
      if (state.pv.runtime) E().set("headerPosY", val);
    } else {
      p.subY = val;
      if (state.pv.runtime) E().set("subPosY", val);
    }
    const r = document.querySelector(`[data-pv-range="${field}"]`);
    if (r && document.activeElement !== r) r.value = String(val);
    const lab = document.querySelector(`[data-pv-val="${field}"]`);
    if (lab) lab.textContent = `${Math.round(val)}%`;
  }

  async function pvCensorNow(force) {
    const p = byId(state.pv.pid);
    if (!p) return;
    p.censorOn = true;
    E().pause();
    setPvOverlay("🀄 กำลังเริ่มสแกน…", 0);
    renderPvBody();
    try {
      await censorProject(p, { force });
      toast("✅ เซนเซอร์เสร็จ — พรีวิวแสดงคลิปหลังเซนเซอร์", false, 3500);
      if (state.pv.pid === p.id) openPreview(p, { czView: "after" });
    } catch (err) {
      setPvOverlay(`⚠️ ${esc(err.message || "เซนเซอร์ไม่สำเร็จ")}`);
      setTimeout(() => state.pv.runtime && setPvOverlay(""), 2500);
      renderPvBody();
    }
  }

  function openSaveScope() {
    const hint = $("batchSaveAllHint");
    if (hint) hint.textContent = `ทั้ง ${state.projects.length} โปรเจค + โปรเจคที่สร้างใหม่`;
    $("batchSaveModal").classList.remove("hidden");
  }

  function doSaveScope(scope) {
    $("batchSaveModal").classList.add("hidden");
    if (scope === "cancel") return;
    const p = byId(state.pv.pid);
    if (!p) return;
    if (scope === "all") {
      const pick = { showHeader: p.showHeader, showSub: p.showSub, headerY: p.headerY, subY: p.subY };
      state.projects.forEach((q) => Object.assign(q, pick));
      Object.assign(state.defaults, pick);
      renderAll();
      toast(`✅ บันทึกแล้ว · ใช้กับทุกโปรเจค (${state.projects.length}) + โปรเจคใหม่`, false, 3500);
    } else {
      refreshCard(p);
      toast(`✅ บันทึกแล้ว · เฉพาะโปรเจค #${num2(idxOf(p) + 1)}`, false, 3000);
    }
    saveNow();
  }

  // ------------------------------------------------------------------ card audio
  function stopCardAudio() {
    if (state.audioPlayer) {
      state.audioPlayer.pause();
      state.audioPlayer = null;
    }
    const prev = byId(state.audioPid);
    state.audioPid = null;
    if (prev) refreshSoon(prev);
  }
  function toggleCardAudio(p) {
    if (state.audioPid === p.id && state.audioPlayer && !state.audioPlayer.paused) {
      stopCardAudio();
      return;
    }
    stopCardAudio();
    const a = new Audio(audioUrl(p));
    state.audioPlayer = a;
    state.audioPid = p.id;
    a.onended = () => stopCardAudio();
    a.play().catch(() => stopCardAudio());
    refreshSoon(p);
  }

  // ------------------------------------------------------------------ project ops
  function addProjects(shopeeLinks) {
    const d = state.defaults;
    const voices = enabledVoices();
    const angles = E().angleOptions();
    const startIdx = state.projects.length;
    const made = [];
    const count = Math.max(1, shopeeLinks.length);
    for (let k = 0; k < count; k++) {
      const extra = { shopeeUrl: shopeeLinks[k] || "" };
      if (d.randomize) {
        if (voices.length) extra.voice = voices[(startIdx + k) % voices.length].value;
        if (angles.length) extra.angle = angles[(startIdx + k) % angles.length].value;
      }
      const p = newProject(extra);
      if (!shopeeLinks.length) p._clipPanel = true;
      state.projects.push(p);
      made.push(p);
    }
    renderAll();
    saveSoon();
    const withLinks = made.filter((p) => p.shopeeUrl);
    if (withLinks.length) {
      toast(`📥 กำลังดึงข้อมูลสินค้า ${withLinks.length} รายการ…`, true, 0);
      runLimited(withLinks, SHOPEE_CONCURRENCY, fetchShopee).then(() => {
        const bad = withLinks.filter((p) => p.st.shopee === "error").length;
        toast(bad ? `ดึงข้อมูลสินค้าไม่สำเร็จ ${bad} รายการ — กด 📥 ดึง ในการ์ดเพื่อลองใหม่` : `✅ สร้าง ${made.length} โปรเจคแล้ว — ใส่ฟุตเทจในแต่ละการ์ดต่อได้เลย`, false, 5000);
      });
    }
    const first = $("batchGrid")?.querySelector(`[data-pid="${CSS.escape(made[0].id)}"]`);
    first?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function duplicateProject(p) {
    const angles = E().angleOptions().map((o) => o.value);
    const nextAngle = angles.length ? angles[(angles.indexOf(p.angle) + 1) % angles.length] : p.angle;
    const copy = newProject({
      ...JSON.parse(JSON.stringify(serialize(p))),
      id: uid(),
      createdAt: Date.now(),
      angle: nextAngle,
      script: "",
      scenes: [],
      header: p.header,
      hasAudio: false,
      audioVer: 0,
      audioDuration: 0,
      voiceStale: false,
      voiceNote: "",
      outputPath: "",
      cutSegments: null,
      cutKey: "",
      st: { shopee: p.st.shopee === "done" ? "done" : "idle", script: "idle", voice: "idle", render: "idle" },
      err: {},
      sel: true,
    });
    state.projects.splice(idxOf(p) + 1, 0, copy);
    renderAll();
    saveSoon();
    toast("📑 ทำซ้ำแล้ว (มุมขายใหม่) — กด ✨ เจนบท + เสียง เพื่อสร้างบทใหม่", false, 4000);
  }

  function deleteProject(p) {
    if (state.renderPid === p.id) {
      toast("โปรเจคนี้กำลังเรนเดอร์อยู่");
      return;
    }
    if (!window.confirm(`ลบโปรเจค #${num2(idxOf(p) + 1)} ${p.productName || ""}?\n(ไฟล์ MP4 ที่เซฟไว้แล้วจะไม่ถูกลบ)`)) return;
    if (state.pv.pid === p.id) closePreview();
    if (state.audioPid === p.id) stopCardAudio();
    state.projects = state.projects.filter((x) => x !== p);
    state.renderQueue = state.renderQueue.filter((pid) => pid !== p.id);
    state.genQueue = state.genQueue.filter((q) => q.pid !== p.id);
    state.censorQueue = state.censorQueue.filter((pid) => pid !== p.id);
    renderAll();
    saveNow();
  }

  function markVoiceStale(p) {
    if (p.hasAudio) {
      p.voiceStale = true;
      if (p.st.render === "done") p.st.render = "idle";
    }
  }

  // ------------------------------------------------------------------ events
  function bindEvents() {
    const view = $("pageBatchView");
    if (!view) return;

    view.addEventListener("click", (e) => {
      const bar = e.target.closest("[data-bar]");
      if (bar && bar.tagName !== "INPUT") {
        const a = bar.dataset.bar;
        if (a === "add") {
          $("batchAddLinks").value = "";
          $("batchAddModal").classList.remove("hidden");
          setTimeout(() => $("batchAddLinks").focus(), 50);
        } else if (a === "gen") genSelected();
        else if (a === "censor") censorSelected();
        else if (a === "render") renderSelected();
        else if (a === "stop") {
          state.renderStop = true;
          renderActionBar();
        }
        return;
      }
      if (e.target.closest("[data-def-apply]")) {
        const d = state.defaults;
        const list = selected();
        list.forEach((p) => {
          const voiceChanged = p.voice !== d.voice || p.speed !== d.speed;
          Object.assign(p, { voice: d.voice, speed: d.speed, duration: d.duration, angle: d.angle, template: d.template });
          if (voiceChanged) markVoiceStale(p);
        });
        renderAll();
        saveSoon();
        toast(`↧ ใช้ค่าเริ่มต้นกับ ${list.length} โปรเจคแล้ว${list.some((p) => p.voiceStale) ? " (โปรเจคที่เปลี่ยนเสียงต้องกดพากย์ใหม่)" : ""}`, false, 4000);
        return;
      }
      const actEl = e.target.closest("[data-act]");
      if (!actEl) return;
      const card = actEl.closest("[data-pid]");
      const p = card ? byId(card.dataset.pid) : null;
      if (!p) return;
      const act = actEl.dataset.act;
      if (act === "sel" || act === "clip-files") return; // handled on change
      e.preventDefault();
      const wrap = actEl.closest(".b-menu-wrap");
      if (wrap && act !== "menu") wrap.classList.remove("open");
      switch (act) {
        case "menu":
          document.querySelectorAll(".b-menu-wrap.open").forEach((w) => w !== wrap && w.classList.remove("open"));
          wrap?.classList.toggle("open");
          break;
        case "preview":
          openPreview(p);
          break;
        case "shopee":
          fetchShopee(p);
          break;
        case "clip-panel":
          p._clipPanel = !p._clipPanel;
          refreshCard(p);
          if (p._clipPanel) card.parentElement.querySelector(`[data-pid="${CSS.escape(p.id)}"] [data-field="_linkDraft"]`)?.focus();
          break;
        case "clip-links":
          addClipLinks(p);
          break;
        case "clip-page2":
          addClipsFromPage2(p);
          break;
        case "clip-remove": {
          const key = actEl.dataset.key;
          p.clips = p.clips.filter((c) => c.key !== key);
          p.cutSegments = null;
          if (p.st.render === "done") p.st.render = "idle";
          refreshCard(p);
          saveSoon();
          break;
        }
        case "censor-toggle":
          p.censorOn = !p.censorOn;
          delete p.err.censor;
          if (p.st.render === "done") p.st.render = "idle";
          refreshCard(p);
          renderActionBar();
          saveSoon();
          break;
        case "censor-now":
          p.censorOn = true;
          censorProject(p, { force: false }).then(
            () => toast(`✅ เซนเซอร์โปรเจค #${num2(idxOf(p) + 1)} เสร็จแล้ว`),
            (err) => toast(err.message || "เซนเซอร์ไม่สำเร็จ", false, 4000)
          );
          break;
        case "gen-full":
          enqueueGen(p, "full");
          break;
        case "gen-voice":
          enqueueGen(p, "voice");
          break;
        case "audio":
          toggleCardAudio(p);
          break;
        case "open-output":
          E().openOutputDir(p.outputPath);
          break;
        case "to-page2":
          if (state.renderRunning) {
            toast("กำลังเรนเดอร์อยู่ — รอให้เสร็จก่อน");
            break;
          }
          closePreview();
          E().loadProjectIntoPage2({ ...p, audioUrl: audioUrl(p) });
          break;
        case "duplicate":
          duplicateProject(p);
          break;
        case "reshuffle":
          p.cutSegments = null;
          p.cutKey = "";
          if (p.st.render === "done") p.st.render = "idle";
          refreshCard(p);
          saveSoon();
          toast("🔀 จะสุ่มตัดฉากใหม่ตอนพรีวิว/เรนเดอร์ครั้งถัดไป");
          break;
        case "delete":
          deleteProject(p);
          break;
        default:
          break;
      }
    });

    document.addEventListener("click", (e) => {
      if (!e.target.closest(".b-menu-wrap")) document.querySelectorAll(".b-menu-wrap.open").forEach((w) => w.classList.remove("open"));
    });

    view.addEventListener("change", (e) => {
      const t = e.target;
      if (t.dataset.bar === "sel-all") {
        state.projects.forEach((p) => (p.sel = t.checked));
        renderAll();
        saveSoon();
        return;
      }
      if (t.dataset.def) {
        const k = t.dataset.def;
        state.defaults[k] = t.type === "checkbox" ? t.checked : k === "duration" ? Number(t.value) : t.value;
        saveSoon();
        return;
      }
      if (t.id === "batchResolutionSelect") {
        const r = document.getElementById("studioResolutionSelect");
        if (r) {
          r.value = t.value;
          r.dispatchEvent(new Event("change", { bubbles: true }));
        }
        return;
      }
      const card = t.closest("[data-pid]");
      const p = card ? byId(card.dataset.pid) : null;
      if (!p) return;
      if (t.dataset.act === "sel") {
        p.sel = t.checked;
        refreshCard(p);
        renderActionBar();
        renderDefaultsBar();
        saveSoon();
      } else if (t.dataset.act === "clip-files") {
        Array.from(t.files || []).forEach((f) => f.type.startsWith("video/") && uploadClipFile(p, f));
        p._clipPanel = false;
        t.value = "";
      } else if (t.dataset.field === "voice" || t.dataset.field === "angle") {
        p[t.dataset.field] = t.value;
        if (t.dataset.field === "voice") {
          markVoiceStale(p);
          delete p.err.voice;
        }
        refreshCard(p);
        saveSoon();
      } else if (t.dataset.field === "shopeeUrl") {
        p.shopeeUrl = t.value.trim();
        saveSoon();
      }
    });

    view.addEventListener("input", (e) => {
      const t = e.target;
      const card = t.closest("[data-pid]");
      const p = card ? byId(card.dataset.pid) : null;
      if (!p || !t.dataset.field) return;
      if (t.dataset.field === "script") {
        p.script = t.value;
        if (!p.voiceStale && p.hasAudio) {
          markVoiceStale(p);
          refreshSoon(p);
        }
        saveSoon();
      } else if (t.dataset.field === "_linkDraft") {
        p._linkDraft = t.value;
      } else if (t.dataset.field === "shopeeUrl") {
        p.shopeeUrl = t.value.trim();
      }
    });
    view.addEventListener("keydown", (e) => {
      const t = e.target;
      if (t.dataset?.field === "shopeeUrl" && e.key === "Enter") {
        const p = byId(t.closest("[data-pid]")?.dataset.pid);
        if (p) {
          p.shopeeUrl = t.value.trim();
          fetchShopee(p);
        }
      }
    });

    // ---- add projects modal
    $("batchAddCloseBtn")?.addEventListener("click", () => $("batchAddModal").classList.add("hidden"));
    $("batchAddModal")?.addEventListener("click", (e) => {
      if (e.target.id === "batchAddModal") $("batchAddModal").classList.add("hidden");
    });
    $("batchAddCreateBtn")?.addEventListener("click", () => {
      const links = splitLinks($("batchAddLinks").value).filter((l) => /^https?:\/\//i.test(l));
      const bad = links.filter((l) => !/shopee|shp\.ee/i.test(l));
      if (bad.length) {
        toast("ช่องนี้รับเฉพาะลิงก์สินค้า Shopee — ลิงก์คลิปให้วางในการ์ดแต่ละโปรเจค", false, 4500);
        return;
      }
      $("batchAddModal").classList.add("hidden");
      addProjects(links);
    });

    // ---- preview popup
    $("batchPvCloseBtn")?.addEventListener("click", closePreview);
    $("batchPvModal")?.addEventListener("click", (e) => {
      if (e.target.id === "batchPvModal") closePreview();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && state.pv.pid && $("batchSaveModal").classList.contains("hidden")) closePreview();
    });
    $("batchPvPlayBtn")?.addEventListener("click", () => state.pv.runtime && E().toggle());
    $("batchPvRestartBtn")?.addEventListener("click", () => {
      if (!state.pv.runtime) return;
      E().seek(0);
      E().play();
    });
    $("batchPvScrub")?.addEventListener("input", (e) => state.pv.runtime && E().seek(Number(e.target.value)));
    const step = (d) => {
      const i = state.projects.findIndex((p) => p.id === state.pv.pid);
      if (i < 0 || !state.projects.length) return;
      openPreview(state.projects[(i + d + state.projects.length) % state.projects.length]);
    };
    $("batchPvPrevBtn")?.addEventListener("click", () => step(-1));
    $("batchPvNextBtn")?.addEventListener("click", () => step(1));

    const body = $("batchPvBody");
    body?.addEventListener("click", (e) => {
      const b = e.target.closest("[data-pv]");
      if (!b) return;
      const p = byId(state.pv.pid);
      if (!p) return;
      const a = b.dataset.pv;
      if (a === "tog-header" || a === "tog-sub") {
        const key = a === "tog-header" ? "showHeader" : "showSub";
        p[key] = !(p[key] !== false);
        if (state.pv.runtime) E().set(a === "tog-header" ? "showHeader" : "showSubtitles", p[key]);
        renderPvBody();
      } else if (a === "cz-toggle") {
        p.censorOn = !p.censorOn;
        delete p.err.censor;
        if (p.st.render === "done") p.st.render = "idle";
        renderPvBody();
        if (readyClips(p).some((c) => c.censoredUrl)) openPreview(p);
      } else if (a === "cz-now") {
        pvCensorNow(false);
      } else if (a === "cz-now-force") {
        pvCensorNow(true);
      } else if (a === "cz-before" || a === "cz-after") {
        openPreview(p, { czView: a === "cz-before" ? "before" : "after" });
      } else if (a === "gen-full") {
        enqueueGen(p, "full");
        renderPvBody();
      } else if (a === "gen-voice") {
        enqueueGen(p, "voice");
        renderPvBody();
      } else if (a === "save") {
        openSaveScope();
      }
    });
    body?.addEventListener("input", (e) => {
      const t = e.target;
      const p = byId(state.pv.pid);
      if (!p) return;
      if (t.dataset.pvRange) {
        pvSetPos(t.dataset.pvRange, t.value);
        return;
      }
      if (t.dataset.pvField === "header") {
        p.header = t.value;
        if (state.pv.runtime) E().set("headerText", p.header);
      } else if (t.dataset.pvField === "script") {
        p.script = t.value;
        if (!p.voiceStale && p.hasAudio) {
          markVoiceStale(p);
          renderPvBody();
        }
      }
      saveSoon();
    });
    body?.addEventListener("change", (e) => {
      const t = e.target;
      const p = byId(state.pv.pid);
      if (!p || !t.dataset.pvField) return;
      const f = t.dataset.pvField;
      if (f === "voice" || f === "angle" || f === "template" || f === "duration") {
        p[f] = f === "duration" ? Number(t.value) : t.value;
        if (f === "voice") {
          markVoiceStale(p);
          delete p.err.voice;
        }
        if (f === "template" && state.pv.runtime) E().set("selectedTemplateId", p.template);
        renderPvBody();
        saveSoon();
      }
    });

    // drag Header / Subtitle on the preview canvas (a click without moving = play/pause)
    const canvas = $("batchPvCanvas");
    canvas?.addEventListener("pointerdown", (e) => {
      const p = byId(state.pv.pid);
      if (!p || !state.pv.runtime) return;
      const rect = canvas.getBoundingClientRect();
      const y = ((e.clientY - rect.top) / rect.height) * 100;
      const cands = [];
      if (p.showHeader !== false) cands.push(["header", Math.abs(y - p.headerY)]);
      if (p.showSub !== false) cands.push(["sub", Math.abs(y - p.subY)]);
      cands.sort((a, b) => a[1] - b[1]);
      const target = cands.length && cands[0][1] < 12 ? cands[0][0] : null;
      state.pv.drag = { target, startY: e.clientY, moved: false };
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch (_) {}
    });
    canvas?.addEventListener("pointermove", (e) => {
      const d = state.pv.drag;
      if (!d) return;
      if (Math.abs(e.clientY - d.startY) > 4) d.moved = true;
      if (d.moved && d.target) {
        const rect = canvas.getBoundingClientRect();
        pvSetPos(d.target, ((e.clientY - rect.top) / rect.height) * 100);
      }
    });
    canvas?.addEventListener("pointerup", () => {
      const d = state.pv.drag;
      state.pv.drag = null;
      if (!d) return;
      if (!d.moved) E().toggle();
      else saveSoon();
    });

    // save scope popup
    $("batchSaveModal")?.addEventListener("click", (e) => {
      const b = e.target.closest("[data-save-scope]");
      if (b) doSaveScope(b.dataset.saveScope);
      else if (e.target.id === "batchSaveModal") doSaveScope("cancel");
    });

    window.addEventListener("studio:output-dir", () => {
      document.querySelectorAll("#pageBatchView [data-output-dir-label]").forEach((el) => {
        el.textContent = E().outputDir() || "…";
        el.title = E().outputDir() || "";
      });
    });
    window.addEventListener("beforeunload", (e) => {
      if (state.renderRunning) {
        e.preventDefault();
        e.returnValue = "";
      }
    });
  }

  // ------------------------------------------------------------------ page hooks
  window.BatchApp = {
    onShow() {
      if (!state.loaded) load();
      else renderAll();
    },
    beforeLeave() {
      if (state.renderRunning) {
        toast("หน้า 3 กำลังเรนเดอร์อยู่ — รอให้เสร็จ หรือกด ⏹ หยุดหลังอันนี้ ก่อนเปลี่ยนหน้า", false, 4500);
        return false;
      }
      closePreview();
      stopCardAudio();
      saveNow();
      return true;
    },
    isRendering: () => state.renderRunning,
    // Page 1 popup: list projects for "ส่งเข้าโปรเจค"
    async listProjects() {
      await load();
      return state.projects.map((p, i) => ({
        id: p.id,
        index: i + 1,
        label: p.productName || p.productTitle || p.header || "(ยังไม่มีสินค้า)",
        clipCount: p.clips.length,
        clipKeys: p.clips.map((c) => c.key),
      }));
    },
    // Page 1 popup: send a clip (with its source link) to a new project (pid=null) or an existing one
    async sendClip(item, pid, { product } = {}) {
      await load();
      if (!item || !item.id || !item.platform) return;
      let p = pid ? byId(pid) : null;
      let created = false;
      if (!p) {
        const d = state.defaults;
        const extra = {};
        if (d.randomize) {
          const voices = enabledVoices();
          const angles = E().angleOptions();
          const k = state.projects.length;
          if (voices.length) extra.voice = voices[k % voices.length].value;
          if (angles.length) extra.angle = angles[k % angles.length].value;
        }
        p = newProject(extra);
        if (product && product.title) {
          applyShopeeProduct(p, product);
          p.st.shopee = "done";
        }
        state.projects.push(p);
        created = true;
      }
      const c = clipFromItem(item);
      if (!addClipToProject(p, c)) {
        toast(`คลิปนี้อยู่ในโปรเจค #${num2(idxOf(p) + 1)} แล้ว`);
        return;
      }
      prefetchClip(c);
      if (state.loaded) renderAll();
      saveSoon();
      toast(
        created
          ? `🏭 สร้างโปรเจค #${num2(idxOf(p) + 1)} พร้อมคลิปนี้แล้ว (หน้า 3)`
          : `🏭 ส่งคลิปเข้าโปรเจค #${num2(idxOf(p) + 1)} แล้ว (รวม ${p.clips.length} คลิป)`,
        false,
        3500
      );
    },
  };

  function boot() {
    if (!window.StudioEngine) {
      setTimeout(boot, 50);
      return;
    }
    bindEvents();
    // load in the background so the nav badge shows the project count
    load().then(() => {
      if (document.getElementById("pageBatchView")?.classList.contains("hidden")) updateNavCount();
    });
  }
  boot();
})();
