// Frontend Logic for Douyin & Bilibili Video Search & Downloader Hub

const BATCH_LIMIT_PER_PLATFORM = 75;
const MAX_CLIPS_PER_PLATFORM_PER_ROUND = 100;
const XHS_HOSTS = ["xiaohongshu.com", "xhslink.com", "rednote.com"];
const ALL_SOURCES = ["douyin", "bilibili", "xhs"];
const SOURCES_STORAGE_KEY = "search_sources";

const state = {
  keyword: "",
  displayLabel: "",
  page: 1,
  activeFilter: "all", // 'all' | 'douyin' | 'bilibili' | 'xhs'
  xhsNotice: "",
  hasXhsCookie: null, // null = not checked yet
  items: [],
  currentModalItem: null,
  isLoadingMore: false,
  lastShopeeProduct: null,
};

// DOM Elements
const searchForm = document.getElementById("searchForm");
const searchInput = document.getElementById("searchInput");
const searchBtn = document.getElementById("searchBtn");
const resolveForm = document.getElementById("resolveForm");
const resolveInput = document.getElementById("resolveInput");
const resolveBtn = document.getElementById("resolveBtn");
const pasteClipboardBtn = document.getElementById("pasteClipboardBtn");

const resolvedSection = document.getElementById("resolvedSection");
const resolvedContainer = document.getElementById("resolvedContainer");
const closeResolvedBtn = document.getElementById("closeResolvedBtn");

const countAll = document.getElementById("countAll");
const countDouyin = document.getElementById("countDouyin");
const countBilibili = document.getElementById("countBilibili");
const countXhs = document.getElementById("countXhs");
const statusDouyin = document.getElementById("statusDouyin");
const statusBilibili = document.getElementById("statusBilibili");
const statusXhs = document.getElementById("statusXhs");

function setSourceStatus(platform, text = "", tone = "muted") {
  const el =
    platform === "douyin" ? statusDouyin : platform === "bilibili" ? statusBilibili : platform === "xhs" ? statusXhs : null;
  if (!el) return;
  el.textContent = text;
  if (!text) {
    el.className = "text-[10px] truncate";
    return;
  }
  if (tone === "searching") {
    el.className = "text-[10px] text-amber-400 font-semibold animate-pulse truncate";
  } else if (tone === "done") {
    el.className = "text-[10px] text-emerald-400 font-semibold truncate";
  } else if (tone === "warn") {
    el.className = "text-[10px] text-rose-400 font-semibold truncate";
  } else {
    el.className = "text-[10px] text-slate-400 truncate";
  }
}
const searchMetaInfo = document.getElementById("searchMetaInfo");

const loadingState = document.getElementById("loadingState");
const emptyState = document.getElementById("emptyState");
const videoGrid = document.getElementById("videoGrid");
const paginationBar = document.getElementById("paginationBar");
const loadMoreBtn = document.getElementById("loadMoreBtn");
const loadMoreSpinner = document.getElementById("loadMoreSpinner");
const loadMoreText = document.getElementById("loadMoreText");
const pageIndicator = document.getElementById("pageIndicator");

// Modal Elements
const previewModal = document.getElementById("previewModal");
const modalPlatformBadge = document.getElementById("modalPlatformBadge");
const modalTitle = document.getElementById("modalTitle");
const modalVideo = document.getElementById("modalVideo");
const modalAuthor = document.getElementById("modalAuthor");
const modalOriginalLink = document.getElementById("modalOriginalLink");
const modalDownloadMp4Btn = document.getElementById("modalDownloadMp4Btn");
const modalDownloadMp3Btn = document.getElementById("modalDownloadMp3Btn");
const closeModalBtn = document.getElementById("closeModalBtn");

// Toast
const toastBox = document.getElementById("toastBox");
const toastSpinner = document.getElementById("toastSpinner");
const toastText = document.getElementById("toastText");
let toastTimer = null;

function showToast(message, isLoading = false, duration = 3500) {
  if (toastTimer) clearTimeout(toastTimer);
  toastText.textContent = message;
  toastSpinner.classList.toggle("hidden", !isLoading);
  toastBox.classList.remove("hidden");
  if (!isLoading && duration > 0) {
    toastTimer = setTimeout(() => {
      toastBox.classList.add("hidden");
    }, duration);
  }
}

function formatNumber(num) {
  const n = Number(num || 0);
  if (!n || n <= 0) return "—";
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "K";
  return String(n);
}

function proxyImg(url) {
  if (!url) {
    return "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='400' height='250'><rect width='100%' height='100%' fill='%230f172a'/><text x='50%' y='50%' fill='%23475569' font-family='sans-serif' font-size='14' text-anchor='middle'>No Thumbnail</text></svg>";
  }
  return `/api/proxy-image?url=${encodeURIComponent(url)}`;
}

// Safe for both element text and quoted attribute values ("" and '' are escaped too)
function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---------------------------------------------------------------------------
// Video sources on/off (remembered in this browser, defaults to all 3 enabled)
// ---------------------------------------------------------------------------
function loadSources() {
  try {
    const saved = JSON.parse(localStorage.getItem(SOURCES_STORAGE_KEY) || "null");
    if (Array.isArray(saved) && saved.length === ALL_SOURCES.length) {
      const valid = saved.filter((s) => ALL_SOURCES.includes(s));
      if (valid.length === ALL_SOURCES.length) return new Set(valid);
    }
  } catch (_) {}
  // Default to ALL 3 sources enabled
  try {
    localStorage.setItem(SOURCES_STORAGE_KEY, JSON.stringify(ALL_SOURCES));
  } catch (_) {}
  return new Set(ALL_SOURCES);
}

const enabledSources = loadSources();

// Value for the API's `platform` param, e.g. "douyin,bilibili,xhs"
function sourcesParam(excludeXhs = false) {
  const list = ALL_SOURCES.filter((s) => enabledSources.has(s) && !(excludeXhs && s === "xhs"));
  return list.length ? list.join(",") : "douyin,bilibili,xhs";
}

// RedNote is switched on but no cookie saved: only prompt if RedNote is the ONLY source chosen
function needsXhsCookie(retry) {
  if (!enabledSources.has("xhs") || state.hasXhsCookie !== false) return false;
  if (enabledSources.size === 1 && enabledSources.has("xhs")) {
    showXhsMissingPopup(retry);
    return true;
  }
  return false;
}

function renderSourceToggles() {
  document.querySelectorAll(".source-toggle").forEach((btn) => {
    btn.setAttribute("aria-pressed", String(enabledSources.has(btn.dataset.source)));
  });
}

document.querySelectorAll(".source-toggle").forEach((btn) => {
  btn.addEventListener("click", () => {
    const src = btn.dataset.source;
    if (enabledSources.has(src)) {
      if (enabledSources.size === 1) {
        showToast("ต้องเปิดไว้อย่างน้อย 1 เว็บ", false, 2500);
        return;
      }
      enabledSources.delete(src);
    } else {
      enabledSources.add(src);
      if (src === "xhs" && state.hasXhsCookie === false) showXhsMissingPopup(null);
    }
    try {
      localStorage.setItem(SOURCES_STORAGE_KEY, JSON.stringify([...enabledSources]));
    } catch (_) {}
    renderSourceToggles();
  });
});
renderSourceToggles();

// Where the backend should get the video from: the direct file URL if we have it; for RedNote
// search results (no file URL yet) the note page URL, which carries the note's access token.
function videoHint(item) {
  return item.direct_video_url || (item.platform === "xhs" ? item.url || "" : "");
}

