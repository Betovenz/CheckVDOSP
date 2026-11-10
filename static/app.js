// Frontend Logic for Douyin & Bilibili Video Search & Downloader Hub

const BATCH_LIMIT_PER_PLATFORM = 75;

const state = {
  keyword: "",
  displayLabel: "",
  page: 1,
  activeFilter: "all", // 'all' | 'douyin' | 'bilibili'
  items: [],
  currentModalItem: null,
  isLoadingMore: false,
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

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str || "";
  return div.innerHTML;
}

function getPlatformMeta(platform) {
  if (platform === "douyin") {
    return {
      badgeClass: "badge-douyin",
      cardClass: "card-douyin",
      shortLabel: "🎵 มาจาก: Douyin (抖音)",
      sourceTag: "Douyin 抖音",
      accentText: "text-rose-400",
      btnBg: "bg-rose-600 hover:bg-rose-500",
    };
  }
  return {
    badgeClass: "badge-bilibili",
    cardClass: "card-bilibili",
    shortLabel: "📺 มาจาก: Bilibili (哔哩哔哩)",
    sourceTag: "Bilibili 哔哩哔哩",
    accentText: "text-sky-400",
    btnBg: "bg-sky-600 hover:bg-sky-500",
  };
}

// Render Video Cards Grid
function renderGrid() {
  const filtered = state.items.filter((item) => {
    if (state.activeFilter === "all") return true;
    return item.platform === state.activeFilter;
  });

  const dyCount = state.items.filter((i) => i.platform === "douyin").length;
  const biliCount = state.items.filter((i) => i.platform === "bilibili").length;

  countAll.textContent = state.items.length;
  countDouyin.textContent = dyCount;
  countBilibili.textContent = biliCount;

  if (filtered.length === 0) {
    videoGrid.innerHTML = "";
    emptyState.classList.remove("hidden");
    return;
  }

  emptyState.classList.add("hidden");
  videoGrid.innerHTML = filtered
    .map((item, idx) => {
      const meta = getPlatformMeta(item.platform);
      const statText =
        item.platform === "douyin"
          ? `❤️ ${formatNumber(item.likes)}`
          : `👁️ ${formatNumber(item.views)} • ❤️ ${formatNumber(item.likes)}`;

      return `
      <article class="video-card ${meta.cardClass} rounded-2xl bg-slate-900/95 border border-slate-800/90 overflow-hidden flex flex-col justify-between shadow-lg">
        <div>
          <!-- Thumbnail Container -->
          <div class="relative aspect-video bg-slate-950 overflow-hidden group cursor-pointer" data-action="preview" data-index="${idx}">
            <img
              src="${proxyImg(item.cover)}"
              alt="${escapeHtml(item.title)}"
              loading="lazy"
              class="w-full h-full object-cover group-hover:scale-105 transition duration-300"
              onerror="this.src='data:image/svg+xml;utf8,<svg xmlns=\\'http://www.w3.org/2000/svg\\' width=\\'400\\' height=\\'250\\'><rect width=\\'100%\\' height=\\'100%\\' fill=\\'%230f172a\\'/><text x=\\'50%\\' y=\\'50%\\' fill=\\'%2364748b\\' font-family=\\'sans-serif\\' font-size=\\'13\\' text-anchor=\\'middle\\'>Preview Available</text></svg>'"
            />
            <div class="absolute inset-0 bg-gradient-to-t from-slate-950/90 via-transparent to-black/30"></div>

            <!-- Top-left Platform Source Badge -->
            <div class="absolute top-2.5 left-2.5 z-10">
              <span class="${meta.badgeClass} px-2.5 py-1 rounded-lg text-[11px] font-bold tracking-wide flex items-center gap-1">
                ${meta.shortLabel}
              </span>
            </div>

            <!-- Duration Badge -->
            ${
              item.duration && item.duration !== "0:00"
                ? `<span class="absolute bottom-2 right-2.5 px-2 py-0.5 rounded-md bg-black/80 text-[11px] font-mono text-slate-200 border border-white/10">
                    ${escapeHtml(item.duration)}
                  </span>`
                : ""
            }

            <!-- Play Overlay Button -->
            <div class="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition bg-black/35">
              <div class="w-11 h-11 rounded-full bg-white/95 text-slate-950 flex items-center justify-center shadow-xl transform scale-95 group-hover:scale-100 transition">
                <svg class="w-5 h-5 ml-0.5" fill="currentColor" viewBox="0 0 20 20">
                  <path d="M6.3 2.841A1.5 1.5 0 004 4.11V15.89a1.5 1.5 0 002.3 1.269l9.344-5.89a1.5 1.5 0 000-2.538L6.3 2.84z" />
                </svg>
              </div>
            </div>
          </div>

          <!-- Card Body -->
          <div class="p-4 space-y-2.5">
            <div class="flex items-center justify-between text-[11px]">
              <span class="font-semibold ${meta.accentText}">แหล่งที่มา: ${meta.sourceTag}</span>
              <span class="text-slate-400">${statText}</span>
            </div>

            <h3 class="text-sm font-semibold text-slate-100 line-clamp-2 leading-snug min-h-[2.5rem]" title="${escapeHtml(item.title)}">
              ${escapeHtml(item.title)}
            </h3>

            <div class="flex items-center justify-between text-xs text-slate-400 pt-1">
              <span class="truncate max-w-[75%]">👤 ${escapeHtml(item.author)}</span>
              <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener" class="text-slate-500 hover:text-slate-300" title="เปิดหน้าเว็บต้นฉบับ">↗</a>
            </div>
          </div>
        </div>

        <!-- Card Actions -->
        <div class="px-4 pb-4 pt-1 flex items-center gap-2">
          <button
            type="button"
            data-action="preview"
            data-index="${idx}"
            class="flex-1 py-2 px-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold transition flex items-center justify-center gap-1.5"
          >
            <span>▶ ดูตัวอย่าง</span>
          </button>
          <button
            type="button"
            data-action="download"
            data-index="${idx}"
            class="flex-1 py-2 px-3 rounded-xl ${meta.btnBg} text-white text-xs font-semibold transition flex items-center justify-center gap-1.5 shadow-md"
          >
            <span>⬇ โหลด MP4</span>
          </button>
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
      }
    });
  });
}

function updateSummaryMeta() {
  const dyCount = state.items.filter((i) => i.platform === "douyin").length;
  const biliCount = state.items.filter((i) => i.platform === "bilibili").length;
  const label = state.displayLabel || state.keyword;
  searchMetaInfo.innerHTML = `คำค้นหา <strong class="text-white">"${escapeHtml(label)}"</strong> — พบจาก Douyin <strong class="text-rose-400">${dyCount}</strong> คลิป และ Bilibili <strong class="text-sky-400">${biliCount}</strong> คลิป (รวม <strong class="text-emerald-400">${state.items.length}</strong> คลิป)`;
  if (pageIndicator) {
    pageIndicator.textContent = `แสดงแล้ว ${state.items.length} คลิป (ชุดที่ ${state.page}) • กดโหลดเพิ่มได้ไม่จำกัด`;
  }
}

// Perform Keyword Search
async function performSearch(keyword, page = 1) {
  const kw = (keyword || "").trim();
  if (!kw) return;

  state.keyword = kw;
  state.displayLabel = kw;
  state.page = page;
  searchInput.value = kw;

  loadingState.classList.remove("hidden");
  emptyState.classList.add("hidden");
  videoGrid.innerHTML = "";
  paginationBar.classList.add("hidden");
  searchBtn.disabled = true;

  try {
    const resp = await fetch(
      `/api/search?q=${encodeURIComponent(kw)}&platform=all&page=${page}&limit=${BATCH_LIMIT_PER_PLATFORM}`
    );
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
    const data = await resp.json();
    state.items = data.items || [];

    updateSummaryMeta();
    renderGrid();

    if (state.items.length > 0) {
      paginationBar.classList.remove("hidden");
    }
  } catch (err) {
    showToast(`เกิดข้อผิดพลาดในการค้นหา: ${err.message}`);
    emptyState.classList.remove("hidden");
  } finally {
    loadingState.classList.add("hidden");
    searchBtn.disabled = false;
  }
}

// Load More Videos (+100 per click, unlimited append)
async function loadMoreVideos() {
  if (state.isLoadingMore || !state.keyword) return;
  state.isLoadingMore = true;
  const nextPage = state.page + 1;

  if (loadMoreBtn) loadMoreBtn.disabled = true;
  if (loadMoreSpinner) loadMoreSpinner.classList.remove("hidden");
  if (loadMoreText) loadMoreText.textContent = "กำลังดึงวิดีโอเพิ่มอีก ~100 คลิป...";
  showToast(`กำลังโหลดวิดีโอชุดที่ ${nextPage}...`, true, 0);

  try {
    const resp = await fetch(
      `/api/search?q=${encodeURIComponent(state.keyword)}&platform=all&page=${nextPage}&limit=${BATCH_LIMIT_PER_PLATFORM}`
    );
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
    const data = await resp.json();
    const incoming = data.items || [];

    const existingKeys = new Set(state.items.map((i) => `${i.platform}:${i.id}`));
    let addedCount = 0;
    for (const item of incoming) {
      const key = `${item.platform}:${item.id}`;
      if (!existingKeys.has(key)) {
        existingKeys.add(key);
        state.items.push(item);
        addedCount++;
      }
    }

    state.page = nextPage;
    updateSummaryMeta();
    renderGrid();

    showToast(
      addedCount > 0
        ? `โหลดเพิ่มสำเร็จ +${addedCount} คลิป (รวมทั้งหมด ${state.items.length} คลิป)`
        : `ดึงข้อมูลชุดที่ ${nextPage} แล้ว กดอีกครั้งเพื่อค้นหาคำใกล้เคียงเพิ่มเติม`,
      false,
      3500
    );
  } catch (err) {
    showToast(`เกิดข้อผิดพลาดในการโหลดเพิ่ม: ${err.message}`, false, 4000);
  } finally {
    state.isLoadingMore = false;
    if (loadMoreBtn) loadMoreBtn.disabled = false;
    if (loadMoreSpinner) loadMoreSpinner.classList.add("hidden");
    if (loadMoreText) loadMoreText.textContent = "⬇ โหลดวิดีโอเพิ่ม (+100 คลิป)";
  }
}

// Perform Shopee Link Analysis & Background Video Search (with fallback for direct Douyin/Bilibili links)
async function resolveDirectUrl(rawUrl, customKeyword = "") {
  const text = (rawUrl || "").trim();
  if (!text) return;

  const lower = text.toLowerCase();
  const isVideoDirect =
    anyMatch(lower, ["douyin.com", "iesdouyin.com", "bilibili.com", "b23.tv"]) &&
    !anyMatch(lower, ["shopee", "shp.ee"]);

  if (isVideoDirect) {
    return resolveVideoDirectLink(text);
  }

  resolveBtn.disabled = true;
  loadingState.classList.remove("hidden");
  emptyState.classList.add("hidden");
  showToast("กำลังค้นหาวิดีโอที่เกี่ยวข้อง...", true, 0);

  try {
    const resp = await fetch("/api/shopee-analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: text,
        custom_keyword: customKeyword || "",
        platform: "all",
        limit: BATCH_LIMIT_PER_PLATFORM,
      }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      throw new Error(data.detail || "ไม่สามารถอ่านข้อมูลจากลิงก์ Shopee นี้ได้");
    }

    const product = data.product;
    const search = data.search || {};

    renderShopeeProductCard(product, search);

    // Populate video grid with the background search results
    state.keyword = search.keyword || product.zh_keyword || "";
    state.displayLabel = product.thai_keyword || state.keyword;
    state.page = 1;
    state.items = search.items || [];
    searchInput.value = state.displayLabel;

    updateSummaryMeta();
    renderGrid();

    if (state.items.length > 0) {
      paginationBar.classList.remove("hidden");
    }

    showToast(
      `พบ ${state.items.length} วิดีโอที่เกี่ยวข้องกับสินค้า!`,
      false,
      3500
    );
  } catch (err) {
    showToast(err.message, false, 4500);
    if (state.items.length === 0) {
      emptyState.classList.remove("hidden");
    }
  } finally {
    loadingState.classList.add("hidden");
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

  const highlightsHtml =
    product.description_highlights && product.description_highlights.length > 0
      ? `<div class="flex flex-wrap gap-1.5 pt-1">
          ${product.description_highlights
            .map(
              (h) =>
                `<span class="px-2.5 py-0.5 rounded-md bg-slate-900 text-slate-300 border border-slate-800 text-[11px]">✨ ${escapeHtml(h)}</span>`
            )
            .join("")}
        </div>`
      : "";

  const suggestionsHtml = (product.suggested_keywords || [])
    .map((s) => {
      const isActive = s.keyword === (search.keyword || product.zh_keyword);
      return `<button
        type="button"
        data-zh-kw="${escapeHtml(s.keyword)}"
        class="shopee-zh-chip px-3 py-1.5 rounded-xl text-xs font-semibold transition border ${
          isActive
            ? "bg-orange-500 text-white border-orange-400 shadow-md shadow-orange-500/20"
            : "bg-slate-900 hover:bg-slate-800 text-slate-200 border-slate-700"
        }"
      >
        🔍 ${escapeHtml(s.label)}
      </button>`;
    })
    .join("");

  resolvedContainer.innerHTML = `
    <div class="flex flex-col lg:flex-row gap-5 items-start bg-slate-950/90 p-4 sm:p-5 rounded-xl border border-orange-500/30">
      <!-- Product Image -->
      <div class="relative w-32 h-32 sm:w-40 sm:h-40 rounded-xl overflow-hidden bg-slate-900 border border-slate-800 shrink-0 mx-auto lg:mx-0">
        <img
          src="${proxyImg(product.image)}"
          alt="${escapeHtml(product.title)}"
          class="w-full h-full object-cover"
        />
        <div class="absolute top-1.5 left-1.5">
          <span class="px-2 py-0.5 rounded bg-orange-600/95 text-white text-[10px] font-bold shadow">
            Shopee TH
          </span>
        </div>
      </div>

      <!-- Product Metadata -->
      <div class="flex-1 min-w-0 space-y-3 w-full">
        <div class="flex flex-wrap items-center gap-2 text-xs">
          <span class="px-2.5 py-0.5 rounded-md bg-orange-500/20 text-orange-300 border border-orange-500/30 font-semibold">
            Shopee
          </span>
          ${
            product.price
              ? `<span class="px-2 py-0.5 rounded-md bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 font-bold">฿${escapeHtml(String(product.price))}</span>`
              : ""
          }
          ${
            product.shop_id
              ? `<span class="text-slate-400">Shop ID: <code class="text-slate-200">${escapeHtml(product.shop_id)}</code></span>`
              : ""
          }
          ${
            product.item_id
              ? `<span class="text-slate-400">• Item ID: <code class="text-slate-200">${escapeHtml(product.item_id)}</code></span>`
              : ""
          }
          <a href="${escapeHtml(product.canonical_url || product.input_url)}" target="_blank" rel="noopener" class="text-orange-400 hover:underline ml-auto">
            เปิดหน้าสินค้าใน Shopee ↗
          </a>
        </div>

        <div>
          <div class="text-[11px] text-slate-400 mb-0.5">สินค้า:</div>
          <h4 class="text-sm sm:text-base font-bold text-white leading-snug">
            ${escapeHtml(product.title)}
          </h4>
        </div>

        ${highlightsHtml}

        <!-- Product Keyword Bar -->
        <div class="p-3 rounded-xl bg-slate-900/90 border border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div class="flex flex-wrap items-center gap-1.5 text-xs">
            <span class="text-slate-400 mr-1">คำค้นหาวิดีโอ:</span>
            ${(product.thai_keyword || "")
              .split(/[,|]+/)
              .map((k) => k.trim())
              .filter(Boolean)
              .map(
                (k) =>
                  `<span class="px-2.5 py-1 rounded-lg bg-orange-500/15 text-orange-300 border border-orange-500/30 font-bold">${escapeHtml(k)}</span>`
              )
              .join('<span class="text-slate-500 font-bold">+</span>')}
          </div>

          <!-- Inline Custom Product Keyword Override -->
          <form id="customShopeeKwForm" class="flex items-center gap-1.5 shrink-0">
            <input
              id="customShopeeKwInput"
              type="text"
              value="${escapeHtml(product.thai_keyword)}"
              placeholder="ค้นหลายคำได้ เช่น ขาตั้งกล้อง, ไม้กันสั่น"
              class="px-2.5 py-1.5 rounded-lg bg-slate-950 border border-slate-700 text-xs text-white focus:outline-none focus:border-orange-500 w-48 sm:w-56"
            />
            <button
              type="submit"
              class="px-3 py-1.5 rounded-lg bg-orange-600 hover:bg-orange-500 text-white text-xs font-semibold transition"
            >
              ค้นหาใหม่
            </button>
          </form>
        </div>

        <!-- Angle Chips -->
        <div class="space-y-1.5">
          <div class="flex flex-wrap gap-2">
            ${suggestionsHtml}
          </div>
        </div>
      </div>
    </div>
  `;

  // Bind clickable Chinese keyword angle chips
  resolvedContainer.querySelectorAll(".shopee-zh-chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      const zhKw = btn.getAttribute("data-zh-kw");
      if (!zhKw) return;
      resolvedContainer.querySelectorAll(".shopee-zh-chip").forEach((b) => {
        b.className =
          "shopee-zh-chip px-3 py-1.5 rounded-xl text-xs font-semibold transition border bg-slate-900 hover:bg-slate-800 text-slate-200 border-slate-700";
      });
      btn.className =
        "shopee-zh-chip px-3 py-1.5 rounded-xl text-xs font-semibold transition border bg-orange-500 text-white border-orange-400 shadow-md shadow-orange-500/20";
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
  } finally {
    resolveBtn.disabled = false;
  }
}

function renderResolvedCard(item) {
  const meta = getPlatformMeta(item.platform);
  resolvedSection.classList.remove("hidden");

  resolvedContainer.innerHTML = `
    <div class="flex flex-col md:flex-row gap-5 items-start md:items-center bg-slate-950/80 p-4 rounded-xl border border-slate-800">
      <div class="relative w-full md:w-64 aspect-video rounded-xl overflow-hidden bg-slate-900 shrink-0 cursor-pointer" id="resolvedThumb">
        <img src="${proxyImg(item.cover)}" alt="${escapeHtml(item.title)}" class="w-full h-full object-cover" />
        <div class="absolute top-2 left-2">
          <span class="${meta.badgeClass} px-2.5 py-1 rounded-lg text-[11px] font-bold">
            ${meta.shortLabel}
          </span>
        </div>
        ${
          item.duration
            ? `<span class="absolute bottom-2 right-2 px-2 py-0.5 rounded bg-black/80 text-[11px] font-mono text-white">${escapeHtml(item.duration)}</span>`
            : ""
        }
      </div>

      <div class="flex-1 min-w-0 space-y-2">
        <div class="flex items-center gap-2 flex-wrap">
          <span class="${meta.badgeClass} px-2.5 py-0.5 rounded-md text-xs font-bold">${meta.shortLabel}</span>
          <span class="text-xs text-slate-400">ID: <code class="text-slate-300">${escapeHtml(item.id)}</code></span>
        </div>
        <h4 class="text-base font-bold text-white leading-snug">${escapeHtml(item.title)}</h4>
        <p class="text-xs text-slate-400">
          ผู้โพสต์: <strong class="text-slate-200">${escapeHtml(item.author)}</strong>
          • ❤️ ${formatNumber(item.likes)}
          ${item.views ? `• 👁️ ${formatNumber(item.views)}` : ""}
        </p>

        <div class="pt-2 flex flex-wrap items-center gap-2.5">
          <button id="resolvedPreviewBtn" type="button" class="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-white text-xs font-semibold transition">
            ▶ ดูตัวอย่างคลิป
          </button>
          <button id="resolvedDlMp4Btn" type="button" class="px-5 py-2 rounded-xl ${meta.btnBg} text-white text-xs font-semibold shadow-lg transition">
            ⬇ ดาวน์โหลดวิดีโอ (.MP4 ไร้ลายน้ำ)
          </button>
          <button id="resolvedDlMp3Btn" type="button" class="px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold transition">
            🎵 โหลดเฉพาะเสียง (.MP3)
          </button>
        </div>
      </div>
    </div>
  `;

  document.getElementById("resolvedThumb").onclick = () => openPreviewModal(item);
  document.getElementById("resolvedPreviewBtn").onclick = () => openPreviewModal(item);
  document.getElementById("resolvedDlMp4Btn").onclick = () => triggerDownload(item, false);
  document.getElementById("resolvedDlMp3Btn").onclick = () => triggerDownload(item, true);
  resolvedSection.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// Open Video Preview Modal
function openPreviewModal(item) {
  state.currentModalItem = item;
  const meta = getPlatformMeta(item.platform);

  modalPlatformBadge.className = `${meta.badgeClass} px-2.5 py-1 rounded-md text-xs font-bold shrink-0`;
  modalPlatformBadge.textContent = meta.shortLabel;
  modalTitle.textContent = item.title;
  modalAuthor.textContent = item.author;
  modalOriginalLink.href = item.url;

  const streamUrl = `/api/stream?platform=${encodeURIComponent(item.platform)}&id=${encodeURIComponent(item.id)}&direct_url=${encodeURIComponent(item.direct_video_url || "")}`;
  modalVideo.src = streamUrl;
  previewModal.classList.remove("hidden");
  modalVideo.play().catch(() => {});
}

function closePreviewModal() {
  modalVideo.pause();
  modalVideo.removeAttribute("src");
  modalVideo.load();
  previewModal.classList.add("hidden");
  state.currentModalItem = null;
}

// Trigger File Download
function triggerDownload(item, audioOnly = false) {
  const extLabel = audioOnly ? "MP3 (เสียง)" : "MP4 (วิดีโอไร้ลายน้ำ)";
  showToast(
    `กำลังเตรียมไฟล์ ${extLabel} จาก ${item.platform_label} กรุณารอสักครู่...`,
    true,
    0
  );

  const dlUrl = `/api/download?platform=${encodeURIComponent(item.platform)}&id=${encodeURIComponent(item.id)}&title=${encodeURIComponent(item.title || "video")}&audio_only=${audioOnly}`;

  const a = document.createElement("a");
  a.href = dlUrl;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  setTimeout(() => {
    showToast(`เริ่มดาวน์โหลด ${extLabel} แล้ว!`, false, 4000);
  }, 2500);
}

// Event Listeners
searchForm.addEventListener("submit", (e) => {
  e.preventDefault();
  performSearch(searchInput.value, 1);
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

pasteClipboardBtn.addEventListener("click", async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      resolveInput.value = text;
      resolveDirectUrl(text);
    }
  } catch (err) {
    showToast("กรุณากด Ctrl+V เพื่อวางลิงก์ในช่อง");
    resolveInput.focus();
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