function getPlatformMeta(platform) {
  if (platform === "xhs") {
    return {
      badgeClass: "badge-xhs",
      cardClass: "card-xhs",
      shortLabel: "📕 RedNote",
      sourceTag: "RedNote 小红书",
      accentText: "text-red-400",
      btnBg: "bg-red-600 hover:bg-red-500",
    };
  }
  if (platform === "douyin") {
    return {
      badgeClass: "badge-douyin",
      cardClass: "card-douyin",
      shortLabel: "🎵 Douyin",
      sourceTag: "Douyin 抖音",
      accentText: "text-rose-400",
      btnBg: "bg-rose-600 hover:bg-rose-500",
    };
  }
  return {
    badgeClass: "badge-bilibili",
    cardClass: "card-bilibili",
    shortLabel: "📺 Bilibili",
    sourceTag: "Bilibili 哔哩哔哩",
    accentText: "text-sky-400",
    btnBg: "bg-sky-600 hover:bg-sky-500",
  };
}

// Is this search result already queued in the Studio (page 2)?
function isInStudio(item) {
  return Boolean(window.StudioApp && typeof window.StudioApp.hasClip === "function" && window.StudioApp.hasClip(item));
}

// Sidebar "go to studio" button reflects how many clips are queued on page 2
const searchGoStudioBtn = document.getElementById("searchGoStudioBtn");
const searchStudioCount = document.getElementById("searchStudioCount");
function updateStudioQueueButton() {
  const n = window.StudioApp && typeof window.StudioApp.clipCount === "function" ? window.StudioApp.clipCount() : 0;
  if (searchStudioCount) searchStudioCount.textContent = String(n);
  if (searchGoStudioBtn) {
    searchGoStudioBtn.className = `w-full py-2.5 rounded-xl text-xs font-bold transition ${
      n > 0
        ? "bg-gradient-to-r from-fuchsia-600 to-indigo-600 hover:from-fuchsia-500 hover:to-indigo-500 text-white shadow-lg shadow-fuchsia-900/30"
        : "bg-slate-900 border border-slate-800 text-slate-500"
    }`;
  }
}
searchGoStudioBtn?.addEventListener("click", () => {
  if (typeof window.switchAppPage === "function") window.switchAppPage("studio");
});
// studio.js fires this whenever its clip queue changes
window.addEventListener("studio:clips-changed", () => {
  updateStudioQueueButton();
  if (state.items.length) renderGrid();
});

// Render Video Cards Grid
function interleaveByPlatform(items) {
  const queues = [
    items.filter((i) => i.platform === "douyin"),
    items.filter((i) => i.platform === "bilibili"),
    items.filter((i) => i.platform === "xhs"),
  ];
  const others = items.filter((i) => !["douyin", "bilibili", "xhs"].includes(i.platform));
  const out = [];
  let idx = 0;
  while (true) {
    let pushed = false;
    for (const q of queues) {
      if (idx < q.length) {
        out.push(q[idx]);
        pushed = true;
      }
    }
    if (!pushed) break;
    idx++;
  }
  return others.length ? out.concat(others) : out;
}

function renderGrid() {
  const rawFiltered = state.items.filter((item) => {
    if (state.activeFilter === "all") return true;
    return item.platform === state.activeFilter;
  });
  const filtered = state.activeFilter === "all" ? interleaveByPlatform(rawFiltered) : rawFiltered;

  const dyCount = state.items.filter((i) => i.platform === "douyin").length;
  const biliCount = state.items.filter((i) => i.platform === "bilibili").length;

  countAll.textContent = state.items.length;
  countDouyin.textContent = dyCount;
  countBilibili.textContent = biliCount;
  if (countXhs) countXhs.textContent = state.items.filter((i) => i.platform === "xhs").length;

  if (filtered.length === 0) {
    videoGrid.innerHTML = "";
    emptyState.classList.remove("hidden");
    return;
  }

  emptyState.classList.add("hidden");
  const imgFallback =
    "this.src='data:image/svg+xml;utf8,<svg xmlns=\\'http://www.w3.org/2000/svg\\' width=\\'300\\' height=\\'400\\'><rect width=\\'100%\\' height=\\'100%\\' fill=\\'%230f172a\\'/></svg>'";
  videoGrid.innerHTML = filtered
    .map((item, idx) => {
      const meta = getPlatformMeta(item.platform);
      const inStudio = isInStudio(item);
      const statText =
        item.platform === "bilibili" ? `👁 ${formatNumber(item.views)}` : `❤ ${formatNumber(item.likes)}`;

      // Compact card: actions appear on hover over the cover
      return `
      <article class="video-card ${meta.cardClass} rounded-xl bg-slate-900/95 border ${inStudio ? "border-fuchsia-500/70" : "border-slate-800/90"} overflow-hidden group">
        <div class="relative aspect-[4/5] bg-slate-950 overflow-hidden cursor-pointer" data-action="preview" data-index="${idx}">
          <img src="${proxyImg(item.cover)}" alt="${escapeHtml(item.title)}" loading="lazy" class="w-full h-full object-cover" onerror="${imgFallback}" />
          <span class="${meta.badgeClass} absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded-md text-[10px] font-bold">${meta.shortLabel}</span>
          ${
            item.duration && item.duration !== "0:00"
              ? `<span class="absolute bottom-1.5 right-1.5 font-mono text-[10px] text-slate-100 bg-black/70 px-1 rounded">${escapeHtml(item.duration)}</span>`
              : ""
          }
          ${inStudio ? `<span class="absolute top-1.5 right-1.5 px-1.5 py-0.5 rounded-md bg-fuchsia-600 text-white text-[10px] font-bold group-hover:opacity-0 transition">✓ ในคิว</span>` : ""}
          <div class="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition flex items-center justify-center p-2 pointer-events-none">
            <span class="px-3 py-1.5 rounded-lg bg-gradient-to-r from-fuchsia-600 to-indigo-600 text-white text-[11px] font-bold shadow">🔍 กดดูเพิ่มเติม</span>
          </div>
        </div>
        <div class="px-2 py-1.5">
          <h3 class="text-[11px] font-semibold text-slate-100 line-clamp-2 leading-snug" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</h3>
          <p class="text-[10px] text-slate-500 mt-0.5 truncate">${statText} • ${escapeHtml(item.author)}</p>
        </div>
      </article>
      `;
    })
    .join("");

  // Attach card listeners
  videoGrid.querySelectorAll("[data-action]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      const idx = Number(el.getAttribute("data-index"));
      const action = el.getAttribute("data-action");
      const item = filtered[idx];
      if (!item) return;
      if (action === "preview") {
        openPreviewModal(item);
      } else if (action === "download") {
        triggerDownload(item, false);
      } else if (action === "send-to-studio") {
        if (window.StudioApp && typeof window.StudioApp.addClipFromPage1 === "function") {
          window.StudioApp.addClipFromPage1(item);
        }
      }
    });
  });
}

let currentSearchRunId = 0;

function parseDurationSeconds(dur) {
  if (dur == null || dur === "") return 0;
  if (typeof dur === "number") return Number.isFinite(dur) ? dur : 0;
  const s = String(dur).trim();
  if (!s) return 0;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const parts = s.split(":").map((p) => Number(p));
  if (parts.some((n) => !Number.isFinite(n))) return 0;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return 0;
}

const MAX_VIDEO_DURATION_SEC = 5 * 60;

function appendUniqueItems(incoming, opts = {}) {
  if (!Array.isArray(incoming) || incoming.length === 0) return 0;
  const platformCounts = opts.platformCounts || null;
  const perPlatformCap = Number.isFinite(opts.perPlatformCap) ? opts.perPlatformCap : Infinity;
  const existingKeys = new Set(state.items.map((i) => `${i.platform}:${i.id}`));
  let added = 0;
  for (const item of incoming) {
    const durSec = parseDurationSeconds(item.duration);
    if (durSec > MAX_VIDEO_DURATION_SEC) continue;
    const plat = item.platform || "unknown";
    if (platformCounts && (platformCounts[plat] || 0) >= perPlatformCap) continue;
    const key = `${plat}:${item.id}`;
    if (!existingKeys.has(key)) {
      existingKeys.add(key);
      state.items.push(item);
      if (platformCounts) platformCounts[plat] = (platformCounts[plat] || 0) + 1;
      added++;
    }
  }
  return added;
}

function updateSummaryMeta() {
  const zhSearched = (state.searchedZhKeywords && state.searchedZhKeywords.length > 0)
    ? state.searchedZhKeywords.join(" , ")
    : (state.keyword || state.displayLabel);
  const xhsNote = state.xhsNotice
    ? ` <span class="text-amber-300">• RedNote: ${escapeHtml(state.xhsNotice)}</span>`
    : "";
  const progBadge = state.progressiveStatus
    ? ` <span class="inline-flex items-center gap-1 ml-2 px-2.5 py-0.5 rounded-full bg-indigo-500/20 border border-indigo-500/40 text-indigo-300 text-[11px] font-semibold animate-pulse">${escapeHtml(state.progressiveStatus)}</span>`
    : "";
  // Per-site counts live in the sidebar, so this line stays short
  const titleEl = document.getElementById("searchResultsTitle");
  if (titleEl) titleEl.textContent = state.displayLabel ? `“${state.displayLabel}”` : "ผลการค้นหา";
  searchMetaInfo.innerHTML = `<span title="คำค้นภาษาจีนที่ใช้">🇨🇳 <span class="text-amber-300">${escapeHtml(zhSearched)}</span></span> • ${state.items.length} คลิป${xhsNote}${progBadge}`;
  if (pageIndicator) {
    pageIndicator.textContent = `แสดง ${state.items.length} คลิป (ชุดที่ ${state.page})`;
  }
}

// Progressive Sequential Chinese Keyword Search:
// Searches 1 Chinese keyword at a time -> renders results immediately as each keyword finishes!
async function runSequentialKeywordSearch(zhKeywords, displayLabel, page = 1, opts = {}) {
  const runId = ++currentSearchRunId;
  const cleanKws = (zhKeywords || []).map((k) => (k || "").trim()).filter(Boolean);
  if (cleanKws.length === 0) return;

  state.zhKeywords = cleanKws;
  state.searchedZhKeywords = [];
  state.keyword = cleanKws[0];
  state.displayLabel = displayLabel || cleanKws.join(", ");
  state.page = page;
  state.items = [];
  state.xhsNotice = "";
  state.progressiveStatus = "";

  loadingState.classList.remove("hidden");
  emptyState.classList.add("hidden");
  videoGrid.innerHTML = "";
  paginationBar.classList.add("hidden");
  searchBtn.disabled = true;

  const fastSources = ["douyin", "bilibili"].filter((s) => enabledSources.has(s));
  const wantXhs = !state.excludeXhs && enabledSources.has("xhs") && state.hasXhsCookie !== false;
  const perPlatformCap = MAX_CLIPS_PER_PLATFORM_PER_ROUND;
  const perKeywordLimit = Math.max(15, Math.min(60, Math.ceil(perPlatformCap / cleanKws.length) + 10));
  const roundAddedByPlatform = {};

  ["douyin", "bilibili"].forEach((s) => {
    setSourceStatus(s, fastSources.includes(s) ? "กำลังค้นหารอบที่ 1" : "", fastSources.includes(s) ? "searching" : "muted");
  });
  if (!enabledSources.has("xhs")) {
    setSourceStatus("xhs", "", "muted");
  } else if (state.excludeXhs || state.hasXhsCookie === false) {
    setSourceStatus("xhs", "ยังไม่ได้ใส่ Cookie", "warn");
  } else {
    setSourceStatus("xhs", "กำลังค้นหารอบที่ 1", "searching");
  }

  // Run RedNote asynchronously in background so it never blocks Douyin/Bilibili display
  const xhsPromise = (async () => {
    if (!wantXhs) return;
    let xhsSucceeded = false;
    const xhsPhases = [
      { mode: "default", pageVal: page, labelPrefix: "กำลังค้นหารอบที่" },
      { mode: "har", pageVal: page + 1, labelPrefix: "ค้นหาเสริมรอบที่" },
    ];
    for (const phase of xhsPhases) {
      if ((roundAddedByPlatform.xhs || 0) >= perPlatformCap) break;
      if (phase.mode === "har" && state.xhsNotice && /cookie/i.test(state.xhsNotice)) {
        break;
      }
      for (let i = 0; i < cleanKws.length; i++) {
        if (runId !== currentSearchRunId) return;
        if ((roundAddedByPlatform.xhs || 0) >= perPlatformCap) break;
        const zhKw = cleanKws[i];
        setSourceStatus("xhs", `${phase.labelPrefix} ${i + 1}`, "searching");
        try {
          const resp = await fetch(
            `/api/search?q=${encodeURIComponent(zhKw)}&platform=xhs&page=${phase.pageVal}&limit=${perKeywordLimit}&single=true&xhs_mode=${phase.mode}`
          );
          if (runId !== currentSearchRunId || !resp.ok) continue;
          const data = await resp.json();
          if (data.xhs_notice) state.xhsNotice = data.xhs_notice;
          const added = appendUniqueItems(data.items || [], {
            platformCounts: roundAddedByPlatform,
            perPlatformCap,
          });
          if (added > 0) {
            xhsSucceeded = true;
            loadingState.classList.add("hidden");
            if (!state.searchedZhKeywords.includes(zhKw)) state.searchedZhKeywords.push(zhKw);
            updateSummaryMeta();
            renderGrid();
            paginationBar.classList.remove("hidden");
          }
        } catch (_) {}
      }
    }
    if (runId === currentSearchRunId) {
      if (!xhsSucceeded && state.xhsNotice && /cookie/i.test(state.xhsNotice)) {
        setSourceStatus("xhs", "ยังไม่ได้ใส่ Cookie", "warn");
      } else if (!xhsSucceeded) {
        setSourceStatus("xhs", "พักก่อน คุกกี้ติดถี่", "warn");
      } else {
        setSourceStatus("xhs", "ค้นหาสำเร็จ", "done");
      }
    }
  })();

  try {
    if (fastSources.length > 0) {
      for (let i = 0; i < cleanKws.length; i++) {
        if (runId !== currentSearchRunId) return;
        const remainingFast = fastSources.filter((s) => (roundAddedByPlatform[s] || 0) < perPlatformCap);
        if (remainingFast.length === 0) break;
        const zhKw = cleanKws[i];
        remainingFast.forEach((s) => setSourceStatus(s, `กำลังค้นหารอบที่ ${i + 1}`, "searching"));
        state.progressiveStatus =
          cleanKws.length > 1
            ? `⏳ กำลังค้นหาคีย์เวิร์ด ${i + 1}/${cleanKws.length}: "${zhKw}"...`
            : `⏳ กำลังค้นหา "${zhKw}"...`;
        updateSummaryMeta();
        showToast(state.progressiveStatus, true, 0);

        try {
          const resp = await fetch(
            `/api/search?q=${encodeURIComponent(zhKw)}&platform=${remainingFast.join(",")}&page=${page}&limit=${perKeywordLimit}&single=true`
          );
          if (runId !== currentSearchRunId) return;
          if (resp.ok) {
            const data = await resp.json();
            const actualKw = data.keyword || zhKw;
            if (!state.searchedZhKeywords.includes(actualKw)) {
              state.searchedZhKeywords.push(actualKw);
            }
            const added = appendUniqueItems(data.items || [], {
              platformCounts: roundAddedByPlatform,
              perPlatformCap,
            });
            if (state.items.length > 0) {
              loadingState.classList.add("hidden");
              searchBtn.disabled = false;
              paginationBar.classList.remove("hidden");
              updateSummaryMeta();
              renderGrid();
            }
            if (cleanKws.length > 1 && added > 0) {
              showToast(
                `✅ คีย์เวิร์ด "${actualKw}" (${i + 1}/${cleanKws.length}) พบเพิ่ม +${added} คลิป (รวม ${state.items.length} คลิป)`,
                false,
                2200
              );
            }
          }
        } catch (err) {
          console.warn(`Search keyword ${zhKw} error:`, err);
        }
      }
      if (runId === currentSearchRunId) {
        fastSources.forEach((s) => setSourceStatus(s, "ค้นหาสำเร็จ", "done"));
      }
    }

    // Wait for RedNote if no fast sources or if RedNote is still finishing
    await xhsPromise;
    if (runId !== currentSearchRunId) return;

    state.progressiveStatus = "";
    updateSummaryMeta();
    renderGrid();

    if (state.items.length > 0) {
      paginationBar.classList.remove("hidden");
      showToast(
        `🎉 ค้นหาสำเร็จ! พบทั้งหมด ${state.items.length} คลิป (จากคีย์เวิร์ดภาษาจีน: ${state.searchedZhKeywords.join(", ")})`,
        false,
        3500
      );
    } else {
      emptyState.classList.remove("hidden");
    }
  } finally {
    if (runId === currentSearchRunId) {
      state.progressiveStatus = "";
      loadingState.classList.add("hidden");
      searchBtn.disabled = false;
      updateSummaryMeta();
    }
  }
}

// Perform Keyword Search
async function performSearch(keyword, page = 1, opts = {}) {
  const kw = (keyword || "").trim();
  if (!kw) return;
  if (!opts.skipXhsCheck && needsXhsCookie((withXhs) => performSearch(kw, page, { skipXhsCheck: true, excludeXhs: !withXhs })))
    return;
  state.excludeXhs = Boolean(opts.excludeXhs);
  searchInput.value = kw;
  updateSearchInputHint();

  loadingState.classList.remove("hidden");
  emptyState.classList.add("hidden");
  videoGrid.innerHTML = "";
  paginationBar.classList.add("hidden");
  searchBtn.disabled = true;

  try {
    const prepResp = await fetch(`/api/prepare-search?q=${encodeURIComponent(kw)}`);
    let zhKeywords = [kw];
    if (prepResp.ok) {
      const prepData = await prepResp.json();
      if (Array.isArray(prepData.zh_keywords) && prepData.zh_keywords.length > 0) {
        zhKeywords = prepData.zh_keywords;
      }
    }
    await runSequentialKeywordSearch(zhKeywords, kw, page, opts);
  } catch (err) {
    showToast(`เกิดข้อผิดพลาดในการค้นหา: ${err.message}`);
    loadingState.classList.add("hidden");
    searchBtn.disabled = false;
    emptyState.classList.remove("hidden");
  }
}

// Load More Videos (+100 per click, unlimited append sequentially per Chinese keyword)
async function loadMoreVideos() {
  if (state.isLoadingMore || !state.keyword) return;
  state.isLoadingMore = true;
  const nextPage = state.page + 1;
  const kwsToLoad = (state.zhKeywords && state.zhKeywords.length > 0) ? state.zhKeywords : [state.keyword];

  if (loadMoreBtn) loadMoreBtn.disabled = true;
  if (loadMoreSpinner) loadMoreSpinner.classList.remove("hidden");
  if (loadMoreText) loadMoreText.textContent = "กำลังดึงวิดีโอเพิ่มทีละคีย์เวิร์ด...";

  let totalAdded = 0;
  try {
    const platParam = sourcesParam(state.excludeXhs || state.hasXhsCookie === false);
    const activePlats = platParam.split(",").filter(Boolean);
    const perPlatformCap = MAX_CLIPS_PER_PLATFORM_PER_ROUND;
    const perKeywordLimit = Math.max(15, Math.min(60, Math.ceil(perPlatformCap / kwsToLoad.length) + 10));
    const roundAddedByPlatform = {};
    if (!activePlats.includes("xhs") && enabledSources.has("xhs") && (state.excludeXhs || state.hasXhsCookie === false)) {
      setSourceStatus("xhs", "ยังไม่ได้ใส่ Cookie", "warn");
    }
    for (let i = 0; i < kwsToLoad.length; i++) {
      const remainingPlats = activePlats.filter((p) => (roundAddedByPlatform[p] || 0) < perPlatformCap);
      if (remainingPlats.length === 0) break;
      const zhKw = kwsToLoad[i];
      remainingPlats.forEach((p) => setSourceStatus(p, `กำลังค้นหารอบที่ ${i + 1}`, "searching"));
      state.progressiveStatus = `⏳ โหลดเพิ่มชุดที่ ${nextPage} (${i + 1}/${kwsToLoad.length}): "${zhKw}"...`;
      updateSummaryMeta();
      showToast(state.progressiveStatus, true, 0);

      const resp = await fetch(
        `/api/search?q=${encodeURIComponent(zhKw)}&platform=${remainingPlats.join(",")}&page=${nextPage}&limit=${perKeywordLimit}&single=true`
      );
      if (!resp.ok) continue;
      const data = await resp.json();
      if (data.xhs_notice) state.xhsNotice = data.xhs_notice;
      const added = appendUniqueItems(data.items || [], {
        platformCounts: roundAddedByPlatform,
        perPlatformCap,
      });
      totalAdded += added;
      if (added > 0) {
        updateSummaryMeta();
        renderGrid();
      }
    }
    activePlats.forEach((p) => setSourceStatus(p, "ค้นหาสำเร็จ", "done"));

    state.page = nextPage;
    state.progressiveStatus = "";
    updateSummaryMeta();
    renderGrid();

    showToast(
      totalAdded > 0
        ? `โหลดเพิ่มสำเร็จ +${totalAdded} คลิป (รวมทั้งหมด ${state.items.length} คลิป)`
        : `ดึงข้อมูลชุดที่ ${nextPage} แล้ว กดอีกครั้งเพื่อค้นหาคำใกล้เคียงเพิ่มเติม`,
      false,
      3500
    );
  } catch (err) {
    showToast(`เกิดข้อผิดพลาดในการโหลดเพิ่ม: ${err.message}`, false, 4000);
  } finally {
    state.progressiveStatus = "";
    state.isLoadingMore = false;
    updateSummaryMeta();
    if (loadMoreBtn) loadMoreBtn.disabled = false;
    if (loadMoreSpinner) loadMoreSpinner.classList.add("hidden");
    if (loadMoreText) loadMoreText.textContent = "⬇ โหลดเพิ่ม";
  }
}

// Perform Shopee Link Analysis & Progressive Sequential Chinese Video Search
async function resolveDirectUrl(rawUrl, customKeyword = "", opts = {}) {
  const text = (rawUrl || "").trim();
  if (!text) return;

  const lower = text.toLowerCase();
  const isVideoDirect =
    (anyMatch(lower, ["douyin.com", "iesdouyin.com", "bilibili.com", "b23.tv", ...XHS_HOSTS]) ||
      text.includes("小红书")) &&
    !anyMatch(lower, ["shopee", "shp.ee"]);

  if (isVideoDirect) {
    return resolveVideoDirectLink(text);
  }
  if (
    !opts.skipXhsCheck &&
    needsXhsCookie((withXhs) => resolveDirectUrl(text, customKeyword, { skipXhsCheck: true, excludeXhs: !withXhs }))
  )
    return;

  state.excludeXhs = Boolean(opts.excludeXhs);
  resolveBtn.disabled = true;
  loadingState.classList.remove("hidden");
  emptyState.classList.add("hidden");
  showToast("กำลังอ่านข้อมูลสินค้า Shopee และแปลคีย์เวิร์ดภาษาจีน...", true, 0);

  try {
    const resp = await fetch("/api/shopee-analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: text,
        custom_keyword: customKeyword || "",
        platform: sourcesParam(Boolean(opts.excludeXhs)),
        limit: BATCH_LIMIT_PER_PLATFORM,
        skip_search: true,
      }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      throw new Error(data.detail || "ไม่สามารถอ่านข้อมูลจากลิงก์ Shopee นี้ได้");
    }

    const product = data.product;
    state.lastShopeeProduct = product;
    if (window.StudioApp && typeof window.StudioApp.syncShopeeProduct === "function") {
      window.StudioApp.syncShopeeProduct(product, true);
    }

    let zhKeywords =
      Array.isArray(product.zh_keywords) && product.zh_keywords.length > 0
        ? [...product.zh_keywords]
        : [product.zh_keyword || product.thai_keyword || ""].filter(Boolean);
    if (Array.isArray(product.suggested_keywords)) {
      for (const s of product.suggested_keywords) {
        const sk = (s && s.keyword ? String(s.keyword) : "").trim();
        if (sk && !zhKeywords.includes(sk) && zhKeywords.length < 4) {
          zhKeywords.push(sk);
        }
      }
    }

    // Immediately show the Shopee product card (< 1s!) before video searches even finish!
    renderShopeeProductCard(product, { keyword: zhKeywords.join(" | ") });
    searchInput.value = zhKeywords.join(", ");
    updateSearchInputHint();
    resolveBtn.disabled = false;

    // Now sequentially search each Chinese keyword one-by-one and display videos as soon as each finishes!
    await runSequentialKeywordSearch(zhKeywords, product.thai_keyword || zhKeywords.join(", "), 1, opts);
  } catch (err) {
    showToast(err.message, false, 4500);
    if (state.items.length === 0) {
      emptyState.classList.remove("hidden");
    }
    loadingState.classList.add("hidden");
  } finally {
    resolveBtn.disabled = false;
  }
}

function anyMatch(text, keywords) {
  return keywords.some((k) => text.includes(k));
}

function getLinkTypeLabel(linkType) {
  if (linkType === "short_link") return "🔗 ลิงก์แบบย่อ (s.shopee.co.th)";
  if (linkType === "bare_product_link") return "🌐 ลิงก์แบบหน้าเว็บ (/product/...)";
  if (linkType === "full_slug_link") return "📄 ลิงก์แบบเต็ม (Slug URL)";
  return "🛒 ลิงก์สินค้า Shopee";
}

function renderShopeeProductCard(product, search) {
  resolvedSection.classList.remove("hidden");

  const chipOn = "shopee-zh-chip px-2.5 py-1 rounded-lg text-[11px] font-semibold transition border bg-orange-500 text-white border-orange-400";
  const chipOff = "shopee-zh-chip px-2.5 py-1 rounded-lg text-[11px] font-semibold transition border bg-slate-950 hover:bg-slate-800 text-slate-300 border-slate-700";
  const suggestionsHtml = (product.suggested_keywords || [])
    .map((s) => {
      const isActive = s.keyword === (search.keyword || product.zh_keyword);
      return `<button type="button" data-zh-kw="${escapeHtml(s.keyword)}" class="${isActive ? chipOn : chipOff}" title="ค้นด้วยคำจีน: ${escapeHtml(s.keyword)}">${escapeHtml(s.label)}</button>`;
    })
    .join("");
  const idsTitle = [product.shop_id && `Shop ID ${product.shop_id}`, product.item_id && `Item ID ${product.item_id}`]
    .filter(Boolean)
    .join(" • ");

  // Compact product card for the page-1 sidebar
  resolvedContainer.innerHTML = `
    <div class="flex gap-3 items-start pr-7">
      <div class="relative w-16 h-16 rounded-xl overflow-hidden bg-slate-900 border border-slate-800 shrink-0">
        <img src="${proxyImg(product.image)}" alt="${escapeHtml(product.title)}" class="w-full h-full object-cover" />
      </div>
      <div class="min-w-0 flex-1 space-y-1">
        <div class="flex items-center gap-2 text-[11px]">
          ${product.price ? `<span class="px-1.5 py-0.5 rounded-md bg-emerald-500/20 text-emerald-300 font-bold">฿${escapeHtml(String(product.price))}</span>` : ""}
          <a href="${escapeHtml(product.canonical_url || product.input_url)}" target="_blank" rel="noopener" class="text-orange-400 hover:underline" title="${escapeHtml(idsTitle || "เปิดหน้าสินค้าใน Shopee")}">Shopee ↗</a>
        </div>
        <h4 class="text-xs font-bold text-white leading-snug line-clamp-2" title="${escapeHtml(product.title)}">${escapeHtml(product.title)}</h4>
      </div>
    </div>

    <form id="customShopeeKwForm" class="flex gap-1.5 mt-2.5">
      <input
        id="customShopeeKwInput"
        type="text"
        value="${escapeHtml(product.thai_keyword)}"
        placeholder="คำค้นภาษาไทย เช่น ขาตั้งกล้อง, ไม้กันสั่น"
        title="คำค้นหาวิดีโอ — แก้แล้วกดค้นใหม่"
        class="flex-1 min-w-0 px-2.5 py-1.5 rounded-lg bg-slate-950 border border-slate-700 text-xs text-white focus:outline-none focus:border-orange-500"
      />
      <button type="submit" class="px-3 py-1.5 rounded-lg bg-orange-600 hover:bg-orange-500 text-white text-xs font-semibold shrink-0">ค้นใหม่</button>
    </form>

    ${suggestionsHtml ? `<div class="flex flex-wrap gap-1.5 mt-2.5">${suggestionsHtml}</div>` : ""}

    <button type="button" id="sendShopeeProductToStudioBtn" class="mt-2.5 w-full py-1.5 rounded-xl bg-gradient-to-r from-fuchsia-600 to-indigo-600 hover:from-fuchsia-500 hover:to-indigo-500 text-white text-xs font-bold transition">
      🎬 ใช้สินค้านี้ทำคลิป
    </button>
  `;

  const sendShopeeBtn = document.getElementById("sendShopeeProductToStudioBtn");
  if (sendShopeeBtn) {
    sendShopeeBtn.addEventListener("click", () => {
      if (window.StudioApp && typeof window.StudioApp.syncShopeeProduct === "function") {
        window.StudioApp.syncShopeeProduct(product, false);
      }
      if (typeof window.switchAppPage === "function") {
        window.switchAppPage("studio");
      }
    });
  }

  // Bind clickable Chinese keyword angle chips
  resolvedContainer.querySelectorAll(".shopee-zh-chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      const zhKw = btn.getAttribute("data-zh-kw");
      if (!zhKw) return;
      resolvedContainer.querySelectorAll(".shopee-zh-chip").forEach((b) => {
        b.className = chipOff;
      });
      btn.className = chipOn;
      performSearch(zhKw, 1);
    });
  });

  // Bind custom Thai keyword override form
  const customForm = document.getElementById("customShopeeKwForm");
  const customInput = document.getElementById("customShopeeKwInput");
  if (customForm && customInput) {
    customForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const newKw = customInput.value.trim();
      if (newKw) {
        resolveDirectUrl(product.input_url, newKw);
      }
    });
  }

  resolvedSection.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function resolveVideoDirectLink(text) {
  resolveBtn.disabled = true;
  showToast("กำลังสกัดลิงก์และดึงข้อมูลวิดีโอ...", true, 0);

  try {
    const resp = await fetch("/api/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: text }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      throw new Error(data.detail || "ไม่สามารถดึงข้อมูลจากลิงก์นี้ได้");
    }

    const item = data.item;
    renderResolvedCard(item);
    showToast(`ดึงข้อมูลคลิปจาก ${item.platform_label} สำเร็จ!`, false, 3000);
  } catch (err) {
    showToast(err.message, false, 4500);
    if (err.message.includes("RedNote Cookie")) openXhsCookieModal();
  } finally {
    resolveBtn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// RedNote (小红书) login cookie — RedNote shows notes & search only to logged-in accounts
// ---------------------------------------------------------------------------
const xhsCookieModal = document.getElementById("xhsCookieModal");
const xhsCookieInput = document.getElementById("xhsCookieInput");
const xhsProxyInput = document.getElementById("xhsProxyInput");
const xhsCookieStatus = document.getElementById("xhsCookieStatus");

async function refreshXhsCookieStatus() {
  try {
    const resp = await fetch("/api/xhs/cookie");
    const data = resp.ok ? await resp.json() : {};
    setXhsCookieState(Boolean(data.has_cookie));
    if (xhsProxyInput && typeof data.proxy === "string") {
      xhsProxyInput.value = data.proxy;
    }
    const parts = [];
    parts.push(data.has_cookie ? "✅ มี Cookie แล้ว" : "✨ โหมดไม่ใช้ Cookie (ดึงลิงก์ได้ทันที)");
    if (data.proxy) parts.push(`🌐 Proxy: ${data.proxy}`);
    xhsCookieStatus.textContent = parts.join(" · ");
    xhsCookieStatus.className = data.has_cookie ? "text-[11px] text-emerald-400" : "text-[11px] text-sky-400";
  } catch (_) {}
}

function setXhsCookieState(has) {
  state.hasXhsCookie = has;
  document.querySelectorAll(".xhs-cookie-dot").forEach((dot) => {
    dot.className = has
      ? "xhs-cookie-dot w-2 h-2 rounded-full bg-emerald-400 shadow shadow-emerald-400"
      : "xhs-cookie-dot w-2 h-2 rounded-full bg-slate-500";
  });
  if (has === false) {
    setSourceStatus("xhs", "ยังไม่ได้ใส่ Cookie", "warn");
  } else if (has === true && statusXhs && statusXhs.textContent === "ยังไม่ได้ใส่ Cookie") {
    setSourceStatus("xhs", "", "muted");
  }
}

// --- "RedNote on, no cookie" popup ---
const xhsMissingModal = document.getElementById("xhsMissingModal");
let xhsPendingRetry = null; // what to run after the user decides (search / Shopee lookup)

function showXhsMissingPopup(retry) {
  xhsPendingRetry = retry;
  const others = ["douyin", "bilibili"].filter((s) => enabledSources.has(s));
  document.getElementById("xhsMissingHint").textContent = others.length
    ? `ถ้าข้ามไป จะค้นหาเฉพาะ ${others.map((s) => (s === "douyin" ? "Douyin" : "Bilibili")).join(" และ ")}`
    : "ถ้าข้ามไป จะค้นหาจาก Douyin และ Bilibili แทน";
  document.getElementById("xhsMissingSkipBtn").classList.toggle("hidden", !retry);
  xhsMissingModal.classList.remove("hidden");
}

function closeXhsMissingPopup() {
  xhsMissingModal.classList.add("hidden");
}

document.getElementById("xhsMissingSetBtn")?.addEventListener("click", () => {
  closeXhsMissingPopup();
  openXhsCookieModal();
});
document.getElementById("xhsMissingSkipBtn")?.addEventListener("click", () => {
  closeXhsMissingPopup();
  const retry = xhsPendingRetry;
  xhsPendingRetry = null;
  if (retry) retry(false);
});
document.getElementById("xhsMissingCloseBtn")?.addEventListener("click", () => {
  closeXhsMissingPopup();
  xhsPendingRetry = null;
});
xhsMissingModal?.addEventListener("click", (e) => {
  if (e.target === xhsMissingModal) {
    closeXhsMissingPopup();
    xhsPendingRetry = null;
  }
});

function openXhsCookieModal() {
  xhsCookieInput.value = "";
  xhsCookieModal.classList.remove("hidden");
  refreshXhsCookieStatus();
}

async function saveXhsCookie(cookie, proxy) {
  try {
    const payload = {};
    if (cookie !== undefined) payload.cookie = cookie;
    if (proxy !== undefined) payload.proxy = proxy;
    const resp = await fetch("/api/xhs/cookie", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    setXhsCookieState(Boolean(data.has_cookie));
    showToast("บันทึกการตั้งค่า RedNote เรียบร้อยแล้ว", false, 3500);
    xhsCookieModal.classList.add("hidden");
    const retry = xhsPendingRetry;
    xhsPendingRetry = null;
    if (retry && data.has_cookie) retry(true);
  } catch (err) {
    showToast(`บันทึกการตั้งค่าไม่สำเร็จ: ${err.message}`, false, 4500);
  }
}

document.getElementById("openXhsCookieBtn")?.addEventListener("click", openXhsCookieModal);
document.getElementById("openXhsCookieBtnMobile")?.addEventListener("click", openXhsCookieModal);
refreshXhsCookieStatus(); // header dot + know up front whether RedNote can search
document.getElementById("closeXhsCookieBtn")?.addEventListener("click", () => {
  xhsCookieModal.classList.add("hidden");
  xhsPendingRetry = null; // closed without saving: drop the waiting search
});
document.getElementById("saveXhsCookieBtn")?.addEventListener("click", () => {
  const cookie = xhsCookieInput.value.trim();
  const proxy = xhsProxyInput ? xhsProxyInput.value.trim() : "";
  saveXhsCookie(cookie || undefined, proxy);
});
document.getElementById("clearXhsCookieBtn")?.addEventListener("click", () => {
  if (xhsProxyInput) xhsProxyInput.value = "";
  saveXhsCookie("", "");
});

function renderResolvedCard(item) {
  const meta = getPlatformMeta(item.platform);
  resolvedSection.classList.remove("hidden");

  // Compact pasted-clip card for the page-1 sidebar
  resolvedContainer.innerHTML = `
    <div class="space-y-2.5 pr-7">
      <div class="relative w-full aspect-video rounded-xl overflow-hidden bg-slate-900 cursor-pointer" id="resolvedThumb" title="ดูตัวอย่างคลิป">
        <img src="${proxyImg(item.cover)}" alt="${escapeHtml(item.title)}" class="w-full h-full object-cover" />
        <span class="${meta.badgeClass} absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded-md text-[10px] font-bold">${meta.shortLabel}</span>
        ${
          item.duration
            ? `<span class="absolute bottom-1.5 right-1.5 px-1 rounded bg-black/75 text-[10px] font-mono text-white">${escapeHtml(item.duration)}</span>`
            : ""
        }
      </div>
      <div>
        <h4 class="text-xs font-bold text-white leading-snug line-clamp-2" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</h4>
        <p class="text-[10px] text-slate-500 mt-0.5 truncate" title="ID: ${escapeHtml(item.id)}">
          ${escapeHtml(item.author)} • ❤ ${formatNumber(item.likes)}${item.views ? ` • 👁 ${formatNumber(item.views)}` : ""}
        </p>
      </div>
    </div>
    <div class="grid grid-cols-3 gap-1.5 mt-2.5">
      <button id="resolvedPreviewBtn" type="button" class="py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-white text-[11px] font-semibold transition" title="ดูตัวอย่างคลิป">▶ ดู</button>
      <button id="resolvedDlMp4Btn" type="button" class="py-1.5 rounded-lg ${meta.btnBg} text-white text-[11px] font-semibold transition" title="ดาวน์โหลดวิดีโอ .MP4 ไร้ลายน้ำ">⬇ MP4</button>
      <button id="resolvedDlMp3Btn" type="button" class="py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-[11px] font-semibold transition" title="โหลดเฉพาะเสียง .MP3">🎵 MP3</button>
    </div>
    <button id="resolvedSendToStudioBtn" type="button" class="mt-1.5 w-full py-1.5 rounded-lg bg-gradient-to-r from-fuchsia-600 to-indigo-600 hover:from-fuchsia-500 hover:to-indigo-500 text-white text-[11px] font-bold transition">🎬 ส่งไปทำคลิป</button>
  `;

  document.getElementById("resolvedSendToStudioBtn").onclick = () => {
    if (window.StudioApp && typeof window.StudioApp.addClipFromPage1 === "function") {
      window.StudioApp.addClipFromPage1(item);
    }
  };

  document.getElementById("resolvedThumb").onclick = () => openPreviewModal(item);
  document.getElementById("resolvedPreviewBtn").onclick = () => openPreviewModal(item);
  document.getElementById("resolvedDlMp4Btn").onclick = () => triggerDownload(item, false);
  document.getElementById("resolvedDlMp3Btn").onclick = () => triggerDownload(item, true);
  resolvedSection.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// Open Video Preview Modal
function openPreviewModal(item) {
  closeSendToBatchMenu();
  state.currentModalItem = item;
  const meta = getPlatformMeta(item.platform);

  modalPlatformBadge.className = `${meta.badgeClass} px-2.5 py-1 rounded-md text-xs font-bold shrink-0`;
  modalPlatformBadge.textContent = meta.shortLabel;
  modalTitle.textContent = item.title;
  modalAuthor.textContent = item.author;
  modalOriginalLink.href = item.url;

  const streamUrl = `/api/stream?platform=${encodeURIComponent(item.platform)}&id=${encodeURIComponent(item.id)}&direct_url=${encodeURIComponent(videoHint(item))}`;
  modalVideo.src = streamUrl;
  previewModal.classList.remove("hidden");
  modalVideo.play().catch(() => {});
}

function closePreviewModal() {
  closeSendToBatchMenu();
  modalVideo.pause();
  modalVideo.removeAttribute("src");
  modalVideo.load();
  previewModal.classList.add("hidden");
  state.currentModalItem = null;
}

// Trigger File Download with live % progress
async function triggerDownload(item, audioOnly = false) {
  const extLabel = audioOnly ? "MP3 (เสียง)" : "MP4 (วิดีโอไร้ลายน้ำ)";
  const ext = audioOnly ? "mp3" : "mp4";
  showToast(`กำลังเตรียมไฟล์ ${extLabel} จาก ${item.platform_label} 0%...`, true, 0);

  const dlUrl = `/api/download?platform=${encodeURIComponent(item.platform)}&id=${encodeURIComponent(item.id)}&title=${encodeURIComponent(item.title || "video")}&audio_only=${audioOnly}&direct_url=${encodeURIComponent(item.platform === "xhs" ? videoHint(item) : "")}`;

  try {
    const resp = await fetch(dlUrl);
    if (!resp.ok) {
      let errMsg = `ดาวน์โหลดไม่สำเร็จ (HTTP ${resp.status})`;
      try {
        const errJson = await resp.json();
        if (errJson.detail) errMsg = errJson.detail;
      } catch {}
      throw new Error(errMsg);
    }

    if (!resp.body || !resp.body.getReader) {
      const a = document.createElement("a");
      a.href = dlUrl;
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      showToast(`เริ่มดาวน์โหลด ${extLabel} แล้ว!`, false, 4000);
      return;
    }

    const total = parseInt(resp.headers.get("content-length") || "0", 10);
    const reader = resp.body.getReader();
    const chunks = [];
    let loaded = 0;
    let lastUpdate = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.byteLength;
      const now = Date.now();
      if (now - lastUpdate >= 120) {
        lastUpdate = now;
        const loadedMB = (loaded / (1024 * 1024)).toFixed(1);
        if (total > 0) {
          const pct = Math.min(99, Math.round((loaded * 100) / total));
          const totalMB = (total / (1024 * 1024)).toFixed(1);
          showToast(`กำลังดาวน์โหลด ${extLabel}... ${pct}% (${loadedMB}/${totalMB} MB)`, true, 0);
        } else {
          showToast(`กำลังดาวน์โหลด ${extLabel}... ${loadedMB} MB`, true, 0);
        }
      }
    }

    const blob = new Blob(chunks, { type: resp.headers.get("content-type") || (audioOnly ? "audio/mpeg" : "video/mp4") });
    const blobUrl = URL.createObjectURL(blob);
    const safeName = (item.title || "video").replace(/[\\/:*?"<>|]/g, "_").slice(0, 80);
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = `[${String(item.platform || "video").toUpperCase()}] ${safeName}_${item.id}.${ext}`;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(blobUrl), 30000);
    showToast(`ดาวน์โหลด ${extLabel} เสร็จสมบูรณ์ 100%!`, false, 4000);
  } catch (err) {
    showToast(err.message || "ดาวน์โหลดไม่สำเร็จ", false, 5000);
  }
}

// Event Listeners
searchForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const raw = (searchInput.value || "").trim();
  if (/https?:\/\/|(?:xiaohongshu\.com|rednote\.com|xhslink\.com|douyin\.com|bilibili\.com|b23\.tv|shopee\.)/i.test(raw)) {
    resolveDirectUrl(raw);
    return;
  }
  performSearch(raw, 1);
});

document.querySelectorAll(".kw-chip").forEach((btn) => {
  btn.addEventListener("click", () => {
    const kw = btn.getAttribute("data-kw");
    performSearch(kw, 1);
  });
});

document.querySelectorAll(".filter-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".filter-tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    state.activeFilter = tab.getAttribute("data-filter") || "all";
    renderGrid();
  });
});

if (loadMoreBtn) {
  loadMoreBtn.addEventListener("click", () => {
    loadMoreVideos();
  });
}

resolveForm.addEventListener("submit", (e) => {
  e.preventDefault();
  resolveDirectUrl(resolveInput.value);
});

// One search box takes keywords AND links: show a 🛒 hint + orange border when it holds a link
const LINK_RE = /https?:\/\/|(?:xiaohongshu\.com|rednote\.com|xhslink\.com|douyin\.com|bilibili\.com|b23\.tv|shopee\.|shp\.ee)/i;
const searchInputIcon = document.getElementById("searchInputIcon");
function updateSearchInputHint() {
  const isLink = LINK_RE.test(searchInput.value || "");
  if (searchInputIcon) {
    searchInputIcon.textContent = isLink ? "🛒" : "⌕";
    searchInputIcon.className = `absolute left-3 top-1/2 -translate-y-1/2 text-sm ${isLink ? "text-orange-400" : "text-slate-400"}`;
  }
  searchInput.classList.toggle("border-orange-500/70", isLink);
  searchInput.classList.toggle("border-slate-700/80", !isLink);
}
searchInput.addEventListener("input", updateSearchInputHint);

pasteClipboardBtn.addEventListener("click", async () => {
  try {
    const text = (await navigator.clipboard.readText()).trim();
    if (text) {
      searchInput.value = text;
      updateSearchInputHint();
      searchForm.requestSubmit();
    }
  } catch (err) {
    showToast("กรุณากด Ctrl+V เพื่อวางคำค้นหาหรือลิงก์ในช่อง");
    searchInput.focus();
  }
});

closeResolvedBtn.addEventListener("click", () => {
  resolvedSection.classList.add("hidden");
});

closeModalBtn.addEventListener("click", closePreviewModal);
previewModal.addEventListener("click", (e) => {
  if (e.target === previewModal) closePreviewModal();
});

modalDownloadMp4Btn.addEventListener("click", () => {
  if (state.currentModalItem) triggerDownload(state.currentModalItem, false);
});

modalDownloadMp3Btn.addEventListener("click", () => {
  if (state.currentModalItem) triggerDownload(state.currentModalItem, true);
});

const modalSendToStudioBtn = document.getElementById("modalSendToStudioBtn");
if (modalSendToStudioBtn) {
  modalSendToStudioBtn.addEventListener("click", () => {
    if (state.currentModalItem && window.StudioApp && typeof window.StudioApp.addClipFromPage1 === "function") {
      window.StudioApp.addClipFromPage1(state.currentModalItem);
      closePreviewModal();
    }
  });
}

// ---- Send the clip in the popup to page 3: a new project, or one of the existing projects ----
const modalSendToBatchBtn = document.getElementById("modalSendToBatchBtn");
const modalSendToBatchMenu = document.getElementById("modalSendToBatchMenu");

function closeSendToBatchMenu() {
  document.getElementById("modalSendToBatchMenu")?.classList.add("hidden");
}

async function openSendToBatchMenu() {
  if (!modalSendToBatchMenu || !window.BatchApp) return;
  modalSendToBatchMenu.innerHTML = `<div class="px-2 py-2 text-slate-400">กำลังโหลดรายการโปรเจค...</div>`;
  modalSendToBatchMenu.classList.remove("hidden");
  const projects = await window.BatchApp.listProjects();
  const item = state.currentModalItem;
  const key = item ? `${item.platform}:${item.id}` : "";
  const esc = (t) =>
    String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const product = state.lastShopeeProduct;
  modalSendToBatchMenu.innerHTML = `
    <button type="button" data-batch-target="new" class="w-full text-left px-2.5 py-2 rounded-lg hover:bg-orange-500/15 text-orange-200 font-bold">
      ➕ สร้างโปรเจคใหม่
      ${product?.title ? `<div class="text-[10px] font-normal text-slate-400 truncate">พร้อมสินค้า Shopee ที่ค้นอยู่: ${esc(product.title)}</div>` : ""}
    </button>
    ${projects.length ? `<div class="px-2.5 pt-2 pb-1 text-[10px] text-slate-500">หรือส่งเข้าโปรเจคที่มีอยู่</div>` : ""}
    ${projects
      .map(
        (p) => `<button type="button" data-batch-target="${esc(p.id)}" ${p.clipKeys.includes(key) ? "disabled" : ""} class="w-full text-left px-2.5 py-1.5 rounded-lg hover:bg-slate-800 text-slate-200 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2">
          <span class="text-[10px] text-slate-500 font-mono shrink-0">#${String(p.index).padStart(2, "0")}</span>
          <span class="flex-1 truncate">${esc(p.label)}</span>
          <span class="text-[10px] text-slate-400 shrink-0">${p.clipKeys.includes(key) ? "มีคลิปนี้แล้ว" : `${p.clipCount} คลิป`}</span>
        </button>`
      )
      .join("")}`;
}

modalSendToBatchBtn?.addEventListener("click", (e) => {
  e.stopPropagation();
  if (modalSendToBatchMenu.classList.contains("hidden")) openSendToBatchMenu();
  else closeSendToBatchMenu();
});

modalSendToBatchMenu?.addEventListener("click", async (e) => {
  e.stopPropagation();
  const btn = e.target.closest("[data-batch-target]");
  if (!btn || btn.disabled || !state.currentModalItem || !window.BatchApp) return;
  const target = btn.dataset.batchTarget;
  closeSendToBatchMenu();
  await window.BatchApp.sendClip(state.currentModalItem, target === "new" ? null : target, {
    product: target === "new" ? state.lastShopeeProduct : null,
  });
});

document.addEventListener("click", (e) => {
  if (!e.target.closest("#modalSendToBatchWrap")) closeSendToBatchMenu();
});

// Expose helpers for Studio (Page 2)
window.showToast = showToast;
window.openPreviewModal = openPreviewModal;
window.getAppLastShopeeProduct = () => state.lastShopeeProduct;


// ---- Page 1 sidebar: "แหล่งวิดีโอ" card collapses only when the user clicks it ----
(function setupSourceListCollapse() {
  const btn = document.getElementById("sourceListToggleBtn");
  const body = document.getElementById("sourceListBody");
  const chev = document.getElementById("sourceListChevron");
  const hint = document.getElementById("sourceListCollapsedHint");
  if (!btn || !body) return;
  const KEY = "page1_source_list_collapsed";

  function updateHint() {
    if (!hint) return;
    const active = document.querySelector(".filter-tab.side-filter.active .flex-1");
    const label = active ? active.querySelector(".shrink-0")?.textContent || active.textContent : "";
    const on = [...document.querySelectorAll(".source-toggle.source-switch")].filter(
      (el) => el.getAttribute("aria-pressed") === "true"
    ).length;
    hint.textContent = `${(label || "").trim()} • เปิด ${on} แหล่ง`;
  }

  function setCollapsed(collapsed) {
    body.classList.toggle("hidden", collapsed);
    hint?.classList.toggle("hidden", !collapsed);
    if (chev) chev.style.transform = collapsed ? "rotate(-90deg)" : "";
    btn.setAttribute("aria-expanded", String(!collapsed));
    if (collapsed) updateHint();
  }

  let saved = false;
  try { saved = localStorage.getItem(KEY) === "true"; } catch (_) {}
  setCollapsed(saved);

  btn.addEventListener("click", () => {
    const collapsed = !body.classList.contains("hidden");
    setCollapsed(collapsed);
    try { localStorage.setItem(KEY, String(collapsed)); } catch (_) {}
  });
})();
