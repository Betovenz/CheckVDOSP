/**
 * ============================================================================
 * PAGE 2: AI Video Maker Studio Engine (Adapted from Make VSO)
 * ============================================================================
 * Features:
 * 1. Receive clips from Page 1 (Douyin/Bilibili) or upload from PC (.mp4/.mov/.webm)
 * 2. Auto-mute 100% original clip audio & Auto-cut / Random Shuffle remixing
 *    with local RAM Blob caching + frame buffer so Preview Video plays immediately!
 * 3. Word-safe Thai line wrapping via Intl.Segmenter('th', { granularity: 'word' })
 *    so Header & Subtitles NEVER split a Thai word in half!
 * 4. Natural, realistic script generation (calls product by simple category noun,
 *    never reads full Shopee title or exaggerates)
 */

(function () {
  const STUDIO_TEMPLATES = [
    {
      id: "clean-no-anim",
      name: "✨ Clean / มาตรฐาน (ไม่มีอนิเมชั่น)",
      badge: "คลีนมินิมอล • ยอดนิยม",
      desc: "วิดีโอเต็มจอ 9:16 คมชัด เรียบหรู ไม่มีคลื่นเสียงหรือเส้นวิ่งกวนสายตา (แนะนำ)",
      accentColor: "#fde047",
      secondaryColor: "#ffffff",
      frameMode: "full",
      noAnimation: true,
    },
    {
      id: "slide-zoom",
      name: "✨ Slide Zoom Classic",
      badge: "เต็มจอ • ซูมสมูท",
      desc: "เต็มจอ 9:16 ซูมแพนภาพนุ่มนวล + คลื่นเสียงด้านล่าง",
      accentColor: "#fde047",
      secondaryColor: "#38bdf8",
      frameMode: "full",
    },
    {
      id: "tiktok-pop-sticker",
      name: "🔥 TikTok Pop Promo",
      badge: "ป้ายยาขายดี • ป๊อปอาร์ต",
      desc: "กรอบมนขอบนีออน + ป้าย HOT DEAL เด้งดึ๋งสไตล์ TikTok",
      accentColor: "#f43f5e",
      secondaryColor: "#fde047",
      frameMode: "pop-card",
    },
    {
      id: "creator-kinetic-pop",
      name: "💎 Creator Kinetic 3D",
      badge: "การ์ดเรืองแสง • ทันสมัย",
      desc: "กรอบการ์ดไฟนีออน + วงแหวนนับฉากและกราฟิกลอยตัว",
      accentColor: "#4ade80",
      secondaryColor: "#38bdf8",
      frameMode: "bento-3d",
    },
    {
      id: "breaking-news-hud",
      name: "📺 Breaking Review",
      badge: "ป้าย LIVE + ตัววิ่ง",
      desc: "เต็มจอพร้อมป้าย LIVE รีวิวเดือด + แถบตัววิ่งด้านล่าง",
      accentColor: "#ef4444",
      secondaryColor: "#fde047",
      frameMode: "full",
    },
    {
      id: "cyberpunk-tech-hud",
      name: "⚡ Cyber Scanner HUD",
      badge: "สแกนสินค้า • สายเทค",
      desc: "เส้นเลเซอร์สแกนสินค้าขึ้น-ลง + กรอบเล็งเรดาร์ไฮเทค",
      accentColor: "#22d3ee",
      secondaryColor: "#e879f9",
      frameMode: "full",
    },
    {
      id: "cinematic-letterbox",
      name: "🎥 Cinema Viewfinder",
      badge: "ช่องมองกล้อง • พรีเมียม",
      desc: "กรอบกล้อง REC 4K + แสงแฟลร์อบอุ่นสไตล์รีวิวพรีเมียม",
      accentColor: "#f59e0b",
      secondaryColor: "#ef4444",
      frameMode: "full",
    },
  ];

  const ZOOM_EFFECTS = [
    "static",
    "zoomIn",
    "static",
    "zoomOut",
    "kenBurns",
    "static",
    "panLeft",
    "panRight",
  ];
  const TRANSITION_POOL = ["dissolve", "none", "cross-zoom", "dissolve", "whip-slide"];

  // Thai Word Segmenter (Guarantees Thai words are NEVER broken in the middle!)
  const thaiWordSegmenter =
    typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
      ? new Intl.Segmenter("th", { granularity: "word" })
      : null;

  function segmentThaiWords(text) {
    const clean = String(text || "").replace(/\s+/g, " ").trim();
    if (!clean) return [];
    let raw = [];
    if (thaiWordSegmenter) {
      for (const part of thaiWordSegmenter.segment(clean)) {
        raw.push(part.segment);
      }
    } else {
      raw = clean.split(" ");
    }

    // Merge invalid word-initial tokens into the previous token:
    // 1. Combining marks (vowels, tone marks, garan): ิ, ี, ึ, ื, ุ, ู, ฺ, ์, ่, ้, ๊, ๋, ็, ํ
    // 2. Orphan loanword suffix endings like 'อร์', 'ร์', 'ต์', 'ทร์', 'ตร์', 'ค์', 'ส์', 'ก์', 'ฟ์', 'ดร์', 'ม์', 'นท์'
    // 3. Suffix endings with garan like 'เตอร์', 'เดอร์', 'เกอร์', 'เซอร์', 'เวอร์', 'เบอร์'
    // 4. Isolated single Thai consonants
    const isOrphan = (t) => {
      if (!t) return false;
      if (/^[\u0e31\u0e34-\u0e3a\u0e47-\u0e4e]/.test(t)) return true;
      if (/^([ก-ฮ]?\u0e4c|อ[ก-ฮ]\u0e4c|[ก-ฮ]{1,2}\u0e4c)$/.test(t)) return true;
      if (/^เ[ก-ฮ]{1,3}\u0e4c$/.test(t)) return true;
      if (/^[ก-ฮ]$/.test(t)) return true;
      return false;
    };

    const tokens = [];
    for (let i = 0; i < raw.length; i++) {
      const tok = raw[i];
      if (isOrphan(tok) && tokens.length > 0 && !tokens[tokens.length - 1].endsWith(" ")) {
        tokens[tokens.length - 1] += tok;
      } else {
        tokens.push(tok);
      }
    }
    return tokens;
  }

  /**
   * Wrap Thai/English text into lines ONLY at whole-word boundaries (NEVER splits a word in half).
   */
  function wrapThaiTextByWords(ctx, text, maxWidth, maxLines = 2) {
    const clean = String(text || "").replace(/\s+/g, " ").trim();
    if (!clean) return [];
    if (ctx.measureText(clean).width <= maxWidth) {
      return [clean];
    }

    // If text has natural spaces (like "พรีวิววิดีโอได้ทันที เรนเดอร์ไฟล์ MP4 คมชัด"),
    // prioritize breaking at existing space boundaries without splitting words!
    if (clean.includes(" ")) {
      const spaceWords = clean.split(" ").filter(Boolean);
      const spaceLines = [];
      let curLine = "";
      let spaceWrapOk = true;
      for (const w of spaceWords) {
        const candidate = curLine ? `${curLine} ${w}` : w;
        if (ctx.measureText(candidate).width <= maxWidth) {
          curLine = candidate;
        } else {
          if (ctx.measureText(w).width > maxWidth) {
            spaceWrapOk = false;
            break;
          }
          if (curLine) spaceLines.push(curLine);
          curLine = w;
        }
      }
      if (curLine) spaceLines.push(curLine);
      if (spaceWrapOk && spaceLines.length <= maxLines) {
        return spaceLines;
      }
    }

    const tokens = segmentThaiWords(clean);
    // Group into non-empty word chunks while preserving spaces
    const lines = [];
    let currentLine = "";

    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      const candidate = currentLine + tok;
      if (ctx.measureText(candidate.trim()).width > maxWidth && currentLine.trim().length > 0) {
        lines.push(currentLine.trim());
        currentLine = tok.trimStart();
      } else {
        currentLine = candidate;
      }
    }
    if (currentLine.trim()) {
      lines.push(currentLine.trim());
    }

    // If we got 2 lines and the second line is super short while first is huge, balance by word boundaries
    if (lines.length === 2) {
      const wordList = tokens.filter((t) => t.trim().length > 0);
      if (wordList.length >= 2) {
        let bestIdx = 1;
        let bestDiff = 999999;
        for (let splitAt = 1; splitAt < wordList.length; splitAt++) {
          const topStr = tokens
            .slice(0, tokens.indexOf(wordList[splitAt]))
            .join("")
            .trim();
          const botStr = tokens
            .slice(tokens.indexOf(wordList[splitAt]))
            .join("")
            .trim();
          if (!topStr || !botStr) continue;
          const w1 = ctx.measureText(topStr).width;
          const w2 = ctx.measureText(botStr).width;
          if (w1 <= maxWidth * 1.08 && w2 <= maxWidth * 1.08) {
            const diff = Math.abs(w1 - w2);
            if (diff < bestDiff) {
              bestDiff = diff;
              bestIdx = splitAt;
            }
          }
        }
        // Rebuild balanced 2 lines using word tokens
        let accWords = 0;
        let topPart = "";
        let botPart = "";
        for (const t of tokens) {
          if (accWords < bestIdx) {
            topPart += t;
            if (t.trim().length > 0) accWords++;
          } else {
            botPart += t;
          }
        }
        if (topPart.trim() && botPart.trim()) {
          return [topPart.trim(), botPart.trim()];
        }
      }
    }

    if (lines.length > maxLines) {
      const head = lines.slice(0, maxLines - 1);
      const tail = lines.slice(maxLines - 1).join(" ");
      return [...head, tail];
    }
    return lines;
  }

  // Hidden DOM container so Chrome/Edge hardware-decodes <video> frames immediately
  let hiddenVideoPool = document.getElementById("studioHiddenVideoPool");
  if (!hiddenVideoPool) {
    hiddenVideoPool = document.createElement("div");
    hiddenVideoPool.id = "studioHiddenVideoPool";
    hiddenVideoPool.style.cssText =
      "position:fixed;left:0;top:0;width:2px;height:2px;overflow:hidden;opacity:0.001;pointer-events:none;z-index:-1;";
    document.body.appendChild(hiddenVideoPool);
  }

  const studioState = {
    activePage: "search", // 'search' | 'studio'
    clips: [], // { id, title, platform, url, blobUrl, thumb, thumbImg, videoEl, lastFrameCanvas, hasDecodedFrame, duration, sourceLabel, isCaching }
    cutSegments: [], // { index, start, duration, clipId, trimStart, zoomEffect, transition }
    selectedTemplateId: "clean-no-anim",
    exportResolution: "720p",
    cutPaceSec: 4.0,
    transitionMode: "none",

    // Header Config (Strictly NO background box behind Header, large bold with thick stroke)
    showHeader: true,
    headerText: "ของใช้ตรงปก หยิบใช้ง่ายสะดวก",
    headerFontSize: 100,
    headerColor: "#fde047",
    headerStrokeColor: "#000000",
    headerStrokeWidth: 20,
    // Vertical position (center, % of frame height). Horizontal stays centered.
    headerPosY: 13.5,
    subPosY: 77,

    // Subtitle Config
    showSubtitles: true,
    scenes: [
      {
        index: 0,
        start: 0,
        duration: 5,
        line_top: "ส่งคลิปเข้าสตูดิโอ",
        line_bottom: "ตัดสลับฉากให้อัตโนมัติ",
        full_narration: "ส่งคลิปเข้าสตูดิโอ ตัดสลับฉากให้อัตโนมัติ",
      },
      {
        index: 1,
        start: 5,
        duration: 5,
        line_top: "วางลิงก์สินค้า Shopee",
        line_bottom: "ให้ AI คิดบทพากย์",
        full_narration: "วางลิงก์สินค้า Shopee ให้ AI คิดบทพากย์",
      },
      {
        index: 2,
        start: 10,
        duration: 5,
        line_top: "บอกแค่ว่าเป็นสินค้าอะไร",
        line_bottom: "รีวิวจริงไม่ขายเว่อร์",
        full_narration: "บอกแค่ว่าเป็นสินค้าอะไร รีวิวจริงไม่ขายเว่อร์",
      },
      {
        index: 3,
        start: 15,
        duration: 5,
        line_top: "พรีวิววิดีโอได้ทันที",
        line_bottom: "เรนเดอร์ไฟล์ MP4 คมชัด",
        full_narration: "พรีวิววิดีโอได้ทันที เรนเดอร์ไฟล์ MP4 คมชัด",
      },
    ],
    spokenScript:
      "ส่งคลิปเข้าสตูดิโอ ตัดสลับฉากให้อัตโนมัติ วางลิงก์สินค้า Shopee ให้ AI คิดบทพากย์ บอกแค่ว่าเป็นสินค้าอะไร รีวิวจริงไม่ขายเว่อร์ พรีวิววิดีโอได้ทันที เรนเดอร์ไฟล์ MP4 คมชัด",
    subFontSize: 76,
    subStrokeWidth: 16,
    subShowBg: false,

    // Audio & Playback State
    totalDuration: 20.0,
    currentTime: 0.0,
    isPlaying: false,
    isVoiceMuted: false,
    isOriginalAudioMuted: true,
    isCensoring: false,
    blurChineseMode: "off", // "off" | "bottom" | "both"
    isExporting: false,
    voiceAudio: null,
    voiceAudioDataUrl: "",
    voiceEngineLabel: "9:16 Full HD (1080×1920)",

    // Exported MP4
    lastExportedMp4Url: "",
    lastExportedMp4Blob: null,

    // API Keys
    geminiKeysText: "",
    openrouterKeysText: "",
  };

  // DOM Elements
  const navPage1Btn = document.getElementById("navPage1Btn");
  const navPage2Btn = document.getElementById("navPage2Btn");
  const studioClipCountBadge = document.getElementById("studioClipCountBadge");
  const pageSearchView = document.getElementById("pageSearchView");
  const pageStudioView = document.getElementById("pageStudioView");

  const openApiKeyModalBtn = document.getElementById("openApiKeyModalBtn");
  const openApiKeyModalBtnMobile = document.getElementById("openApiKeyModalBtnMobile");
  const studioOpenApiBtn = document.getElementById("studioOpenApiBtn");
  const apiKeyModal = document.getElementById("apiKeyModal");
  const closeApiKeyModalBtn = document.getElementById("closeApiKeyModalBtn");
  const geminiApiKeysInput = document.getElementById("geminiApiKeysInput");
  const openrouterApiKeysInput = document.getElementById("openrouterApiKeysInput");
  const geminiSavedKeysList = document.getElementById("geminiSavedKeysList");
  const openrouterSavedKeysList = document.getElementById("openrouterSavedKeysList");
  const testApiKeyBtn = document.getElementById("testApiKeyBtn");
  const saveApiKeyBtn = document.getElementById("saveApiKeyBtn");
  const apiKeyStatusBox = document.getElementById("apiKeyStatusBox");
  const apiKeyStatusDot = document.getElementById("apiKeyStatusDot");

  const studioBackToSearchBtn = document.getElementById("studioBackToSearchBtn");
  const studioGoSearchClipsBtn = document.getElementById("studioGoSearchClipsBtn");
  const studioPcVideoInput = document.getElementById("studioPcVideoInput");
  const studioLinkInput = document.getElementById("studioLinkInput");
  const studioAddLinkBtn = document.getElementById("studioAddLinkBtn");
  const studioClipsList = document.getElementById("studioClipsList");
  const studioQueueCountText = document.getElementById("studioQueueCountText");
  const studioClearClipsBtn = document.getElementById("studioClearClipsBtn");
  const studioToggleOriginalAudioBtn = document.getElementById("studioToggleOriginalAudioBtn");
  const studioOriginalAudioIcon = document.getElementById("studioOriginalAudioIcon");
  const studioOriginalAudioText = document.getElementById("studioOriginalAudioText");
  const studioCutPaceSelect = document.getElementById("studioCutPaceSelect");
  const studioTransitionSelect = document.getElementById("studioTransitionSelect");
  const studioReshuffleBtn = document.getElementById("studioReshuffleBtn");

  const studioShopeeUrlInput = document.getElementById("studioShopeeUrlInput");
  const studioPasteShopeeBtn = document.getElementById("studioPasteShopeeBtn");
  const studioFetchShopeeBtn = document.getElementById("studioFetchShopeeBtn");
  const studioShopeeSyncBadge = document.getElementById("studioShopeeSyncBadge");
  const studioProductTitle = document.getElementById("studioProductTitle");
  const studioProductDesc = document.getElementById("studioProductDesc");
  const studioTargetDuration = document.getElementById("studioTargetDuration");
  const studioSalesAngle = document.getElementById("studioSalesAngle");
  const studioVoiceSelect = document.getElementById("studioVoiceSelect");
  const studioVoiceSpeed = document.getElementById("studioVoiceSpeed");
  const studioGenerateAllBtn = document.getElementById("studioGenerateAllBtn");
  const studioGenSpinner = document.getElementById("studioGenSpinner");
  const studioGenBtnText = document.getElementById("studioGenBtnText");

  const studioTemplateGrid = document.getElementById("studioTemplateGrid");
  const studioHeaderInput = document.getElementById("studioHeaderInput");
  const studioToggleHeaderCheck = document.getElementById("studioToggleHeaderCheck");
  const studioHeaderSizeRange = document.getElementById("studioHeaderSizeRange");
  const studioHeaderSizeVal = document.getElementById("studioHeaderSizeVal");
  const studioHeaderStrokeRange = document.getElementById("studioHeaderStrokeRange");
  const studioHeaderStrokeVal = document.getElementById("studioHeaderStrokeVal");
  const studioHeaderColor = document.getElementById("studioHeaderColor");
  const studioHeaderStrokeColor = document.getElementById("studioHeaderStrokeColor");

  const studioScriptTextarea = document.getElementById("studioScriptTextarea");
  const studioRevoiceBtn = document.getElementById("studioRevoiceBtn");
  const studioSubSizeRange = document.getElementById("studioSubSizeRange");
  const studioSubSizeVal = document.getElementById("studioSubSizeVal");
  const studioSubStrokeRange = document.getElementById("studioSubStrokeRange");
  const studioSubStrokeVal = document.getElementById("studioSubStrokeVal");
  const studioSubBgCheck = document.getElementById("studioSubBgCheck");
  const studioToggleSubCheck = document.getElementById("studioToggleSubCheck");

  const studioPreviewCanvas = document.getElementById("studioPreviewCanvas");
  const studioCanvasPlayOverlay = document.getElementById("studioCanvasPlayOverlay");
  const studioTimelineScrubber = document.getElementById("studioTimelineScrubber");
  const studioPlayPauseBtn = document.getElementById("studioPlayPauseBtn");
  const studioRestartBtn = document.getElementById("studioRestartBtn");
  const studioMuteVoiceBtn = document.getElementById("studioMuteVoiceBtn");
  const studioMuteOriginalBtn = document.getElementById("studioMuteOriginalBtn");
  const studioBlurChineseBtn = document.getElementById("studioBlurChineseBtn");
  const studioTimecodeText = document.getElementById("studioTimecodeText");
  const studioVoiceEngineBadge = document.getElementById("studioVoiceEngineBadge");
  const studioCutSummaryText = document.getElementById("studioCutSummaryText");
  const studioCutPreviewStrip = document.getElementById("studioCutPreviewStrip");

  const studioResolutionSelect = document.getElementById("studioResolutionSelect");
  const studioExportMp4Btn = document.getElementById("studioExportMp4Btn");
  const studioExportProgressWrap = document.getElementById("studioExportProgressWrap");
  const studioExportProgressText = document.getElementById("studioExportProgressText");
  const studioExportPctText = document.getElementById("studioExportPctText");
  const studioExportProgressBar = document.getElementById("studioExportProgressBar");

  const studioFinalMp4Card = document.getElementById("studioFinalMp4Card");
  const studioFinalVideoPlayer = document.getElementById("studioFinalVideoPlayer");
  const studioDownloadFinalMp4Btn = document.getElementById("studioDownloadFinalMp4Btn");

  // Page 3 borrows this engine: a project's clips/script/voice are swapped into studioState
  // ("batch" context) and the preview draws on the page-3 canvas instead of page 2's.
  let engineCtx = "page2"; // "page2" | "batch"
  let previewCanvasEl = studioPreviewCanvas;
  function isEngineVisible() {
    return engineCtx === "batch"
      ? studioState.activePage === "batch"
      : studioState.activePage === "studio";
  }

  function toast(msg, loading = false, dur = 3500) {
    if (typeof window.showToast === "function") {
      window.showToast(msg, loading, dur);
    }
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
  // 1. PAGE SWITCHER (Page 1: Search <-> Page 2: AI Video Studio)
  // ---------------------------------------------------------------------------
  function switchAppPage(targetPage) {
    const target = targetPage === "studio" || targetPage === "batch" ? targetPage : "search";
    const prev = studioState.activePage;
    // Page 3 owns the engine while it renders a batch / shows a project preview
    if (prev === "batch" && target !== "batch" && window.BatchApp && typeof window.BatchApp.beforeLeave === "function") {
      if (window.BatchApp.beforeLeave() === false) return;
    }
    studioState.activePage = target;
    const isStudio = target === "studio";
    const isBatch = target === "batch";

    if (pageSearchView) pageSearchView.classList.toggle("hidden", target !== "search");
    if (pageStudioView) pageStudioView.classList.toggle("hidden", !isStudio);
    const pageBatchView = document.getElementById("pageBatchView");
    if (pageBatchView) pageBatchView.classList.toggle("hidden", !isBatch);

    const activeCls =
      "px-3 py-2 rounded-xl text-xs sm:text-sm font-bold transition flex items-center gap-1.5 whitespace-nowrap bg-gradient-to-r from-rose-500 via-indigo-500 to-sky-500 text-white shadow-md";
    const inactiveCls =
      "px-3 py-2 rounded-xl text-xs sm:text-sm font-bold transition flex items-center gap-1.5 whitespace-nowrap text-slate-300 hover:text-white";

    if (navPage1Btn) navPage1Btn.className = target === "search" ? activeCls : inactiveCls;
    if (navPage2Btn) navPage2Btn.className = isStudio ? activeCls : inactiveCls;
    const navPage3Btn = document.getElementById("navPage3Btn");
    if (navPage3Btn) navPage3Btn.className = isBatch ? activeCls : inactiveCls;

    if (isBatch) {
      pauseStudioPreview();
      if (window.BatchApp && typeof window.BatchApp.onShow === "function") window.BatchApp.onShow();
      return;
    }
    if (!isStudio) {
      pauseStudioPreview();
    } else {
      if (typeof window.getAppLastShopeeProduct === "function") {
        const lastProd = window.getAppLastShopeeProduct();
        if (lastProd && (!studioProductTitle || !studioProductTitle.value.trim())) {
          syncShopeeProduct(lastProd, true);
        }
      }
      // Automatically start playing the random cut preview if we have clips!
      if (studioState.clips.length > 0 && !studioState.isPlaying) {
        startStudioPreview();
      } else {
        renderCurrentStudioFrame();
      }
    }
  }

  window.switchAppPage = switchAppPage;

  // ---------------------------------------------------------------------------
  // 2. GOOGLE AI API KEY MANAGER
  // ---------------------------------------------------------------------------
  async function loadStudioConfigFromServer() {
    const localKeys = normalizeApiKeysText(localStorage.getItem("studio_gemini_api_keys") || "");
    const localOrKeys = normalizeOpenRouterKeysText(localStorage.getItem("studio_openrouter_api_keys") || "");
    if (localKeys) {
      studioState.geminiKeysText = localKeys;
      if (geminiApiKeysInput) geminiApiKeysInput.value = localKeys;
    }
    if (localOrKeys) {
      studioState.openrouterKeysText = localOrKeys;
      if (openrouterApiKeysInput) openrouterApiKeysInput.value = localOrKeys;
    }
    updateApiKeyDot(studioState.geminiKeysText, studioState.openrouterKeysText);
    updateVoiceAvailability();
    try {
      const localPrefs = JSON.parse(localStorage.getItem("studio_preferences") || "null");
      if (localPrefs && typeof localPrefs === "object") {
        applyStudioPreferences(localPrefs);
      }
    } catch (_) {}
    try {
      const resp = await fetch("/api/studio/config");
      if (!resp.ok) return;
      const data = await resp.json();
      const serverKeys = normalizeApiKeysText(data.gemini_api_keys_text || "");
      const serverOrKeys = normalizeOpenRouterKeysText(data.openrouter_api_keys_text || "");
      if (serverKeys) {
        studioState.geminiKeysText = serverKeys;
        if (geminiApiKeysInput) geminiApiKeysInput.value = serverKeys;
        localStorage.setItem("studio_gemini_api_keys", serverKeys);
      }
      if (serverOrKeys) {
        studioState.openrouterKeysText = serverOrKeys;
        if (openrouterApiKeysInput) openrouterApiKeysInput.value = serverOrKeys;
        localStorage.setItem("studio_openrouter_api_keys", serverOrKeys);
      }
      updateApiKeyDot(studioState.geminiKeysText, studioState.openrouterKeysText);
      updateVoiceAvailability();
      renderSavedApiKeysLists();
      if (data.preferences && typeof data.preferences === "object" && Object.keys(data.preferences).length > 0) {
        applyStudioPreferences(data.preferences);
        try {
          localStorage.setItem("studio_preferences", JSON.stringify(data.preferences));
        } catch (_) {}
      }
      const preferredVoice = (data.preferences && data.preferences.default_voice) || data.default_voice;
      if (preferredVoice && studioVoiceSelect) {
        const targetOpt = Array.from(studioVoiceSelect.options).find((o) => o.value === preferredVoice);
        if (targetOpt && !targetOpt.disabled) {
          studioVoiceSelect.value = preferredVoice;
        }
      }
    } catch (_) {}
  }

  function updateVoiceAvailability() {
    if (!studioVoiceSelect) return;
    const hasOpenRouter = Boolean((studioState.openrouterKeysText || "").trim());
    const hasGemini = Boolean((studioState.geminiKeysText || "").trim());
    Array.from(studioVoiceSelect.options).forEach((opt) => {
      const req = opt.getAttribute("data-requires");
      if (req === "openrouter") {
        opt.disabled = !hasOpenRouter;
      } else if (req === "gemini") {
        opt.disabled = !hasGemini;
      }
    });
    const currentOpt = studioVoiceSelect.selectedOptions?.[0];
    if (!currentOpt || currentOpt.disabled) {
      const firstEnabled = Array.from(studioVoiceSelect.options).find((o) => !o.disabled);
      if (firstEnabled) {
        studioVoiceSelect.value = firstEnabled.value;
      }
    }
  }

  function updateApiKeyDot(geminiText, openrouterText) {
    const hasKey = Boolean((geminiText || "").trim() || (openrouterText || "").trim());
    if (apiKeyStatusDot) {
      apiKeyStatusDot.className = hasKey
        ? "w-2 h-2 rounded-full bg-emerald-400 shadow shadow-emerald-400"
        : "w-2 h-2 rounded-full bg-slate-500";
    }
  }

  function openApiKeyModal() {
    if (apiKeyModal) apiKeyModal.classList.remove("hidden");
    if (apiKeyStatusBox) apiKeyStatusBox.classList.add("hidden");
    renderSavedApiKeysLists();
  }

  function closeApiKeyModal() {
    if (apiKeyModal) apiKeyModal.classList.add("hidden");
  }

  // One key per line; strip every space / invisible char inside a key (accidental spaces when
  // copying), and split keys glued on one line at each "AIza" prefix.
  function normalizeApiKeysText(text) {
    const keys = [];
    String(text || "")
      .split(/[\r\n,;]+/)
      .forEach((part) => {
        const compact = part.replace(/[\s ​-‍⁠﻿]+/g, "");
        if (!compact || /^http/i.test(compact)) return;
        const pieces = (compact.match(/AIza/g) || []).length > 1 ? compact.split(/(?=AIza)/) : [compact];
        pieces.forEach((k) => {
          if (k && !keys.includes(k)) keys.push(k);
        });
      });
    return keys.join("\n");
  }

  function normalizeOpenRouterKeysText(text) {
    const keys = [];
    String(text || "")
      .split(/[\r\n,;]+/)
      .forEach((part) => {
        const compact = part.replace(/[\s ​-‍⁠﻿]+/g, "");
        if (!compact || /^http/i.test(compact)) return;
        const pieces = (compact.match(/sk-or-/g) || []).length > 1 ? compact.split(/(?=sk-or-)/) : [compact];
        pieces.forEach((k) => {
          if (k && !keys.includes(k)) keys.push(k);
        });
      });
    return keys.join("\n");
  }

  function cleanApiKeysInput() {
    if (!geminiApiKeysInput) return "";
    const cleaned = normalizeApiKeysText(geminiApiKeysInput.value);
    if (geminiApiKeysInput.value !== cleaned) geminiApiKeysInput.value = cleaned;
    return cleaned;
  }

  function cleanOpenRouterKeysInput() {
    if (!openrouterApiKeysInput) return "";
    const cleaned = normalizeOpenRouterKeysText(openrouterApiKeysInput.value);
    if (openrouterApiKeysInput.value !== cleaned) openrouterApiKeysInput.value = cleaned;
    return cleaned;
  }

  function maskApiKey(k) {
    const s = String(k || "");
    if (s.length <= 16) return s;
    return `${s.slice(0, 10)}••••••${s.slice(-6)}`;
  }

  function renderSavedKeysFor(containerEl, keysText, kind) {
    if (!containerEl) return;
    const keys = String(keysText || "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    if (!keys.length) {
      containerEl.innerHTML = "";
      return;
    }
    containerEl.innerHTML = keys
      .map(
        (k, idx) => `
      <div class="flex items-center justify-between gap-2 px-2.5 py-1 rounded-lg bg-slate-950/90 border border-slate-800 text-[11px]">
        <span class="font-mono text-slate-300 truncate" title="${escapeHtml(k)}">#${idx + 1} ${escapeHtml(maskApiKey(k))}</span>
        <button
          type="button"
          data-remove-api-kind="${kind}"
          data-remove-api-idx="${idx}"
          class="px-2 py-0.5 rounded bg-rose-500/15 hover:bg-rose-600 text-rose-300 hover:text-white text-[10px] font-bold transition shrink-0"
        >
          ✕ ลบ
        </button>
      </div>`
      )
      .join("");

    containerEl.querySelectorAll("[data-remove-api-idx]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const removeIdx = Number(btn.getAttribute("data-remove-api-idx"));
        const targetKind = btn.getAttribute("data-remove-api-kind");
        const currentText = targetKind === "openrouter" ? cleanOpenRouterKeysInput() : cleanApiKeysInput();
        const arr = currentText.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
        arr.splice(removeIdx, 1);
        const nextText = arr.join("\n");
        if (targetKind === "openrouter") {
          if (openrouterApiKeysInput) openrouterApiKeysInput.value = nextText;
        } else {
          if (geminiApiKeysInput) geminiApiKeysInput.value = nextText;
        }
        await saveApiKeys();
      });
    });
  }

  function renderSavedApiKeysLists() {
    renderSavedKeysFor(openrouterSavedKeysList, openrouterApiKeysInput?.value || studioState.openrouterKeysText, "openrouter");
    renderSavedKeysFor(geminiSavedKeysList, geminiApiKeysInput?.value || studioState.geminiKeysText, "gemini");
  }

  geminiApiKeysInput?.addEventListener("paste", () => setTimeout(cleanApiKeysInput, 0));
  geminiApiKeysInput?.addEventListener("blur", cleanApiKeysInput);
  openrouterApiKeysInput?.addEventListener("paste", () => setTimeout(cleanOpenRouterKeysInput, 0));
  openrouterApiKeysInput?.addEventListener("blur", cleanOpenRouterKeysInput);

  async function saveApiKeys() {
    const raw = cleanApiKeysInput();
    const rawOr = cleanOpenRouterKeysInput();
    studioState.geminiKeysText = raw;
    studioState.openrouterKeysText = rawOr;
    localStorage.setItem("studio_gemini_api_keys", raw);
    localStorage.setItem("studio_openrouter_api_keys", rawOr);
    updateApiKeyDot(raw, rawOr);
    updateVoiceAvailability();
    renderSavedApiKeysLists();

    try {
      const resp = await fetch("/api/studio/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          gemini_api_keys: raw,
          openrouter_api_keys: rawOr,
          default_voice: studioVoiceSelect?.value || "Puck",
        }),
      });
      const data = await resp.json();
      const msg = `บันทึกสำเร็จ (OpenRouter: ${data.openrouter_key_count || 0} คีย์ • Google AI: ${data.key_count || 0} คีย์)`;
      showApiKeyNotice(msg, true);
      toast(msg);
    } catch (err) {
      showApiKeyNotice(`บันทึกลงเบราว์เซอร์แล้ว (${err.message})`, true);
    }
  }

  async function testApiKeys() {
    const raw = cleanApiKeysInput();
    const rawOr = cleanOpenRouterKeysInput();
    showApiKeyNotice("กำลังทดสอบการเชื่อมต่อ API Key...", true);
    try {
      const resp = await fetch("/api/studio/test-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: raw, openrouter_api_key: rawOr }),
      });
      const data = await resp.json();
      showApiKeyNotice(data.message || "ทดสอบเสร็จสิ้น", Boolean(data.valid));
    } catch (err) {
      showApiKeyNotice(`ทดสอบไม่สำเร็จ: ${err.message}`, false);
    }
  }

  function showApiKeyNotice(msg, isOk) {
    if (!apiKeyStatusBox) return;
    apiKeyStatusBox.classList.remove("hidden");
    apiKeyStatusBox.className = isOk
      ? "p-3 rounded-xl text-xs font-semibold bg-emerald-500/15 border border-emerald-500/40 text-emerald-300"
      : "p-3 rounded-xl text-xs font-semibold bg-rose-500/15 border border-rose-500/40 text-rose-300";
    apiKeyStatusBox.textContent = msg;
  }

  // ---------------------------------------------------------------------------
  // 3. VIDEO SOURCES & INSTANT AUTO-CUT + RAM BLOB PREVIEW
  // ---------------------------------------------------------------------------
  function setupClipVideoAndFrameBuffer(clip) {
    // 1. Frame buffer canvas so seeking never flashes blank dark background
    const frameCanvas = document.createElement("canvas");
    frameCanvas.width = 1080;
    frameCanvas.height = 1920;
    clip.lastFrameCanvas = frameCanvas;
    clip.hasDecodedFrame = false;

    // 2. Load thumbnail image immediately so even while MP4 downloads, preview shows the video cover
    if (clip.thumb) {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        clip.thumbImg = img;
        if (!clip.hasDecodedFrame) {
          const fctx = clip.lastFrameCanvas.getContext("2d");
          if (fctx) {
            fctx.imageSmoothingEnabled = true;
            fctx.imageSmoothingQuality = "high";
            fctx.drawImage(img, 0, 0, frameCanvas.width, frameCanvas.height);
            clip.hasDecodedFrame = true;
          }
          renderCurrentStudioFrame();
        }
      };
      img.src = clip.thumb;
    }

    // 3. Create muted <video> inside hidden DOM pool for hardware-accelerated decoding
    const vid = document.createElement("video");
    vid.crossOrigin = "anonymous";
    vid.muted = true;
    vid.defaultMuted = true;
    vid.volume = 0;
    vid.loop = true;
    vid.playsInline = true;
    vid.preload = "auto";
    vid.style.cssText = "width:160px;height:284px;object-fit:cover;";
    hiddenVideoPool.appendChild(vid);
    clip.videoEl = vid;

    const captureFirstFrame = () => {
      if (studioState.isExporting) return; // export loop keeps the cache itself
      if (vid.readyState >= 2 && vid.videoWidth > 0) {
        const cacheW = Math.min(vid.videoWidth, 1080);
        const cacheH = Math.round((vid.videoHeight / vid.videoWidth) * cacheW);
        clip.lastFrameCanvas.width = cacheW;
        clip.lastFrameCanvas.height = cacheH;
        const fctx = clip.lastFrameCanvas.getContext("2d");
        if (fctx) {
          try {
            fctx.imageSmoothingEnabled = true;
            fctx.imageSmoothingQuality = "high";
            fctx.drawImage(vid, 0, 0, cacheW, cacheH);
            clip.hasDecodedFrame = true;
          } catch (_) {}
        }
        renderCurrentStudioFrame();
      }
    };

    vid.addEventListener("loadedmetadata", () => {
      if (Number.isFinite(vid.duration) && vid.duration > 1) {
        clip.duration = vid.duration;
        if (!clip.noAutoPlan) buildRandomCutPlan();
        renderCurrentStudioFrame();
      }
    });

    vid.addEventListener("loadeddata", () => {
      captureFirstFrame();
      // Prime decoder by playing briefly muted
      vid
        .play()
        .then(() => {
          captureFirstFrame();
          if (!studioState.isPlaying && !studioState.isExporting) {
            vid.pause();
          }
        })
        .catch(() => {});
    });

    vid.addEventListener("seeked", captureFirstFrame);
    vid.addEventListener("timeupdate", captureFirstFrame);

    vid.src = clip.url;
    vid.load();

    // 4. If remote clip, download into browser RAM Blob so random cuts seek in 0ms!
    if (!clip.url.startsWith("blob:")) {
      clip.isCaching = true;
      clip.cacheProgress = 0;
      clip.cacheLoadedMB = 0;
      clip.cacheTotalMB = 0;
      clip.cacheError = "";
      updateClipsUI();

      const itemId = clip.rawItem?.id || "";
      const plat = clip.platform || "";
      let progressTimer = null;
      if (plat && itemId) {
        progressTimer = setInterval(async () => {
          if (!clip.isCaching) {
            clearInterval(progressTimer);
            return;
          }
          try {
            const pr = await fetch(
              `/api/studio/clip-progress?platform=${encodeURIComponent(plat)}&id=${encodeURIComponent(itemId)}`
            );
            if (!pr.ok) return;
            const pd = await pr.json();
            if (typeof pd.pct === "number") {
              clip.cacheProgress = pd.pct;
              clip.cacheLoadedMB = (pd.loaded || 0) / (1024 * 1024);
              clip.cacheTotalMB = (pd.total || 0) / (1024 * 1024);
              updateClipProgressDOM(clip);
            }
          } catch {}
        }, 350);
      }

      fetch(clip.url)
        .then(async (r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const total = parseInt(r.headers.get("content-length") || "0", 10);
          if (!r.body || !r.body.getReader) {
            return await r.blob();
          }
          const reader = r.body.getReader();
          const chunks = [];
          let loaded = 0;
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            loaded += value.byteLength;
            if (total > 0) {
              clip.cacheProgress = Math.min(100, Math.round((loaded * 100) / total));
              clip.cacheLoadedMB = loaded / (1024 * 1024);
              clip.cacheTotalMB = total / (1024 * 1024);
              updateClipProgressDOM(clip);
            }
          }
          return new Blob(chunks, { type: r.headers.get("content-type") || "video/mp4" });
        })
        .then((blob) => {
          if (progressTimer) clearInterval(progressTimer);
          if (blob && blob.size > 10000) {
            const localBlobUrl = URL.createObjectURL(blob);
            clip.blobUrl = localBlobUrl;
            clip.isCaching = false;
            clip.cacheProgress = 100;
            clip.cacheError = "";
            const curT = vid.currentTime || 0;
            vid.src = localBlobUrl;
            vid.load();
            vid.currentTime = curT;
            if (studioState.isPlaying && isEngineVisible()) {
              vid.play().catch(() => {});
            }
            updateClipsUI();
            renderCurrentStudioFrame();
          } else {
            throw new Error("ไฟล์วิดีโอไม่สมบูรณ์");
          }
        })
        .catch((err) => {
          if (progressTimer) clearInterval(progressTimer);
          clip.isCaching = false;
          clip.cacheError = (err && err.message) || "โหลดไม่สำเร็จ";
          updateClipsUI();
        });
    }
  }

  function formatClipProgressText(clip) {
    const pct = Math.max(0, Math.min(100, Math.round(clip.cacheProgress || 0)));
    if (clip.cacheTotalMB > 0) {
      return `⏳ กำลังโหลดคลิป ${pct}% (${clip.cacheLoadedMB.toFixed(1)}/${clip.cacheTotalMB.toFixed(1)} MB)`;
    }
    if (clip.cacheLoadedMB > 0) {
      return `⏳ กำลังโหลดคลิป ${pct}% (${clip.cacheLoadedMB.toFixed(1)} MB)`;
    }
    return `⏳ กำลังโหลดคลิป ${pct}%...`;
  }

  function updateClipProgressDOM(clip) {
    if (!studioClipsList || !clip) return;
    const statusEl = studioClipsList.querySelector(`[data-clip-status="${CSS.escape(clip.id)}"]`);
    if (statusEl) {
      statusEl.textContent = formatClipProgressText(clip);
    }
    const barEl = studioClipsList.querySelector(`[data-clip-bar="${CSS.escape(clip.id)}"]`);
    if (barEl) {
      barEl.style.width = `${Math.max(4, Math.min(100, Math.round(clip.cacheProgress || 0)))}%`;
    }
  }

  function addClipFromPage1(item) {
    if (!item || !item.id) return;
    const clipKey = `${item.platform}:${item.id}`;
    const exists = studioState.clips.some((c) => c.id === clipKey);
    if (exists) {
      toast("คลิปนี้อยู่ในคิวสตูดิโอหน้าที่ 2 แล้ว!");
      return;
    }

    // Use backend local clip cache endpoint for fast seeking & zero range-request stalls
    const cacheClipUrl = `/api/studio/clip-file?platform=${encodeURIComponent(item.platform)}&id=${encodeURIComponent(item.id)}&direct_url=${encodeURIComponent(
      item.direct_video_url || (item.platform === "xhs" ? item.url || "" : "")
    )}`;
    const thumbUrl = item.cover ? `/api/proxy-image?url=${encodeURIComponent(item.cover)}` : "";

    const newClip = {
      id: clipKey,
      title: item.title || `คลิปจาก ${item.platform}`,
      platform: item.platform,
      sourceLabel:
        item.platform === "douyin" ? "🎵 Douyin" : item.platform === "xhs" ? "📕 RedNote" : "📺 Bilibili",
      url: cacheClipUrl,
      blobUrl: "",
      thumb: thumbUrl,
      thumbImg: null,
      duration: 12.0,
      rawItem: item,
      videoEl: null,
      lastFrameCanvas: null,
      hasDecodedFrame: false,
      isCaching: false,
      cacheProgress: 0,
      cacheLoadedMB: 0,
      cacheTotalMB: 0,
      cacheError: "",
    };

    setupClipVideoAndFrameBuffer(newClip);
    studioState.clips.push(newClip);

    updateClipsUI();
    buildRandomCutPlan();
    seekStudioPreview(0);
    if (studioState.activePage === "studio") {
      startStudioPreview();
    } else {
      renderCurrentStudioFrame();
    }

    toast(`🎬 ส่งคลิปเข้าสตูดิโอแล้ว! ตัดยำสลับฉากให้อัตโนมัติ (รวม ${studioState.clips.length} คลิป)`);
  }

  // Paste Douyin / RedNote / Bilibili links -> resolve -> add to the cut queue
  function splitPastedLinks(text) {
    const urls = text.match(/https?:\/\/[^\s"'<>，。]+/g);
    if (urls && urls.length) return [...new Set(urls)];
    return text
      .split(/\n+/)
      .map((l) => l.trim())
      .filter(Boolean);
  }

  async function addClipsFromLinks() {
    const raw = (studioLinkInput?.value || "").trim();
    if (!raw) {
      toast("กรุณาวางลิงก์ Douyin / RedNote / Bilibili ก่อน");
      return;
    }
    const links = splitPastedLinks(raw);
    if (links.some((l) => /shopee|shp\.ee/i.test(l))) {
      toast("ลิงก์ Shopee ใช้ที่หน้าค้นหา (หน้าที่ 1) — ช่องนี้รับเฉพาะลิงก์คลิป Douyin / RedNote / Bilibili", false, 5000);
      return;
    }
    studioAddLinkBtn.disabled = true;
    const oldLabel = studioAddLinkBtn.textContent;
    studioAddLinkBtn.textContent = "⏳ กำลังโหลด...";
    const failed = [];
    let added = 0;
    toast(`🔗 กำลังดึง ${links.length} คลิปพร้อมกันอย่างรวดเร็ว...`, true, 60000);
    const resolvedResults = await Promise.allSettled(
      links.map(async (url) => {
        const resp = await fetch("/api/resolve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url }),
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || !data.item) throw new Error(data.detail || `HTTP ${resp.status}`);
        return { url, item: data.item };
      })
    );

    for (const res of resolvedResults) {
      if (res.status === "fulfilled" && res.value?.item) {
        const before = studioState.clips.length;
        addClipFromPage1(res.value.item);
        if (studioState.clips.length > before) added++;
      } else {
        const failedUrl = res.reason?.url || (res.value && res.value.url) || "";
        if (failedUrl) failed.push(failedUrl);
      }
    }
    studioAddLinkBtn.disabled = false;
    studioAddLinkBtn.textContent = oldLabel;
    // keep only the links that failed so the user can fix / retry them
    studioLinkInput.value = failed.join("\n");
    if (links.length > 1) {
      toast(
        failed.length
          ? `เพิ่มเข้าคิว ${added} คลิป • ดึงไม่สำเร็จ ${failed.length} ลิงก์ (ค้างไว้ในช่องให้ลองใหม่)`
          : `🎬 เพิ่มเข้าคิว ${added} คลิปจากลิงก์แล้ว (รวม ${studioState.clips.length} คลิป)`,
        false,
        5000
      );
    }
  }

  function handlePcVideoUpload(fileList) {
    if (!fileList || fileList.length === 0) return;
    let added = 0;
    Array.from(fileList).forEach((file, idx) => {
      if (!file.type.startsWith("video/")) return;
      const objUrl = URL.createObjectURL(file);
      const clipId = `pc-${Date.now()}-${idx}`;
      const newClip = {
        id: clipId,
        title: file.name,
        platform: "pc",
        sourceLabel: "💻 PC Upload",
        url: objUrl,
        blobUrl: objUrl,
        rawFile: file,
        thumb: "",
        thumbImg: null,
        duration: 12.0,
        rawItem: null,
        videoEl: null,
        lastFrameCanvas: null,
        hasDecodedFrame: false,
        isCaching: false,
      };
      setupClipVideoAndFrameBuffer(newClip);
      studioState.clips.push(newClip);
      added++;
    });

    if (added > 0) {
      updateClipsUI();
      buildRandomCutPlan();
      seekStudioPreview(0);
      startStudioPreview();
      toast(`อัปโหลดคลิปจาก PC สำเร็จ +${added} คลิป (ตัดยำขึ้นพรีวิวอัตโนมัติ)`);
    }
  }

  function removeStudioClip(clipId) {
    const target = studioState.clips.find((c) => c.id === clipId);
    if (target) {
      if (target.videoEl) {
        target.videoEl.pause();
        target.videoEl.removeAttribute("src");
        target.videoEl.remove();
      }
      if (target.blobUrl && target.platform !== "pc") {
        URL.revokeObjectURL(target.blobUrl);
      }
    }
    studioState.clips = studioState.clips.filter((c) => c.id !== clipId);
    updateClipsUI();
    buildRandomCutPlan();
    renderCurrentStudioFrame();
  }

  function clearAllStudioClips() {
    studioState.clips.forEach((c) => {
      if (c.videoEl) {
        c.videoEl.pause();
        c.videoEl.removeAttribute("src");
        c.videoEl.remove();
      }
      if (c.blobUrl && c.platform !== "pc") {
        URL.revokeObjectURL(c.blobUrl);
      }
    });
    studioState.clips = [];
    updateClipsUI();
    buildRandomCutPlan();
    renderCurrentStudioFrame();
  }

  function previewSourceClip(clipId) {
    const clip = studioState.clips.find((c) => c.id === clipId);
    if (!clip) return;
    pauseStudioPreview();
    if (clip.rawItem && typeof window.openPreviewModal === "function") {
      window.openPreviewModal(clip.rawItem);
      return;
    }
    const previewModal = document.getElementById("previewModal");
    const modalVideo = document.getElementById("modalVideo");
    const modalTitle = document.getElementById("modalTitle");
    const modalPlatformBadge = document.getElementById("modalPlatformBadge");
    const modalAuthor = document.getElementById("modalAuthor");
    if (previewModal && modalVideo) {
      if (modalPlatformBadge) {
        modalPlatformBadge.className = "px-2.5 py-1 rounded-md text-xs font-bold bg-fuchsia-600 text-white";
        modalPlatformBadge.textContent = clip.sourceLabel;
      }
      if (modalTitle) modalTitle.textContent = clip.title;
      if (modalAuthor) modalAuthor.textContent = "ไฟล์วิดีโอในสตูดิโอ";
      modalVideo.src = clip.blobUrl || clip.url;
      previewModal.classList.remove("hidden");
      modalVideo.play().catch(() => {});
    }
  }

  function updateOriginalAudioUI() {
    const isMuted = Boolean(studioState.isOriginalAudioMuted);
    if (studioToggleOriginalAudioBtn) {
      if (isMuted) {
        studioToggleOriginalAudioBtn.className =
          "px-3 py-1.5 rounded-xl border text-xs font-bold transition flex items-center gap-1.5 bg-slate-900 border-red-500/40 text-red-300 hover:border-red-400 self-start sm:self-auto cursor-pointer";
        if (studioOriginalAudioIcon) studioOriginalAudioIcon.textContent = "🔇";
        if (studioOriginalAudioText) studioOriginalAudioText.textContent = "เสียงคลิปต้นฉบับ: ปิด 100% (Default)";
      } else {
        studioToggleOriginalAudioBtn.className =
          "px-3 py-1.5 rounded-xl border text-xs font-bold transition flex items-center gap-1.5 bg-emerald-950/40 border-emerald-500 text-emerald-300 hover:border-emerald-400 self-start sm:self-auto cursor-pointer shadow-sm shadow-emerald-500/20";
        if (studioOriginalAudioIcon) studioOriginalAudioIcon.textContent = "🔊";
        if (studioOriginalAudioText) studioOriginalAudioText.textContent = "เสียงคลิปต้นฉบับ: เปิด (70%)";
      }
    }

    if (studioMuteOriginalBtn) {
      studioMuteOriginalBtn.textContent = isMuted ? "🔇 เสียงคลิป: ปิด" : "🔊 เสียงคลิป: เปิด";
      studioMuteOriginalBtn.className = isMuted
        ? "px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-400 text-xs font-semibold transition"
        : "px-2.5 py-1.5 rounded-lg bg-emerald-600/30 hover:bg-emerald-600/50 text-emerald-300 text-xs font-semibold border border-emerald-500/40 transition";
    }

    syncActiveClipVideoElement(
      studioState.currentTime,
      studioState.isPlaying && isEngineVisible() && !studioState.isExporting
    );
  }

  function toggleOriginalAudio() {
    studioState.isOriginalAudioMuted = !studioState.isOriginalAudioMuted;
    try {
      localStorage.setItem("studio_original_audio_muted", String(studioState.isOriginalAudioMuted));
    } catch (_) {}
    updateOriginalAudioUI();
    updateClipsUI();
    toast(studioState.isOriginalAudioMuted ? "🔇 ปิดเสียงคลิปต้นฉบับแล้ว (Default)" : "🔊 เปิดเสียงคลิปต้นฉบับแล้ว (70%)");
  }

  // ---------------------------------------------------------------------------
  // Chinese-censor hero card (right column): status, counter, progress, button
  // ---------------------------------------------------------------------------
  const CENSOR_BTN_RED =
    "w-full py-3.5 px-5 rounded-xl bg-gradient-to-r from-rose-600 via-red-500 to-orange-500 hover:opacity-95 text-white font-extrabold text-sm shadow-xl shadow-rose-600/30 transition flex items-center justify-center gap-2 disabled:cursor-wait";
  const CENSOR_BTN_DONE =
    "w-full py-3 px-5 rounded-xl bg-emerald-600/25 hover:bg-emerald-600/35 border border-emerald-500/50 text-emerald-200 font-extrabold text-sm transition flex items-center justify-center gap-2 disabled:cursor-wait";

  function renderCensorUI() {
    const card = document.getElementById("censorCard");
    if (!card) return;
    const icon = document.getElementById("censorIcon");
    const statusEl = document.getElementById("studioCensorStatusText");
    const badge = document.getElementById("studioCensorCountBadge");
    const bar = document.getElementById("studioCensorProgressBar");
    const note = document.getElementById("studioCensorProgressText");
    const total = studioState.clips.length;
    const done = studioState.clips.filter((c) => c.isCensored).length;
    const left = total - done;
    const allDone = total > 0 && left === 0;

    if (badge) badge.textContent = `${done}/${total}`;
    if (studioState.isCensoring) return; // the running scan owns the button/progress text

    card.className = allDone
      ? "rounded-2xl bg-gradient-to-br from-emerald-950/70 via-slate-900 to-slate-900 border-2 border-emerald-500/60 p-4 shadow-2xl space-y-3"
      : "censor-pending rounded-2xl bg-gradient-to-br from-rose-950/80 via-slate-900 to-slate-900 border-2 border-rose-500/70 p-4 shadow-2xl shadow-rose-900/30 space-y-3";
    if (icon) {
      icon.textContent = allDone ? "✅" : "🈲";
      icon.className = `w-10 h-10 rounded-xl ${allDone ? "bg-emerald-500/20 border-emerald-500/50" : "bg-rose-500/20 border-rose-500/50"} border flex items-center justify-center text-xl`;
    }
    if (statusEl) {
      statusEl.className = `text-[11px] font-semibold ${allDone ? "text-emerald-300" : "text-rose-300"}`;
      statusEl.textContent = !total
        ? "ยังไม่มีคลิปในคิว"
        : allDone
          ? "เบลอตัวจีนครบทุกคลิปแล้ว"
          : `เหลือ ${left} จาก ${total} คลิปที่ยังไม่ได้เซนเซอร์`;
    }
    if (badge) {
      badge.className = `px-2.5 py-1 rounded-lg border text-xs font-extrabold font-mono ${allDone ? "bg-emerald-500/20 border-emerald-500/40 text-emerald-200" : "bg-rose-500/20 border-rose-500/40 text-rose-200"}`;
    }
    if (studioBlurChineseBtn) {
      studioBlurChineseBtn.disabled = false;
      studioBlurChineseBtn.className = allDone ? CENSOR_BTN_DONE : CENSOR_BTN_RED;
      studioBlurChineseBtn.textContent = allDone
        ? "🔍 เซนเซอร์จีนใหม่"
        : done > 0
          ? `🔍 เซนเซอร์จีน ${left} คลิปที่เหลือ`
          : "🔍 เซนเซอร์จีนทั้งหมด";
    }
    if (bar) {
      bar.style.width = total ? `${(done / total) * 100}%` : "0%";
      bar.className = `h-full transition-all duration-150 bg-gradient-to-r ${allDone ? "from-emerald-400 to-teal-400" : "from-rose-500 to-orange-400"}`;
    }
  }

  // Open (if collapsed), scroll to and briefly highlight a page-2 card
  function flashStudioSection(id) {
    const el = document.getElementById(id);
    if (!el) return;
    if (el.classList.contains("acc")) el.classList.add("open");
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.remove("flash");
    void el.offsetWidth;
    el.classList.add("flash");
  }

  function showStudioStyleTab(tabId) {
    document.querySelectorAll("#secStyle .tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === tabId));
    document.querySelectorAll("#secStyle .tab-panel").forEach((p) => p.classList.toggle("hidden", p.id !== tabId));
  }

  function updateClipsUI() {
    if (engineCtx !== "page2") return;
    const count = studioState.clips.length;
    if (studioClipCountBadge) studioClipCountBadge.textContent = `${count} คลิป`;
    if (studioQueueCountText) studioQueueCountText.textContent = String(count);
    if (studioClearClipsBtn) studioClearClipsBtn.classList.toggle("hidden", count === 0);
    window.dispatchEvent(new CustomEvent("studio:clips-changed")); // page 1 badges + "go to studio" button
    const footageSummary = document.getElementById("footageSummary");
    if (footageSummary) {
      footageSummary.textContent = count
        ? `${count} คลิปในคิว • เสียงต้นฉบับ${studioState.isOriginalAudioMuted ? "ปิด" : "เปิด"}`
        : "ส่งมาจากหน้าหาคลิป หรือ อัปโหลดจากเครื่อง PC";
    }
    renderCensorUI();

    if (!studioClipsList) return;
    if (count === 0) {
      studioClipsList.innerHTML = `
        <div class="col-span-full py-5 px-4 rounded-xl bg-slate-950/60 border border-dashed border-slate-800 text-center text-xs text-slate-400">
          ยังไม่มีคลิปในคิว — กดปุ่ม <strong class="text-fuchsia-400">"🎬 ส่งไปทำคลิป"</strong> จากหน้าค้นหา หรืออัปโหลดไฟล์วิดีโอจากเครื่อง PC ได้เลย
        </div>
      `;
      return;
    }

    studioClipsList.innerHTML = studioState.clips
      .map(
        (clip, i) => `
      <div class="flex items-center justify-between gap-2.5 p-2.5 rounded-xl bg-slate-950 border ${clip.isCensored ? "border-slate-800" : "border-rose-500/40"}">
        <div class="flex items-center gap-2.5 min-w-0">
          <div class="w-12 h-12 rounded-lg bg-slate-900 border border-slate-800 overflow-hidden shrink-0 flex items-center justify-center text-xs font-bold text-fuchsia-400">
            ${
              clip.thumb
                ? `<img src="${clip.thumb}" class="w-full h-full object-cover" alt="" onerror="this.style.display='none';if(this.nextElementSibling)this.nextElementSibling.style.display='flex';" /><span style="display:none" class="w-full h-full items-center justify-center">#${i + 1}</span>`
                : `<span>#${i + 1}</span>`
            }
          </div>
          <div class="min-w-0">
            <div class="flex items-center gap-1.5 flex-wrap">
              <span class="px-1.5 py-0.5 rounded bg-slate-800 text-[10px] font-bold text-slate-300">${escapeHtml(clip.sourceLabel)}</span>
              ${
                clip.isCensored
                  ? `<span class="px-1.5 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/40 text-[10px] text-emerald-300 font-bold">✓ เซนเซอร์แล้ว</span>`
                  : `<span class="px-1.5 py-0.5 rounded bg-rose-500/15 border border-rose-500/40 text-[10px] text-rose-300 font-bold">🈲 ยังไม่เซนเซอร์</span>`
              }
              <span class="text-[10px] ${studioState.isOriginalAudioMuted ? "text-emerald-400" : "text-amber-300"} font-semibold" title="${studioState.isOriginalAudioMuted ? "ปิดเสียงคลิปต้นฉบับ 100%" : "เปิดเสียงคลิปต้นฉบับ"}">${studioState.isOriginalAudioMuted ? "🔇" : "🔊"}</span>
              ${
                clip.isCaching
                  ? `<span data-clip-status="${escapeHtml(clip.id)}" class="text-[10px] text-amber-300 font-semibold">${escapeHtml(formatClipProgressText(clip))}</span>`
                  : clip.cacheError
                    ? `<span class="text-[10px] text-rose-400 font-semibold" title="${escapeHtml(clip.cacheError)}">✕ โหลดไม่สำเร็จ</span>`
                    : `<span class="text-[10px] text-sky-400 font-semibold">✓ พร้อมตัดสลับ</span>`
              }
            </div>
            ${
              clip.isCaching
                ? `<div class="w-full h-1 bg-slate-800 rounded-full overflow-hidden mt-1"><div data-clip-bar="${escapeHtml(clip.id)}" class="h-full bg-gradient-to-r from-amber-400 to-fuchsia-500 transition-all duration-200" style="width:${Math.max(4, Math.min(100, Math.round(clip.cacheProgress || 0)))}%"></div></div>`
                : ""
            }
            <p class="text-xs font-semibold text-slate-200 truncate mt-0.5" title="${escapeHtml(clip.title)}">
              ${escapeHtml(clip.title)}
            </p>
          </div>
        </div>
        <div class="flex items-center gap-1 shrink-0">
          <button
            type="button"
            data-preview-clip="${escapeHtml(clip.id)}"
            class="px-2 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-[11px] font-semibold text-sky-300 transition"
            title="ดูตัวอย่างคลิปต้นฉบับ"
          >
            ▶ ดูคลิป
          </button>
          <button
            type="button"
            data-remove-clip="${escapeHtml(clip.id)}"
            class="w-7 h-7 rounded-lg bg-slate-800 hover:bg-rose-600 text-slate-400 hover:text-white text-xs flex items-center justify-center transition"
            title="ลบออกจากคิว"
          >
            ✕
          </button>
        </div>
      </div>
    `
      )
      .join("");

    studioClipsList.querySelectorAll("[data-preview-clip]").forEach((btn) => {
      btn.addEventListener("click", () => previewSourceClip(btn.getAttribute("data-preview-clip")));
    });
    studioClipsList.querySelectorAll("[data-remove-clip]").forEach((btn) => {
      btn.addEventListener("click", () => removeStudioClip(btn.getAttribute("data-remove-clip")));
    });
  }

  /**
   * Build randomized cut & shuffle segments across totalDuration
   */
  function buildRandomCutPlan(forceReshuffle = false) {
    const totalDur = Math.max(4, Number(studioState.totalDuration) || 20);
    const paceVal = studioCutPaceSelect?.value || String(studioState.cutPaceSec || "4.0");
    const isAutoScenes = paceVal === "auto_scenes";
    const basePace = isAutoScenes
      ? 4.0
      : Math.max(1.2, Number(paceVal) || studioState.cutPaceSec || 4.0);
    studioState.cutPaceSec = basePace;
    studioState.transitionMode = studioTransitionSelect?.value || "none";

    // Build timeline durations
    const timeSlices = [];
    if (isAutoScenes && Array.isArray(studioState.scenes) && studioState.scenes.length > 0) {
      studioState.scenes.forEach((sc) => {
        timeSlices.push({
          start: Number(sc.start) || 0,
          duration: Math.max(1.0, Number(sc.duration) || 4.0),
        });
      });
    } else {
      const targetCount = Math.max(1, Math.round(totalDur / basePace));
      const exactAvg = totalDur / targetCount;
      let curr = 0;
      for (let i = 0; i < targetCount; i++) {
        if (i === targetCount - 1) {
          timeSlices.push({
            start: Number(curr.toFixed(2)),
            duration: Number(Math.max(1.0, totalDur - curr).toFixed(2)),
          });
        } else {
          // Subtle organic jitter (±6%) so cuts feel natural and not like a rigid metronome
          const jitter = 0.95 + Math.random() * 0.10;
          const dur = Number((exactAvg * jitter).toFixed(2));
          timeSlices.push({
            start: Number(curr.toFixed(2)),
            duration: dur,
          });
          curr += dur;
        }
      }
    }

    const clips = studioState.clips;
    const segments = [];

    if (clips.length === 0) {
      timeSlices.forEach((ts, idx) => {
        segments.push({
          index: idx,
          start: ts.start,
          duration: ts.duration,
          clipId: null,
          clipIndex: 0,
          trimStart: 0,
          zoomEffect: "static",
          transition: idx === 0 ? "none" : (studioState.transitionMode === "random" ? "dissolve" : studioState.transitionMode),
        });
      });
    } else if (clips.length === 1) {
      // Single clip: Flow forward chronologically through the video!
      // NEVER scramble backwards (e.g. 13.9s -> 10.5s -> 7.1s) which makes viewers dizzy!
      const clip = clips[0];
      const vidDur = Math.max(4, Number(clip.duration) || 12);
      const usableStart = vidDur > 4 ? 0.4 : 0;
      const usableEnd = Math.max(usableStart + 2, vidDur - 0.6);
      const availableSpan = Math.max(0.5, usableEnd - usableStart);

      const nSlices = timeSlices.length;
      timeSlices.forEach((ts, idx) => {
        const progress = nSlices > 1 ? idx / (nSlices - 1) : 0;
        let tStart = usableStart + progress * (availableSpan * 0.75);
        if (tStart + ts.duration > vidDur) {
          tStart = Math.max(0, vidDur - ts.duration - 0.2);
        }

        const zoom = ZOOM_EFFECTS[Math.floor(Math.random() * ZOOM_EFFECTS.length)];
        let trans = "none";
        if (idx > 0) {
          trans = studioState.transitionMode === "random"
            ? TRANSITION_POOL[Math.floor(Math.random() * TRANSITION_POOL.length)]
            : studioState.transitionMode;
        }

        segments.push({
          index: idx,
          start: ts.start,
          duration: ts.duration,
          clipId: clip.id,
          clipIndex: 1,
          trimStart: Number(tStart.toFixed(2)),
          zoomEffect: zoom,
          transition: trans,
        });
      });
    } else {
      // Multiple clips: Alternate between clips (Clip 1 -> Clip 2 -> Clip 1...)
      // Each clip advances chronologically forward!
      const clipProgress = {};
      clips.forEach((c) => { clipProgress[c.id] = 0; });

      let lastClipIdx = -1;
      const nSlices = timeSlices.length;

      timeSlices.forEach((ts, idx) => {
        let chosenIdx;
        if (forceReshuffle) {
          const candidates = clips.map((_, i) => i).filter((i) => i !== lastClipIdx || clips.length === 1);
          chosenIdx = candidates[Math.floor(Math.random() * candidates.length)];
        } else {
          chosenIdx = idx % clips.length;
        }
        lastClipIdx = chosenIdx;
        const clip = clips[chosenIdx];

        const vidDur = Math.max(4, Number(clip.duration) || 12);
        const usableStart = vidDur > 4 ? 0.4 : 0;
        const usableEnd = Math.max(usableStart + 2, vidDur - 0.6);
        const availableSpan = Math.max(0.5, usableEnd - usableStart);

        const timesUsed = clipProgress[clip.id] || 0;
        clipProgress[clip.id] = timesUsed + 1;

        let tStart = usableStart + (timesUsed * (availableSpan / Math.max(2, Math.ceil(nSlices / clips.length))));
        tStart = (tStart % availableSpan) + usableStart;
        if (tStart + ts.duration > vidDur) {
          tStart = Math.max(0, vidDur - ts.duration - 0.2);
        }

        const zoom = ZOOM_EFFECTS[Math.floor(Math.random() * ZOOM_EFFECTS.length)];
        let trans = "none";
        if (idx > 0) {
          trans = studioState.transitionMode === "random"
            ? TRANSITION_POOL[Math.floor(Math.random() * TRANSITION_POOL.length)]
            : studioState.transitionMode;
        }

        segments.push({
          index: idx,
          start: ts.start,
          duration: ts.duration,
          clipId: clip.id,
          clipIndex: chosenIdx + 1,
          trimStart: Number(tStart.toFixed(2)),
          zoomEffect: zoom,
          transition: trans,
        });
      });
    }

    studioState.cutSegments = segments;
    renderCutPreviewStrip();
  }

  function renderCutPreviewStrip() {
    if (!studioCutPreviewStrip || engineCtx !== "page2") return;
    const segs = studioState.cutSegments || [];
    if (studioCutSummaryText) {
      studioCutSummaryText.textContent = `${segs.length} ฉากตัดสลับ (${studioState.totalDuration.toFixed(1)}s)`;
    }
    studioCutPreviewStrip.innerHTML = segs
      .map(
        (s) => `
      <button
        type="button"
        data-seek-time="${s.start}"
        class="shrink-0 px-2.5 py-1 rounded-lg bg-slate-950 hover:bg-slate-800 border border-slate-800 text-slate-300 font-mono transition text-[11px] flex items-center gap-1"
        title="คลิกเพื่อดูพรีวิวฉากที่ ${s.index + 1}"
      >
        <span>✂️ ฉาก ${s.index + 1}</span>
        <span class="text-slate-400 font-normal">${s.clipIndex ? `(คลิป#${s.clipIndex} @${s.trimStart.toFixed(1)}s • ${s.duration.toFixed(1)}s)` : `(${s.start.toFixed(1)}s • ${s.duration.toFixed(1)}s)`}</span>
      </button>
    `
      )
      .join("");

    studioCutPreviewStrip.querySelectorAll("[data-seek-time]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const sec = Number(btn.getAttribute("data-seek-time") || 0);
        seekStudioPreview(sec);
      });
    });
  }

  // ---------------------------------------------------------------------------
  // 4. SHOPEE PRODUCT LINK SYNC & FETCH
  // ---------------------------------------------------------------------------
  const STORE_POLICY_WORDS = [
    "เสียหาย",
    "แตกหัก",
    "สูญหาย",
    "ค่าชดเชย",
    "ความคิดเห็นเชิงลบ",
    "ผู้ขายที่ซื่อสัตย์",
    "ติดต่อฉัน",
    "ทางออกที่น่าพอใจ",
  ];

  function filterStorePolicyFromDesc(rawDesc) {
    if (!rawDesc) return "";
    return String(rawDesc)
      .split(/[\r\n☆•●]+/)
      .map((l) => l.trim())
      .filter((l) => l.length >= 4 && !STORE_POLICY_WORDS.some((w) => l.includes(w)))
      .join("\n");
  }

  function setProductImage(url) {
    const img = document.getElementById("studioProductImage");
    const ph = document.getElementById("studioProductImagePh");
    if (!img) return;
    if (url) {
      img.src = /^(\/api\/|data:|blob:)/.test(url) ? url : `/api/proxy-image?url=${encodeURIComponent(url)}`;
      img.classList.remove("hidden");
      ph?.classList.add("hidden");
    } else {
      img.removeAttribute("src");
      img.classList.add("hidden");
      ph?.classList.remove("hidden");
    }
  }

  function syncShopeeProduct(product, silent = false) {
    if (!product) return;
    setProductImage(product.image || "");
    if (studioShopeeUrlInput) {
      studioShopeeUrlInput.value = product.input_url || product.canonical_url || "";
    }
    const cleanCategory = (product.thai_keyword || "").split(/[,|]+/)[0].trim();
    if (studioProductTitle) {
      studioProductTitle.value = cleanCategory
        ? `${cleanCategory} (${product.title || ""})`
        : product.title || "";
    }
    const filteredDesc = filterStorePolicyFromDesc(product.description || "");
    const highlights = Array.isArray(product.description_highlights)
      ? product.description_highlights
          .filter((h) => !STORE_POLICY_WORDS.some((w) => String(h).includes(w)))
          .join(" • ")
      : "";
    const fullDesc = [filteredDesc, highlights].filter(Boolean).join("\n");
    if (studioProductDesc) {
      studioProductDesc.value = fullDesc || cleanCategory || product.title || "";
    }
    if (cleanCategory) {
      studioState.headerText = `${cleanCategory} ใช้งานง่ายสะดวก`;
      if (studioHeaderInput) studioHeaderInput.value = studioState.headerText;
      renderCurrentStudioFrame();
    }
    if (studioShopeeSyncBadge) {
      studioShopeeSyncBadge.classList.remove("hidden");
    }
    if (!silent) {
      toast("ดึงข้อมูลประเภทสินค้าจาก Shopee เข้าสตูดิโอเรียบร้อย!");
    }
  }

  async function fetchShopeeInfoInStudio() {
    const rawUrl = (studioShopeeUrlInput?.value || "").trim();
    if (!rawUrl) {
      toast("กรุณาวางลิงก์สินค้า Shopee ก่อนกดดึงข้อมูล");
      return;
    }
    if (studioFetchShopeeBtn) studioFetchShopeeBtn.disabled = true;
    toast("กำลังดึงข้อมูลสินค้าจากลิงก์ Shopee...", true, 0);

    try {
      const resp = await fetch("/api/studio/shopee-info", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: rawUrl }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        throw new Error(data.detail || "ไม่สามารถดึงข้อมูลจากลิงก์ Shopee ได้");
      }
      syncShopeeProduct(data.product, false);
    } catch (err) {
      toast(err.message, false, 4000);
    } finally {
      if (studioFetchShopeeBtn) studioFetchShopeeBtn.disabled = false;
    }
  }

  // ---------------------------------------------------------------------------
  // 5. AI SCRIPT + HEADER + VOICEOVER + SUBTITLES GENERATION
  // ---------------------------------------------------------------------------
  async function generateAiScriptVoiceAndSubtitles(rewriteScript = true) {
    const title = (studioProductTitle?.value || "").trim();
    const desc = (studioProductDesc?.value || "").trim();
    const customScript = (studioScriptTextarea?.value || "").trim();

    if (rewriteScript && !title && !desc) {
      toast("กรุณาวางลิงก์ Shopee หรือใส่ประเภทสินค้าก่อนให้ AI คิดบทครับ");
      studioProductTitle?.focus();
      return;
    }
    if (!rewriteScript && !customScript) {
      toast("กรุณาพิมพ์บทพากย์ในกล่องข้อความก่อนกดพากย์เสียงใหม่ครับ");
      studioScriptTextarea?.focus();
      return;
    }

    pauseStudioPreview();
    if (studioGenerateAllBtn) studioGenerateAllBtn.disabled = true;
    if (studioRevoiceBtn) studioRevoiceBtn.disabled = true;
    if (studioGenSpinner) studioGenSpinner.classList.remove("hidden");
    if (studioGenBtnText) {
      studioGenBtnText.textContent = rewriteScript
        ? "กำลังให้ AI คิดบท + สร้าง Header + พากย์เสียง..."
        : "กำลังพากย์เสียงและซิงค์ซับไตเติ้ลใหม่...";
    }
    toast("กำลังสร้างบทพากย์ เสียงพากย์ไทย และซับไตเติ้ล...", true, 0);

    try {
      const selectedOpt = studioVoiceSelect?.selectedOptions?.[0];
      const voiceGender = selectedOpt?.getAttribute("data-gender") || "Male";

      let activeScript = customScript;
      let activeHeader = studioHeaderInput?.value || "";

      if (rewriteScript) {
        if (studioGenBtnText) studioGenBtnText.textContent = "กำลังให้ AI คิดบท + Header...";
        toast("กำลังให้ AI คิดบทพากย์และ Header...", true, 0);
        const scriptResp = await fetch("/api/studio/generate-script", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            product_title: title,
            product_description: desc,
            target_duration: Number(studioTargetDuration?.value || 20),
            sales_angle: studioSalesAngle?.value || "podcast_ad",
            custom_header: "",
            voice_name: studioVoiceSelect?.value || "Puck",
            voice_gender: voiceGender,
            api_key: studioState.geminiKeysText || "",
            openrouter_api_key: studioState.openrouterKeysText || "",
            rewrite_script: true,
          }),
        });
        const scriptData = await scriptResp.json();
        if (!scriptResp.ok) {
          throw new Error(scriptData.detail || "คิดบทพูดไม่สำเร็จ");
        }

        if (scriptData.short_headline) {
          activeHeader = scriptData.short_headline;
          studioState.headerText = activeHeader;
          if (studioHeaderInput) studioHeaderInput.value = activeHeader;
        }
        activeScript = scriptData.spoken_script || "";
        studioState.spokenScript = activeScript;
        if (studioScriptTextarea) studioScriptTextarea.value = activeScript;
        if (Array.isArray(scriptData.scenes) && scriptData.scenes.length > 0) {
          studioState.scenes = scriptData.scenes;
        }
        renderCurrentStudioFrame();

        if (studioGenBtnText) studioGenBtnText.textContent = "✓ คิดบทแล้ว • กำลังพากย์เสียง...";
        if (scriptData.model_used === "template-fallback") {
          toast("⚠️ AI คิดบทติดจำกัด/ยังไม่ได้ใส่ Key — ใช้บทพื้นฐานแทนชั่วคราว และกำลังพากย์เสียง...", true, 0);
        } else {
          toast("✓ วางบทในช่องแล้ว — กำลังสร้างเสียงพากย์...", true, 0);
        }
      }

      const resp = await fetch("/api/studio/generate-all", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          product_title: title,
          product_description: desc,
          target_duration: Number(studioTargetDuration?.value || 20),
          sales_angle: studioSalesAngle?.value || "podcast_ad",
          custom_header: activeHeader,
          custom_script: activeScript,
          voice_name: studioVoiceSelect?.value || "Puck",
          voice_gender: voiceGender,
          speed_rate: studioVoiceSpeed?.value || "+15%",
          api_key: studioState.geminiKeysText || "",
          openrouter_api_key: studioState.openrouterKeysText || "",
          rewrite_script: false,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        const prefix = rewriteScript ? "วางบทในช่องแล้ว แต่พากย์เสียงไม่สำเร็จ: " : "";
        throw new Error(prefix + (data.detail || "พากย์เสียงไม่สำเร็จ"));
      }

      if (data.short_headline) {
        studioState.headerText = data.short_headline;
        if (studioHeaderInput) studioHeaderInput.value = data.short_headline;
      }

      studioState.spokenScript = data.spoken_script || "";
      if (studioScriptTextarea) studioScriptTextarea.value = studioState.spokenScript;
      studioState.scenes = Array.isArray(data.scenes) && data.scenes.length > 0 ? data.scenes : studioState.scenes;

      const dur = Math.max(4, Number(data.audio_duration) || Number(studioTargetDuration?.value) || 20);
      studioState.totalDuration = dur;

      if (data.audio_base64) {
        const mime = data.mime_type || "audio/mpeg";
        const dataUrl = `data:${mime};base64,${data.audio_base64}`;
        studioState.voiceAudioDataUrl = dataUrl;
        if (studioState.voiceAudio) {
          studioState.voiceAudio.pause();
        }
        const aud = new Audio(dataUrl);
        aud.preload = "auto";
        studioState.voiceAudio = aud;
      }

      studioState.voiceEngineLabel = data.engine || "AI Voice Ready";
      if (studioVoiceEngineBadge) {
        studioVoiceEngineBadge.textContent = studioState.voiceEngineLabel;
      }

      // Fold the AI card down to a one-line summary and open the script/subtitle tab for review
      if (rewriteScript) {
        const aiSummary = document.getElementById("aiSummary");
        const speedLabel = (studioVoiceSpeed?.selectedOptions?.[0]?.textContent || "").trim().split(" ")[0];
        if (aiSummary) {
          aiSummary.textContent = `✓ สร้างบทแล้ว • ${dur.toFixed(0)} วินาที • เสียง ${studioVoiceSelect?.value || ""} ${speedLabel}`;
        }
      }

      buildRandomCutPlan();
      seekStudioPreview(0);
      startStudioPreview();

      toast(
        data.fallback_notice
          ? `สร้างเสร็จแล้ว! (${data.fallback_notice})`
          : `✨ สร้างบท + Header + พากย์เสียง (${dur.toFixed(1)}s) สำเร็จ! กำลังเล่น Preview Video`,
        false,
        4500
      );
    } catch (err) {
      toast(err.message, false, 4500);
    } finally {
      if (studioGenerateAllBtn) studioGenerateAllBtn.disabled = false;
      if (studioRevoiceBtn) studioRevoiceBtn.disabled = false;
      if (studioGenSpinner) studioGenSpinner.classList.add("hidden");
      if (studioGenBtnText) {
        studioGenBtnText.textContent = "✨ ให้ AI คิดบท + สร้าง Header + พากย์เสียง + ทำซับไตเติ้ล";
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 6. TEMPLATES & REAL-TIME 9:16 CANVAS RENDERER
  // ---------------------------------------------------------------------------
  function renderTemplateSelectorGrid() {
    if (!studioTemplateGrid) return;
    studioTemplateGrid.innerHTML = STUDIO_TEMPLATES.map((tpl) => {
      const isSelected = tpl.id === studioState.selectedTemplateId;
      return `
        <button
          type="button"
          data-tpl-id="${tpl.id}"
          class="text-left p-3 rounded-xl border transition flex flex-col justify-between gap-1 ${
            isSelected
              ? "bg-slate-800/95 border-fuchsia-500 ring-2 ring-fuchsia-500/25 shadow-lg"
              : "bg-slate-950/80 border-slate-800 hover:border-slate-700"
          }"
        >
          <div>
            <div class="flex items-center justify-between gap-1">
              <span class="text-xs font-extrabold text-white">${escapeHtml(tpl.name)}</span>
              <span class="w-2.5 h-2.5 rounded-full" style="background:${tpl.accentColor}"></span>
            </div>
            <span class="inline-block mt-1 px-1.5 py-0.5 rounded bg-slate-900 text-[10px] font-bold text-slate-300">
              ${escapeHtml(tpl.badge)}
            </span>
          </div>
          <p class="text-[10px] text-slate-400 leading-snug mt-1">${escapeHtml(tpl.desc)}</p>
        </button>
      `;
    }).join("");

    studioTemplateGrid.querySelectorAll("[data-tpl-id]").forEach((btn) => {
      btn.addEventListener("click", () => {
        studioState.selectedTemplateId = btn.getAttribute("data-tpl-id") || "clean-no-anim";
        try {
          localStorage.setItem("studio_selected_template", studioState.selectedTemplateId);
        } catch (_) {}
        renderTemplateSelectorGrid();
        renderCurrentStudioFrame();
      });
    });
  }

  function getActiveTemplate() {
    return (
      STUDIO_TEMPLATES.find((t) => t.id === studioState.selectedTemplateId) || STUDIO_TEMPLATES[0]
    );
  }

  function getActiveCutSegment(timeSec) {
    const segs = studioState.cutSegments;
    if (!segs || segs.length === 0) return null;
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      if (timeSec >= s.start && timeSec <= s.start + s.duration) {
        return s;
      }
    }
    return segs[segs.length - 1];
  }

  function getActiveSubtitleScene(timeSec) {
    const scenes = studioState.scenes || [];
    for (let i = 0; i < scenes.length; i++) {
      const sc = scenes[i];
      if (timeSec >= sc.start && timeSec <= sc.start + sc.duration) {
        return sc;
      }
    }
    return scenes[scenes.length - 1] || null;
  }

  /**
   * Draw source video frame inside viewport with zero blank-frame flicker!
   */
  function drawVideoLayer(ctx, w, h, timeSec, tpl) {
    const bgGrad = ctx.createLinearGradient(0, 0, 0, h);
    bgGrad.addColorStop(0, "#090d16");
    bgGrad.addColorStop(1, "#1e1b4b");
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, w, h);

    const activeSeg = getActiveCutSegment(timeSec);
    const clipObj = activeSeg
      ? studioState.clips.find((c) => c.id === activeSeg.clipId) || studioState.clips[0]
      : studioState.clips[0];

    let vx = 0,
      vy = 0,
      vw = w,
      vh = h,
      radius = 0;
    if (tpl.frameMode === "pop-card") {
      vw = Math.round(w * 0.9);
      vh = Math.round(h * 0.72);
      vx = Math.round((w - vw) / 2);
      vy = Math.round(h * 0.14);
      radius = 36;
    } else if (tpl.frameMode === "bento-3d") {
      vw = Math.round(w * 0.88);
      vh = Math.round(h * 0.68);
      vx = Math.round((w - vw) / 2);
      vy = Math.round(h * 0.16);
      radius = 40;
    }

    ctx.save();
    if (radius > 0) {
      ctx.beginPath();
      ctx.roundRect(vx, vy, vw, vh, radius);
      ctx.clip();
    }

    // Choose best visual source: live <video> -> cached frame buffer -> thumbnail image
    let drawableSource = null;
    let srcW = 1080;
    let srcH = 1920;

    if (clipObj) {
      const vid = clipObj.videoEl;
      if (vid && vid.readyState >= 2 && !vid.seeking && vid.videoWidth > 0) {
        drawableSource = vid;
        srcW = vid.videoWidth;
        srcH = vid.videoHeight;
        // Keep the fallback frame always current (so a seek shows the last frame, never an old one),
        // but at reduced size so the copy stays cheap.
        if (clipObj.lastFrameCanvas) {
          const cacheW = Math.min(srcW, 1080);
          const cacheH = Math.round((srcH / srcW) * cacheW);
          if (clipObj.lastFrameCanvas.width !== cacheW || clipObj.lastFrameCanvas.height !== cacheH) {
            clipObj.lastFrameCanvas.width = cacheW;
            clipObj.lastFrameCanvas.height = cacheH;
          }
          const fctx = clipObj.lastFrameCanvas.getContext("2d");
          if (fctx) {
            try {
              fctx.imageSmoothingEnabled = true;
              fctx.imageSmoothingQuality = "high";
              fctx.drawImage(vid, 0, 0, cacheW, cacheH);
              clipObj.hasDecodedFrame = true;
            } catch (_) {}
          }
        }
      } else if (clipObj.hasDecodedFrame && clipObj.lastFrameCanvas) {
        drawableSource = clipObj.lastFrameCanvas;
        srcW = clipObj.lastFrameCanvas.width || 1080;
        srcH = clipObj.lastFrameCanvas.height || 1920;
      } else if (clipObj.thumbImg && clipObj.thumbImg.complete) {
        drawableSource = clipObj.thumbImg;
        srcW = clipObj.thumbImg.naturalWidth || 540;
        srcH = clipObj.thumbImg.naturalHeight || 960;
      }
    }

    if (drawableSource) {
      const localT = activeSeg ? Math.max(0, timeSec - activeSeg.start) : timeSec;
      const segDur = activeSeg ? Math.max(0.4, activeSeg.duration) : 3.0;
      const prog = Math.max(0, Math.min(1, localT / segDur));

      let zoom = 1.03;
      let panX = 0;
      let panY = 0;
      const zType = activeSeg?.zoomEffect || "static";
      if (zType === "zoomIn") {
        zoom = 1.02 + 0.04 * prog;
      } else if (zType === "zoomOut") {
        zoom = 1.06 - 0.04 * prog;
      } else if (zType === "panLeft") {
        zoom = 1.04;
        panX = (0.5 - prog) * 16;
      } else if (zType === "panRight") {
        zoom = 1.04;
        panX = (prog - 0.5) * 16;
      } else if (zType === "kenBurns") {
        zoom = 1.02 + 0.03 * prog;
        panX = (0.5 - prog) * 12;
        panY = (0.5 - prog) * 8;
      } else {
        // static - smooth steady frame, zero eye strain
        zoom = 1.03;
        panX = 0;
        panY = 0;
      }

      const transDur = 0.28;
      let slideOffsetX = 0;
      let flashAlpha = 0;
      let fadeAlpha = 1.0;
      if (activeSeg && activeSeg.index > 0 && localT < transDur) {
        const tp = localT / transDur;
        if (activeSeg.transition === "whip-slide") {
          slideOffsetX = (1 - tp) * 140 * (activeSeg.index % 2 === 0 ? 1 : -1);
        } else if (activeSeg.transition === "cross-zoom") {
          zoom *= 1.05 - 0.05 * tp;
        } else if (activeSeg.transition === "flash-pop") {
          flashAlpha = (1 - tp) * 0.22;
        } else if (activeSeg.transition === "dissolve") {
          fadeAlpha = Math.min(1, 0.4 + 0.6 * tp);
        }
      }

      const scale = Math.max(vw / srcW, vh / srcH) * zoom;
      const drawW = srcW * scale;
      const drawH = srcH * scale;
      const drawX = vx + (vw - drawW) / 2 + panX + slideOffsetX;
      const drawY = vy + (vh - drawH) / 2 + panY;

      ctx.save();
      if (fadeAlpha < 0.99) {
        ctx.globalAlpha = fadeAlpha;
      }
      try {
        ctx.drawImage(drawableSource, drawX, drawY, drawW, drawH);
      } catch (_) {}
      ctx.restore();

      if (flashAlpha > 0.02) {
        ctx.fillStyle = `rgba(255,255,255,${flashAlpha})`;
        ctx.fillRect(vx, vy, vw, vh);
      }
    } else {
      // Only shown when 0 clips are in the queue
      const pGrad = ctx.createLinearGradient(vx, vy, vx + vw, vy + vh);
      pGrad.addColorStop(0, "#0f172a");
      pGrad.addColorStop(0.5, "#1e1b4b");
      pGrad.addColorStop(1, "#31102f");
      ctx.fillStyle = pGrad;
      ctx.fillRect(vx, vy, vw, vh);

      ctx.strokeStyle = "rgba(255,255,255,0.06)";
      ctx.lineWidth = 4;
      for (let r = 120; r <= 480; r += 120) {
        ctx.beginPath();
        ctx.arc(w / 2, h / 2, r + Math.sin(timeSec * 2) * 15, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.restore();

    if (radius > 0) {
      ctx.save();
      ctx.strokeStyle = tpl.accentColor;
      ctx.lineWidth = 6;
      ctx.shadowColor = tpl.accentColor;
      ctx.shadowBlur = 18;
      ctx.beginPath();
      ctx.roundRect(vx, vy, vw, vh, radius);
      ctx.stroke();
      ctx.restore();
    }

    const vig = ctx.createLinearGradient(0, 0, 0, h);
    vig.addColorStop(0, "rgba(0,0,0,0.45)");
    vig.addColorStop(0.28, "rgba(0,0,0,0.04)");
    vig.addColorStop(0.68, "rgba(0,0,0,0.06)");
    vig.addColorStop(1, "rgba(0,0,0,0.68)");
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, w, h);
  }

  function drawTemplateDecorations(ctx, w, h, timeSec, tpl) {
    if (tpl.id === "clean-no-anim" || tpl.noAnimation) {
      // Pure clean template: strictly NO audio wave bars, NO scan lines, NO HUD, NO ticker!
      return;
    }

    const totalDur = Math.max(1, studioState.totalDuration || 20);
    const prog = Math.max(0, Math.min(1, timeSec / totalDur));
    const accent = tpl.accentColor || "#fde047";
    const secondary = tpl.secondaryColor || "#38bdf8";

    ctx.save();

    ctx.fillStyle = "rgba(255,255,255,0.18)";
    ctx.fillRect(0, 0, w, 10);
    ctx.fillStyle = accent;
    ctx.fillRect(0, 0, w * prog, 10);

    if (tpl.id === "cyberpunk-tech-hud") {
      const scanY = h * 0.22 + ((Math.sin(timeSec * 1.8) + 1) * 0.5) * (h * 0.52);
      ctx.strokeStyle = accent;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(48, scanY);
      ctx.lineTo(w - 48, scanY);
      ctx.stroke();

      const m = 44,
        len = 56;
      ctx.lineWidth = 5;
      [
        [m, m + 30, 1, 1],
        [w - m, m + 30, -1, 1],
        [m, h - m, 1, -1],
        [w - m, h - m, -1, -1],
      ].forEach(([x0, y0, dx, dy]) => {
        ctx.beginPath();
        ctx.moveTo(x0, y0 + dy * len);
        ctx.lineTo(x0, y0);
        ctx.lineTo(x0 + dx * len, y0);
        ctx.stroke();
      });
    } else if (tpl.id === "cinematic-letterbox") {
      const m = 54,
        len = 48;
      ctx.strokeStyle = "rgba(255,255,255,0.65)";
      ctx.lineWidth = 3;
      [
        [m, h * 0.24, 1, 1],
        [w - m, h * 0.24, -1, 1],
        [m, h * 0.88, 1, -1],
        [w - m, h * 0.88, -1, -1],
      ].forEach(([x0, y0, dx, dy]) => {
        ctx.beginPath();
        ctx.moveTo(x0, y0 + dy * len);
        ctx.lineTo(x0, y0);
        ctx.lineTo(x0 + dx * len, y0);
        ctx.stroke();
      });
    } else if (tpl.id === "breaking-news-hud") {
      const tickerH = 74;
      const tickerY = h - tickerH;
      ctx.fillStyle = "#090d16";
      ctx.fillRect(0, tickerY, w, tickerH);
      ctx.fillStyle = "#ef4444";
      ctx.fillRect(0, tickerY, w, 5);

      const tickerText = `🔥 รีวิวของใช้จริง: ${studioState.headerText} • กดดูรายละเอียดที่ตะกร้าด้านล่าง • `;
      ctx.font = `700 30px "IBM Plex Sans Thai", sans-serif`;
      const tw = Math.max(350, ctx.measureText(tickerText).width);
      const offset = -((timeSec * 150) % tw);
      ctx.fillStyle = "#fde047";
      ctx.textBaseline = "middle";
      for (let x = offset; x < w + tw; x += tw) {
        ctx.fillText(tickerText, x, tickerY + tickerH / 2 + 2);
      }
    }

    if (tpl.id !== "breaking-news-hud") {
      const bars = 28;
      const barW = 10;
      const gap = 8;
      const totalWaveW = bars * (barW + gap);
      const startX = (w - totalWaveW) / 2;
      const baseY = h * 0.93;

      for (let i = 0; i < bars; i++) {
        const wave =
          studioState.isPlaying || studioState.isExporting
            ? 0.25 + 0.75 * Math.abs(Math.sin(timeSec * 10 + i * 0.45))
            : 0.25;
        const bh = Math.round(14 + wave * 42);
        ctx.fillStyle = i % 2 === 0 ? accent : secondary;
        ctx.beginPath();
        ctx.roundRect(startX + i * (barW + gap), baseY - bh / 2, barW, bh, 5);
        ctx.fill();
      }
    }

    ctx.restore();
  }

  /**
   * Draw HEADER at the top:
   * - STRICTLY NO rectangular background box behind the Header
   * - Word-safe wrapping via Intl.Segmenter('th') + auto font-scaling so words NEVER break in half!
   */
  // Text sprites: wrapping, font-fitting, stroke + shadowBlur are expensive. They only change
  // when the text/style changes, so render each once to an offscreen canvas and reuse it.
  const textSpriteCache = new Map();
  function getTextSprite(key, build) {
    const fullKey = `${key}|fonts:${document.fonts ? document.fonts.status : "x"}`;
    let sprite = textSpriteCache.get(fullKey);
    if (!sprite) {
      sprite = build();
      if (textSpriteCache.size > 60) textSpriteCache.clear();
      textSpriteCache.set(fullKey, sprite);
    }
    return sprite;
  }

  function buildStrokedTextSprite(lines, font, lineHeight, strokeWidth, strokeColor, shadow, fillFor, box) {
    const measureCtx = document.createElement("canvas").getContext("2d");
    measureCtx.font = font;
    const maxLineW = Math.max(1, ...lines.map((l) => measureCtx.measureText(l).width));
    const pad = Math.ceil(strokeWidth + shadow.blur * 2 + Math.abs(shadow.offsetY) + 40);
    const boxW = box ? maxLineW + 64 : 0;
    const boxH = box ? lines.length * lineHeight + 36 : 0;
    const cw = Math.ceil(Math.max(maxLineW, boxW) + pad * 2);
    const ch = Math.ceil(Math.max(lines.length * lineHeight, boxH) + pad * 2);
    const canvas = document.createElement("canvas");
    canvas.width = cw;
    canvas.height = ch;
    const c = canvas.getContext("2d");
    c.translate(cw / 2, ch / 2);
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.font = font;
    if (box) {
      c.fillStyle = box.fill;
      c.strokeStyle = box.stroke;
      c.lineWidth = 3;
      c.beginPath();
      c.roundRect(-boxW / 2, -boxH / 2, boxW, boxH, 24);
      c.fill();
      c.stroke();
    }
    lines.forEach((line, idx) => {
      const ly = (idx - (lines.length - 1) / 2) * lineHeight;
      if (strokeWidth > 0) {
        c.save();
        c.strokeStyle = strokeColor;
        c.lineWidth = strokeWidth;
        c.lineJoin = "round";
        c.lineCap = "round";
        c.miterLimit = 2;
        c.shadowColor = shadow.color;
        c.shadowBlur = shadow.blur;
        c.shadowOffsetY = shadow.offsetY;
        c.strokeText(line, 0, ly);
        c.restore();
      }
      c.fillStyle = fillFor(idx);
      c.fillText(line, 0, ly);
    });
    canvas.contentH = Math.max(lines.length * lineHeight, boxH);
    return canvas;
  }

  function fitPresetLines(lines, weight, startSize, minSize, maxW) {
    const c = document.createElement("canvas").getContext("2d");
    let fontSize = startSize;
    const fontOf = (sz) => `${weight} ${sz}px "Kanit", "IBM Plex Sans Thai", sans-serif`;
    c.font = fontOf(fontSize);
    while (fontSize > minSize && lines.some((line) => c.measureText(line).width > maxW)) {
      fontSize -= 2;
      c.font = fontOf(fontSize);
    }
    return { lines, fontSize, font: fontOf(fontSize) };
  }

  function fitWrappedLines(text, weight, startSize, minSize, maxW) {
    const c = document.createElement("canvas").getContext("2d");
    let fontSize = startSize;
    const fontOf = (sz) => `${weight} ${sz}px "Kanit", "IBM Plex Sans Thai", sans-serif`;
    c.font = fontOf(fontSize);
    let lines = wrapThaiTextByWords(c, text, maxW, 2);
    while (fontSize > minSize && lines.some((line) => c.measureText(line).width > maxW)) {
      fontSize -= 2;
      c.font = fontOf(fontSize);
      lines = wrapThaiTextByWords(c, text, maxW, 2);
    }
    return { lines, fontSize, font: fontOf(fontSize) };
  }

  // Center Y for a text sprite at posPct (0 = top, 100 = bottom), clamped so the
  // text never leaves the frame. X is always the horizontal center.
  function spriteCenterY(sprite, h, posPct, fallbackPct) {
    const pct = Number.isFinite(Number(posPct)) ? Number(posPct) : fallbackPct;
    const half = Math.min(h / 2, (sprite.contentH || sprite.height) / 2 + 12);
    return Math.max(half, Math.min(h - half, (h * pct) / 100));
  }

  function drawProminentStrokedHeader(ctx, w, h, timeSec) {
    const rawHeader = (studioState.headerText || "").trim();
    if (!rawHeader) return;

    const baseFont = Number(studioState.headerFontSize) || 100;
    const strokeWidth = Number(studioState.headerStrokeWidth) || 20;
    const fillColor = studioState.headerColor || "#fde047";
    const strokeColor = studioState.headerStrokeColor || "#000000";

    const sprite = getTextSprite(
      `hdr|${rawHeader}|${baseFont}|${strokeWidth}|${fillColor}|${strokeColor}|${w}`,
      () => {
        const fit = fitWrappedLines(rawHeader, 900, baseFont, 42, w * 0.88);
        return buildStrokedTextSprite(
          fit.lines,
          fit.font,
          fit.fontSize * 1.22,
          strokeWidth,
          strokeColor,
          { color: "rgba(0, 0, 0, 0.85)", blur: 18, offsetY: 6 },
          () => fillColor,
          null
        );
      }
    );

    const popScale = 1 + Math.sin(timeSec * 3.5) * 0.015;
    ctx.save();
    ctx.translate(w / 2, spriteCenterY(sprite, h, studioState.headerPosY, 13.5));
    ctx.scale(popScale, popScale);
    ctx.drawImage(sprite, -sprite.width / 2, -sprite.height / 2);
    ctx.restore();
  }

  /**
   * Draw Synchronized 2-Line Voiceover Subtitles (Word-safe + Auto-fit)
   */
  function drawSynchronizedSubtitle(ctx, w, h, timeSec, tpl) {
    const activeScene = getActiveSubtitleScene(timeSec);
    if (!activeScene) return;

    const top = (activeScene.line_top || "").trim();
    const bot = (activeScene.line_bottom || "").trim();
    const hasExplicitLines = Boolean(top && bot);

    const fullText = (
      activeScene.full_narration ||
      `${top} ${bot}`
    ).trim();
    if (!fullText) return;

    const baseFont = Number(studioState.subFontSize) || 76;
    const strokeWidth = Number(studioState.subStrokeWidth) || 14;
    const showBg = Boolean(studioState.subShowBg);
    const accent = tpl.accentColor || "#fde047";

    const spriteKey = hasExplicitLines
      ? `sub-lines|${top}///${bot}|${baseFont}|${strokeWidth}|${showBg}|${accent}|${w}`
      : `sub|${fullText}|${baseFont}|${strokeWidth}|${showBg}|${accent}|${w}`;

    const sprite = getTextSprite(
      spriteKey,
      () => {
        const fit = hasExplicitLines
          ? fitPresetLines([top, bot], 800, baseFont, 32, w * 0.88)
          : fitWrappedLines(fullText, 800, baseFont, 32, w * 0.88);

        return buildStrokedTextSprite(
          fit.lines,
          fit.font,
          fit.fontSize * 1.28,
          strokeWidth,
          "#000000",
          { color: "rgba(0,0,0,0.75)", blur: 12, offsetY: 4 },
          (idx) => (idx === 0 ? "#ffffff" : accent),
          showBg ? { fill: "rgba(9, 13, 22, 0.82)", stroke: accent } : null
        );
      }
    );

    const localT = Math.max(0, timeSec - (activeScene.start || 0));
    const entryP = Math.min(1, localT / 0.14);
    const scale = 0.9 + 0.1 * entryP;

    ctx.save();
    ctx.translate(w / 2, spriteCenterY(sprite, h, studioState.subPosY, 77));
    ctx.scale(scale, scale);
    ctx.drawImage(sprite, -sprite.width / 2, -sprite.height / 2);
    ctx.restore();
  }

  function renderStudioFrameAt(ctx, w, h, timeSec) {
    const tpl = getActiveTemplate();
    drawVideoLayer(ctx, w, h, timeSec, tpl);
    drawTemplateDecorations(ctx, w, h, timeSec, tpl);
    if (studioState.showHeader) {
      drawProminentStrokedHeader(ctx, w, h, timeSec);
    }
    if (studioState.showSubtitles) {
      drawSynchronizedSubtitle(ctx, w, h, timeSec, tpl);
    }
  }

  function ensureVideoPlaying(vid) {
    if (!vid || vid._playPending || !vid.paused || vid.readyState < 2) return;
    vid._playPending = true;
    try {
      const p = vid.play();
      if (p && typeof p.then === "function") {
        p.catch(() => {}).finally(() => {
          vid._playPending = false;
        });
      } else {
        vid._playPending = false;
      }
    } catch (_) {
      vid._playPending = false;
    }
  }

  function syncActiveClipVideoElement(timeSec, shouldPlay) {
    const activeSeg = getActiveCutSegment(timeSec);
    const activeClipId = activeSeg ? activeSeg.clipId : studioState.clips[0]?.id;
    const segs = studioState.cutSegments || [];
    const nextSeg = activeSeg ? segs[segs.indexOf(activeSeg) + 1] || null : null;

    studioState.clips.forEach((clip) => {
      const vid = clip.videoEl;
      if (!vid || vid.readyState < 1) return;
      vid.muted = true;
      vid.defaultMuted = true;
      vid.volume = 0;

      if (clip.id === activeClipId && activeSeg) {
        if (!studioState.isOriginalAudioMuted && !studioState.isExporting) {
          vid.muted = false;
          vid.defaultMuted = false;
          vid.volume = 0.7;
        } else {
          vid.muted = true;
          vid.defaultMuted = true;
          vid.volume = 0;
        }
        const dur = Math.max(1, Number.isFinite(vid.duration) && vid.duration > 0 ? vid.duration : 10);
        const targetTime = ((activeSeg.trimStart || 0) + Math.max(0, timeSec - activeSeg.start)) % dur;

        if (shouldPlay) {
          const drift = targetTime - vid.currentTime;
          if (!vid.seeking) {
            if (Math.abs(drift) > 0.65 || vid.ended) {
              // Real jump (new cut / clip loop): hard seek and resume play immediately on seeked
              try {
                vid.currentTime = targetTime;
              } catch (_) {}
              vid.playbackRate = 1;
              if (!vid._hasSeekResumeHook) {
                vid._hasSeekResumeHook = true;
                vid.addEventListener("seeked", () => {
                  if (studioState.isPlaying && !studioState.isExporting) {
                    ensureVideoPlaying(vid);
                  }
                });
              }
            } else {
              // Small drift: nudge speed instead of seeking (seeks = frozen/flickering frames)
              const rate = Math.abs(drift) > 0.06 ? Math.max(0.85, Math.min(1.15, 1 + drift * 0.8)) : 1;
              if (Math.abs(vid.playbackRate - rate) > 0.01) vid.playbackRate = rate;
            }
          }
          ensureVideoPlaying(vid);
        } else {
          if (!vid.paused) vid.pause();
          if (!vid.seeking && Math.abs(vid.currentTime - targetTime) > 0.2) {
            try {
              vid.currentTime = targetTime;
            } catch (_) {}
          }
        }
      } else {
        if (!vid.paused) vid.pause();
        // Pre-seek the clip used by the next cut so the switch shows a ready frame (no freeze)
        if (shouldPlay && nextSeg && clip.id === nextSeg.clipId && !vid.seeking) {
          const dur = Number.isFinite(vid.duration) && vid.duration > 0 ? vid.duration : 10;
          const nextStart = (nextSeg.trimStart || 0) % dur;
          if (Math.abs(vid.currentTime - nextStart) > 0.15) {
            try {
              vid.currentTime = nextStart;
            } catch (_) {}
          }
        }
      }
    });
  }

  function renderCurrentStudioFrame() {
    const studioPreviewCanvas = previewCanvasEl;
    if (!studioPreviewCanvas) return;
    // While exporting, the export loop owns the clip <video> elements. Preview redraws
    // (fired by video timeupdate/seeked events) would pause & seek them back to the
    // preview time -> frozen video that flickers between two positions in the export.
    if (studioState.isExporting) return;
    const ctx = studioPreviewCanvas.getContext("2d");
    if (!ctx) return;

    syncActiveClipVideoElement(
      studioState.currentTime,
      studioState.isPlaying && isEngineVisible() && !studioState.isExporting
    );

    renderStudioFrameAt(
      ctx,
      studioPreviewCanvas.width,
      studioPreviewCanvas.height,
      studioState.currentTime
    );
    updateStudioPlayerHud();
  }

  function updateStudioPlayerHud() {
    const dur = Math.max(1, studioState.totalDuration || 20);
    const cur = Math.max(0, Math.min(dur, studioState.currentTime));

    if (studioTimecodeText) {
      studioTimecodeText.textContent = `${cur.toFixed(1)}s / ${dur.toFixed(1)}s`;
    }
    if (studioTimelineScrubber) {
      studioTimelineScrubber.max = String(dur);
      studioTimelineScrubber.value = String(cur);
    }
    if (studioPlayPauseBtn) {
      studioPlayPauseBtn.innerHTML = studioState.isPlaying ? "⏸ หยุด" : "▶ เล่นพรีวิว";
    }
    if (studioCanvasPlayOverlay) {
      studioCanvasPlayOverlay.classList.toggle("opacity-0", studioState.isPlaying);
    }
  }

  // ---------------------------------------------------------------------------
  // 7. LIVE PREVIEW PLAYBACK LOOP
  // ---------------------------------------------------------------------------
  function startStudioPreview() {
    if (studioState.isExporting) return;
    if (studioState.currentTime >= studioState.totalDuration - 0.1) {
      studioState.currentTime = 0;
    }
    studioState.isPlaying = true;
    if (studioState.voiceAudio) {
      studioState.voiceAudio.muted = studioState.isVoiceMuted;
      studioState.voiceAudio.currentTime = studioState.currentTime;
      studioState.voiceAudio.play().catch(() => {});
    }
    renderCurrentStudioFrame();
  }

  function pauseStudioPreview() {
    studioState.isPlaying = false;
    if (studioState.voiceAudio && !studioState.voiceAudio.paused) {
      studioState.voiceAudio.pause();
    }
    studioState.clips.forEach((c) => {
      if (c.videoEl && !c.videoEl.paused) c.videoEl.pause();
    });
    updateStudioPlayerHud();
  }

  function toggleStudioPreview() {
    if (studioState.isPlaying) {
      pauseStudioPreview();
    } else {
      startStudioPreview();
    }
  }

  function seekStudioPreview(timeSec) {
    const dur = Math.max(1, studioState.totalDuration || 20);
    studioState.currentTime = Math.max(0, Math.min(dur, Number(timeSec) || 0));
    if (studioState.voiceAudio) {
      try {
        studioState.voiceAudio.currentTime = studioState.currentTime;
      } catch (_) {}
    }
    renderCurrentStudioFrame();
  }

  let lastTickTs = performance.now();
  function runStudioPreviewLoop(now) {
    const dt = (now - lastTickTs) / 1000;
    lastTickTs = now;

    if (isEngineVisible() && !studioState.isExporting && studioState.isPlaying) {
      if (studioState.voiceAudio && !studioState.voiceAudio.paused) {
        studioState.currentTime = studioState.voiceAudio.currentTime;
      } else {
        studioState.currentTime += dt;
      }

      if (studioState.currentTime >= studioState.totalDuration) {
        studioState.currentTime = 0;
        if (studioState.voiceAudio) {
          studioState.voiceAudio.currentTime = 0;
          studioState.voiceAudio.play().catch(() => {});
        }
      }
      renderCurrentStudioFrame();
    }

    requestAnimationFrame(runStudioPreviewLoop);
  }

  // ---------------------------------------------------------------------------
  // 8. RENDER & EXPORT FINAL .MP4 VIDEO + FINAL VIDEO PREVIEW PLAYER
  // ---------------------------------------------------------------------------
  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(String(reader.result || ""));
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  // Shared by page 2 export and page 3 batch render.
  // Plays the CURRENT timeline (whatever project is loaded into studioState) in real time into an
  // offscreen canvas + MediaRecorder and returns the recorded WebM blob.
  async function recordTimelineToBlob(resMode, onProgress) {
    const fps = 30;
    let width = 720;
    let height = 1280;
    let targetBitrate = 9_000_000; // 9 Mbps high bitrate for crystal-clear 720p
    if (resMode === "1080p") {
      width = 1080;
      height = 1920;
      targetBitrate = 18_000_000; // 18 Mbps for ultra-sharp Full HD
    } else if (resMode === "480p") {
      width = 480;
      height = 854;
      targetBitrate = 4_000_000;
    }
    const targetDur = Math.max(3, Number(studioState.totalDuration) || 20);

    pauseStudioPreview();
    studioState.isExporting = true;
    let workerTicker = null;
    try {
      const offCanvas = document.createElement("canvas");
      offCanvas.width = width;
      offCanvas.height = height;
      const ctx = offCanvas.getContext("2d", { alpha: false });
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";

      // Manual frame capture (captureStream(0) + requestFrame): one encoded frame per drawn frame,
      // no duplicated / half-drawn frames from the auto-capture timer.
      let canvasStream = offCanvas.captureStream(0);
      let videoTrack = canvasStream.getVideoTracks()[0];
      const manualFrames = !!(videoTrack && typeof videoTrack.requestFrame === "function");
      if (!manualFrames) {
        canvasStream = offCanvas.captureStream(fps);
        videoTrack = canvasStream.getVideoTracks()[0];
      }

      let audioCtx = null;
      let audioSource = null;
      let audioTracks = [];

      if (studioState.voiceAudioDataUrl) {
        try {
          const resp = await fetch(studioState.voiceAudioDataUrl);
          const arrBuf = await resp.arrayBuffer();
          audioCtx = new (window.AudioContext || window.webkitAudioContext)();
          if (audioCtx.state === "suspended") await audioCtx.resume();
          const decoded = await audioCtx.decodeAudioData(arrBuf);
          const dest = audioCtx.createMediaStreamDestination();
          audioSource = audioCtx.createBufferSource();
          audioSource.buffer = decoded;
          audioSource.connect(dest);
          audioTracks = dest.stream.getAudioTracks();
        } catch (ae) {
          console.warn("[Studio] Audio stream mix warning:", ae);
        }
      }

      // VP8 first: software encoder, reliable, light enough at 720p. The browser's hardware H.264
      // path can emit green/corrupt frames on some GPUs; the server re-encodes to H.264 anyway.
      const mimeCandidates = [
        "video/webm;codecs=vp8,opus",
        "video/webm;codecs=vp9,opus",
        "video/webm",
        "video/mp4",
      ];
      let chosenMime = "video/webm";
      for (const m of mimeCandidates) {
        if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m)) {
          chosenMime = m;
          break;
        }
      }

      const combinedStream = new MediaStream([
        ...canvasStream.getVideoTracks(),
        ...audioTracks,
      ]);

      const recorder = new MediaRecorder(combinedStream, {
        mimeType: chosenMime,
        videoBitsPerSecond: targetBitrate,
        audioBitsPerSecond: 192_000,
      });

      const chunks = [];
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunks.push(e.data);
      };

      const stopPromise = new Promise((resolve, reject) => {
        recorder.onstop = () => {
          if (audioCtx) audioCtx.close().catch(() => {});
          resolve(new Blob(chunks, { type: chosenMime }));
        };
        recorder.onerror = reject;
      });

      const scaleX = width / 1080;
      const scaleY = height / 1920;

      // Prime: put the first clip at its start frame before recording begins
      syncActiveClipVideoElement(0, true);
      await new Promise((r) => setTimeout(r, 250));

      recorder.start(1000);
      // Clock = audio clock when available, so picture and voice can't drift apart.
      const audioStartAt = audioCtx ? audioCtx.currentTime + 0.05 : 0;
      if (audioSource) audioSource.start(audioStartAt);
      const startTs = performance.now() + (audioCtx ? 50 : 0);
      const clockNow = () =>
        audioCtx
          ? audioCtx.currentTime - audioStartAt
          : (performance.now() - startTs) / 1000;

      // Web Worker Unthrottled Ticker:
      // Browsers throttle setTimeout to 1000ms in background tabs/minimized windows,
      // but Web Workers are NEVER throttled! This allows video rendering to continue smoothly
      // even when the user switches tabs, minimizes the browser, or works in other apps!
      try {
        const workerCode = `
          let timer = null;
          self.onmessage = function(e) {
            if (e.data === 'start') {
              if (timer) clearInterval(timer);
              timer = setInterval(function() {
                self.postMessage('tick');
              }, 10);
            } else if (e.data === 'stop') {
              if (timer) clearInterval(timer);
              timer = null;
            }
          };
        `;
        const blob = new Blob([workerCode], { type: "application/javascript" });
        const workerUrl = URL.createObjectURL(blob);
        const worker = new Worker(workerUrl);
        workerTicker = {
          start(cb) {
            worker.onmessage = cb;
            worker.postMessage("start");
          },
          stop() {
            try {
              worker.postMessage("stop");
              worker.terminate();
              URL.revokeObjectURL(workerUrl);
            } catch (_) {}
          },
        };
      } catch (we) {
        console.warn("[Studio] Web Worker ticker fallback:", we);
      }

      const frameInterval = 1 / fps;
      let lastFrameT = -1;
      let lastUiTs = 0;

      await new Promise((resolve) => {
        let isDone = false;
        const tick = () => {
          if (isDone) return;
          const elapsed = clockNow();
          if (elapsed >= targetDur) {
            isDone = true;
            resolve();
            return;
          }

          if (elapsed >= 0 && elapsed - lastFrameT >= frameInterval * 0.9) {
            syncActiveClipVideoElement(elapsed, true);
            const seg = getActiveCutSegment(elapsed);
            const activeVid = seg ? studioState.clips.find((c) => c.id === seg.clipId)?.videoEl : null;
            const notReady = activeVid && (activeVid.seeking || activeVid.readyState < 2);
            if (notReady && lastFrameT >= 0 && elapsed - lastFrameT < 0.3) {
              return;
            }
            lastFrameT = elapsed;
            ctx.save();
            ctx.scale(scaleX, scaleY);
            renderStudioFrameAt(ctx, 1080, 1920, elapsed);
            ctx.restore();
            if (manualFrames) {
              try {
                videoTrack.requestFrame();
              } catch (_) {}
            }
          }

          const nowMs = performance.now();
          if (nowMs - lastUiTs > 250) {
            lastUiTs = nowMs;
            const shown = Math.max(0, elapsed);
            if (typeof onProgress === "function") {
              try {
                onProgress(Math.min(95, Math.round((shown / targetDur) * 90)), shown, targetDur);
              } catch (_) {}
            }
          }
        };

        if (workerTicker) {
          workerTicker.start(tick);
        } else {
          const runLoop = () => {
            if (isDone) return;
            tick();
            setTimeout(runLoop, 4);
          };
          runLoop();
        }
      });

      if (workerTicker) workerTicker.stop();
      workerTicker = null;

      studioState.clips.forEach((c) => {
        if (c.videoEl && !c.videoEl.paused) c.videoEl.pause();
      });

      recorder.stop();
      const recordedBlob = await stopPromise;
      return { blob: recordedBlob, fps };
    } finally {
      if (workerTicker) workerTicker.stop();
      studioState.isExporting = false;
      studioState.clips.forEach((c) => {
        if (c.videoEl) c.videoEl.playbackRate = 1;
      });
    }
  }

  // Upload the recording -> server converts to H.264 MP4. With saveName the server also writes the
  // MP4 into the chosen output folder. returnBody=false answers with the saved path only.
  async function convertRecordingToMp4(recordedBlob, fps, { saveName = "", returnBody = true } = {}) {
    let mp4Blob = null;
    let savedPath = "";
    let saveError = "";
    let convertError = "";

    // 1. Primary: Direct binary stream upload via FormData (avoids 30MB base64 memory overhead)
    try {
      const formData = new FormData();
      formData.append("file", recordedBlob, "recording.webm");
      formData.append("fps", String(fps));
      if (saveName) formData.append("save_name", saveName);
      formData.append("return_body", returnBody ? "true" : "false");

      const convResp = await fetch("/api/studio/convert-mp4-file", {
        method: "POST",
        body: formData,
      });

      if (convResp.ok) {
        if (returnBody) {
          mp4Blob = await convResp.blob();
          savedPath = decodeURIComponent(convResp.headers.get("X-Saved-Path") || "");
          saveError = decodeURIComponent(convResp.headers.get("X-Save-Error") || "");
        } else {
          const data = await convResp.json().catch(() => ({}));
          savedPath = data.saved_path || "";
          return { mp4Blob: null, savedPath, saveError: "", convertError: "" };
        }
      } else {
        const errText = await convResp.text().catch(() => "");
        let errDetail = "";
        try {
          const parsed = JSON.parse(errText);
          errDetail = parsed.detail || "";
        } catch (_) {
          errDetail = errText.slice(0, 150);
        }
        convertError = errDetail || `HTTP ${convResp.status}`;
        console.warn("[Studio] Binary convert failed:", errDetail);
      }
    } catch (uploadErr) {
      convertError = String(uploadErr?.message || uploadErr);
      console.warn("[Studio] Binary upload error:", uploadErr);
    }

    if (!returnBody) {
      throw new Error(convertError || "แปลงไฟล์ MP4 ไม่สำเร็จ");
    }

    // 2. Fallback: Base64 JSON POST (/api/studio/convert-mp4) if FormData didn't succeed
    if (!mp4Blob) {
      try {
        const rawDataUrl = await blobToDataUrl(recordedBlob);
        const b64Part = rawDataUrl.slice(rawDataUrl.lastIndexOf(",") + 1);
        const normalizedDataUrl = `data:video/webm;base64,${b64Part}`;

        const convResp = await fetch("/api/studio/convert-mp4", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ video_data_url: normalizedDataUrl, fps }),
        });

        if (convResp.ok) {
          mp4Blob = await convResp.blob();
        } else {
          const errText = await convResp.text().catch(() => "");
          let errDetail = "";
          try {
            const parsed = JSON.parse(errText);
            errDetail = parsed.detail || "";
          } catch (_) {
            errDetail = errText.slice(0, 150);
          }
          convertError = errDetail || convertError;
          console.warn("[Studio] Base64 convert also failed:", errDetail);
        }
      } catch (jsonErr) {
        console.warn("[Studio] Base64 convert exception:", jsonErr);
      }
    }
    return { mp4Blob, savedPath, saveError, convertError };
  }

  function exportFileStem() {
    return (studioState.headerText || "ai-review-video").replace(/[\\/:*?"<>|]+/g, "").trim().slice(0, 40) || "ai-review-video";
  }

  async function exportStudioVideoToMp4() {
    if (studioState.isExporting || studioState.isExportBusy) return;
    studioState.isExportBusy = true;

    if (studioExportMp4Btn) studioExportMp4Btn.disabled = true;
    if (studioExportProgressWrap) studioExportProgressWrap.classList.remove("hidden");
    if (studioExportProgressBar) studioExportProgressBar.style.width = "0%";
    if (studioExportPctText) studioExportPctText.textContent = "0%";
    if (studioExportProgressText) studioExportProgressText.textContent = "กำลังเรนเดอร์ภาพและเสียงพากย์...";

    try {
      const resMode = studioResolutionSelect?.value || studioState.exportResolution || "720p";
      const { blob: recordedBlob, fps } = await recordTimelineToBlob(resMode, (pct, shown, total) => {
        if (studioExportProgressBar) studioExportProgressBar.style.width = `${pct}%`;
        if (studioExportPctText) studioExportPctText.textContent = `${pct}%`;
        if (studioExportProgressText) {
          studioExportProgressText.textContent = `กำลังเรนเดอร์วิดีโอ ${shown.toFixed(1)}s / ${total.toFixed(1)}s (สลับแท็บ/พับจอทำงานอื่นได้ ระบบจะเซฟไฟล์ให้เองอัตโนมัติ)...`;
        }
      });

      if (studioExportProgressBar) studioExportProgressBar.style.width = "95%";
      if (studioExportPctText) studioExportPctText.textContent = "95%";
      if (studioExportProgressText) {
        studioExportProgressText.textContent = "กำลังแปลงเป็นไฟล์ .MP4 (H.264 + AAC) และเซฟลงโฟลเดอร์...";
      }

      let { mp4Blob, savedPath, saveError, convertError } = await convertRecordingToMp4(recordedBlob, fps, {
        saveName: exportFileStem(),
        returnBody: true,
      });

      // Ultimate Fallback: If backend FFmpeg fails, do NOT lose user's work!
      // Provide the recorded video blob directly so user can preview and download immediately.
      if (!mp4Blob) {
        mp4Blob = recordedBlob;
        toast(`แปลงเป็น MP4 ไม่สำเร็จ (${(convertError || "ไม่ทราบสาเหตุ").slice(0, 120)}) — ให้ไฟล์ต้นฉบับ .webm แทน`, false, 8000);
      }
      if (studioState.lastExportedMp4Url) {
        URL.revokeObjectURL(studioState.lastExportedMp4Url);
      }
      const mp4Url = URL.createObjectURL(mp4Blob);
      studioState.lastExportedMp4Blob = mp4Blob;
      studioState.lastExportedMp4Url = mp4Url;
      studioState.lastSavedPath = savedPath || "";

      if (studioExportProgressBar) studioExportProgressBar.style.width = "100%";
      if (studioExportPctText) studioExportPctText.textContent = "100%";
      if (studioExportProgressText) {
        studioExportProgressText.textContent = savedPath ? `เซฟแล้ว: ${savedPath}` : "เรนเดอร์ไฟล์ .MP4 เสร็จสมบูรณ์!";
      }

      if (studioFinalMp4Card) studioFinalMp4Card.classList.remove("hidden");
      if (studioFinalVideoPlayer) {
        studioFinalVideoPlayer.src = mp4Url;
        studioFinalVideoPlayer.load();
        studioFinalVideoPlayer.play().catch(() => {});
      }
      studioFinalMp4Card?.scrollIntoView({ behavior: "smooth", block: "nearest" });

      if (savedPath) {
        toast(`🎬 เรนเดอร์เสร็จ เซฟลงโฟลเดอร์แล้ว: ${savedPath}`, false, 6000);
      } else {
        // Folder save failed (or conversion fell back to .webm): download through the browser instead
        try {
          downloadExportedMp4();
        } catch (dlErr) {
          console.warn("[Studio] Auto download warning:", dlErr);
        }
        toast(
          saveError
            ? `เซฟลงโฟลเดอร์ไม่สำเร็จ (${saveError.slice(0, 100)}) — ดาวน์โหลดผ่านเบราว์เซอร์แทน`
            : "🎬 เรนเดอร์วิดีโอสำเร็จและดาวน์โหลดลงเครื่องแล้ว!",
          false,
          6000
        );
      }
    } catch (err) {
      toast(`เรนเดอร์วิดีโอไม่สำเร็จ: ${err.message}`, false, 4500);
    } finally {
      studioState.isExportBusy = false;
      if (studioExportMp4Btn) studioExportMp4Btn.disabled = false;
      renderCurrentStudioFrame();
    }
  }

  function downloadExportedMp4() {
    if (!studioState.lastExportedMp4Url) return;
    const a = document.createElement("a");
    a.href = studioState.lastExportedMp4Url;
    const ext = (studioState.lastExportedMp4Blob?.type || "").includes("webm") ? "webm" : "mp4";
    a.download = `${exportFileStem()}.${ext}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  // ---------------------------------------------------------------------------
  // 8b. OUTPUT FOLDER (shared by page 2 export and page 3 batch render)
  // ---------------------------------------------------------------------------
  const outputDirState = { path: "", loaded: false };

  function renderOutputDirLabels() {
    document.querySelectorAll("[data-output-dir-label]").forEach((el) => {
      el.textContent = outputDirState.path || "…";
      el.title = outputDirState.path || "";
    });
    window.dispatchEvent(new CustomEvent("studio:output-dir", { detail: { path: outputDirState.path } }));
  }

  async function loadOutputDir() {
    try {
      const r = await fetch("/api/studio/output-dir");
      const d = await r.json();
      if (r.ok) outputDirState.path = d.path || "";
    } catch (_) {}
    outputDirState.loaded = true;
    renderOutputDirLabels();
    return outputDirState.path;
  }

  async function pickOutputDir() {
    toast("📁 เลือกโฟลเดอร์ในหน้าต่างที่เด้งขึ้นมา (อาจอยู่หลังหน้าต่างนี้)", true, 0);
    try {
      const r = await fetch("/api/studio/pick-output-dir", { method: "POST" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.detail || `HTTP ${r.status}`);
      if (d.status === "cancelled") {
        toast("ยกเลิกการเลือกโฟลเดอร์");
        return outputDirState.path;
      }
      outputDirState.path = d.path || outputDirState.path;
      renderOutputDirLabels();
      toast(`📁 เซฟคลิปไปที่: ${outputDirState.path}`, false, 4000);
    } catch (err) {
      // No native dialog (non-Windows) -> type the path instead
      const typed = window.prompt(`${err.message || "เปิดหน้าต่างเลือกโฟลเดอร์ไม่ได้"}\n\nพิมพ์ตำแหน่งโฟลเดอร์สำหรับเซฟคลิป:`, outputDirState.path);
      if (typed && typed.trim()) await setOutputDir(typed.trim());
    }
    return outputDirState.path;
  }

  async function setOutputDir(path) {
    try {
      const r = await fetch("/api/studio/output-dir", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.detail || `HTTP ${r.status}`);
      outputDirState.path = d.path;
      renderOutputDirLabels();
      toast(`📁 เซฟคลิปไปที่: ${outputDirState.path}`, false, 4000);
    } catch (err) {
      toast(err.message || "ตั้งโฟลเดอร์ไม่สำเร็จ", false, 4500);
    }
  }

  async function openOutputDir(filePath = "") {
    try {
      const r = await fetch("/api/studio/open-output", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: filePath || "" }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.detail || `HTTP ${r.status}`);
    } catch (err) {
      toast(err.message || "เปิดโฟลเดอร์ไม่สำเร็จ", false, 4000);
    }
  }

  // Buttons anywhere on the page: data-output-dir-pick / data-output-dir-open
  document.addEventListener("click", (e) => {
    const pickBtn = e.target.closest("[data-output-dir-pick]");
    if (pickBtn) {
      e.preventDefault();
      pickOutputDir();
      return;
    }
    const openBtn = e.target.closest("[data-output-dir-open]");
    if (openBtn) {
      e.preventDefault();
      openOutputDir(openBtn.getAttribute("data-output-dir-open") || "");
    }
  });

  // ---------------------------------------------------------------------------
  // 9. EVENT LISTENERS & INITIALIZATION
  // ---------------------------------------------------------------------------
  function initStudioEvents() {
    navPage1Btn?.addEventListener("click", () => switchAppPage("search"));
    navPage2Btn?.addEventListener("click", () => switchAppPage("studio"));
    document.getElementById("navPage3Btn")?.addEventListener("click", () => switchAppPage("batch"));
    studioBackToSearchBtn?.addEventListener("click", () => switchAppPage("search"));
    studioGoSearchClipsBtn?.addEventListener("click", () => switchAppPage("search"));

    // API Key Modal
    openApiKeyModalBtn?.addEventListener("click", openApiKeyModal);
    openApiKeyModalBtnMobile?.addEventListener("click", openApiKeyModal);
    studioOpenApiBtn?.addEventListener("click", openApiKeyModal);
    closeApiKeyModalBtn?.addEventListener("click", closeApiKeyModal);
    apiKeyModal?.addEventListener("click", (e) => {
      if (e.target === apiKeyModal) closeApiKeyModal();
    });
    saveApiKeyBtn?.addEventListener("click", saveApiKeys);
    testApiKeyBtn?.addEventListener("click", testApiKeys);

    // Video Sources & Random Cut Shuffle
    studioPcVideoInput?.addEventListener("change", (e) => {
      handlePcVideoUpload(e.target.files);
      e.target.value = "";
    });
    studioAddLinkBtn?.addEventListener("click", addClipsFromLinks);
    studioLinkInput?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        addClipsFromLinks();
      }
    });
    studioClearClipsBtn?.addEventListener("click", clearAllStudioClips);
    studioCutPaceSelect?.addEventListener("change", () => {
      try {
        localStorage.setItem("studio_cut_pace", studioCutPaceSelect.value);
      } catch (_) {}
      buildRandomCutPlan();
      renderCurrentStudioFrame();
    });
    studioTransitionSelect?.addEventListener("change", () => {
      try {
        localStorage.setItem("studio_transition", studioTransitionSelect.value);
      } catch (_) {}
      buildRandomCutPlan();
      renderCurrentStudioFrame();
    });
    studioReshuffleBtn?.addEventListener("click", () => {
      buildRandomCutPlan(true);
      seekStudioPreview(0);
      startStudioPreview();
      toast("🔀 สุ่มลำดับการตัดยำสลับคลิปใหม่เรียบร้อย!");
    });

    // Shopee Info Fetch
    studioPasteShopeeBtn?.addEventListener("click", async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (text && studioShopeeUrlInput) {
          studioShopeeUrlInput.value = text;
          fetchShopeeInfoInStudio();
        }
      } catch (_) {
        studioShopeeUrlInput?.focus();
      }
    });
    studioFetchShopeeBtn?.addEventListener("click", fetchShopeeInfoInStudio);

    // AI Script & Voice Generation
    studioGenerateAllBtn?.addEventListener("click", () => generateAiScriptVoiceAndSubtitles(true));
    studioRevoiceBtn?.addEventListener("click", () => generateAiScriptVoiceAndSubtitles(false));

    // Real-time Header Controls
    studioHeaderInput?.addEventListener("input", () => {
      studioState.headerText = studioHeaderInput.value;
      renderCurrentStudioFrame();
    });
    studioToggleHeaderCheck?.addEventListener("change", () => {
      studioState.showHeader = Boolean(studioToggleHeaderCheck.checked);
      try {
        localStorage.setItem("studio_show_header", String(studioState.showHeader));
      } catch (_) {}
      renderCurrentStudioFrame();
    });
    studioHeaderSizeRange?.addEventListener("input", () => {
      studioState.headerFontSize = Number(studioHeaderSizeRange.value);
      if (studioHeaderSizeVal) studioHeaderSizeVal.textContent = studioHeaderSizeRange.value;
      try {
        localStorage.setItem("studio_header_font_size", studioHeaderSizeRange.value);
      } catch (_) {}
      renderCurrentStudioFrame();
    });
    studioHeaderStrokeRange?.addEventListener("input", () => {
      studioState.headerStrokeWidth = Number(studioHeaderStrokeRange.value);
      if (studioHeaderStrokeVal) studioHeaderStrokeVal.textContent = studioHeaderStrokeRange.value;
      renderCurrentStudioFrame();
    });
    studioHeaderColor?.addEventListener("input", () => {
      studioState.headerColor = studioHeaderColor.value;
      renderCurrentStudioFrame();
    });
    studioHeaderStrokeColor?.addEventListener("input", () => {
      studioState.headerStrokeColor = studioHeaderStrokeColor.value;
      renderCurrentStudioFrame();
    });

    document.querySelectorAll(".hdr-color-preset").forEach((btn) => {
      btn.addEventListener("click", () => {
        const c = btn.getAttribute("data-hcolor") || "#fde047";
        studioState.headerColor = c;
        if (studioHeaderColor) studioHeaderColor.value = c;
        renderCurrentStudioFrame();
      });
    });
    document.querySelectorAll(".hdr-stroke-preset").forEach((btn) => {
      btn.addEventListener("click", () => {
        const c = btn.getAttribute("data-scolor") || "#000000";
        studioState.headerStrokeColor = c;
        if (studioHeaderStrokeColor) studioHeaderStrokeColor.value = c;
        renderCurrentStudioFrame();
      });
    });

    // Real-time Subtitle Controls
    studioSubSizeRange?.addEventListener("input", () => {
      studioState.subFontSize = Number(studioSubSizeRange.value);
      if (studioSubSizeVal) studioSubSizeVal.textContent = studioSubSizeRange.value;
      try {
        localStorage.setItem("studio_sub_font_size", studioSubSizeRange.value);
      } catch (_) {}
      renderCurrentStudioFrame();
    });
    studioSubStrokeRange?.addEventListener("input", () => {
      studioState.subStrokeWidth = Number(studioSubStrokeRange.value);
      if (studioSubStrokeVal) studioSubStrokeVal.textContent = studioSubStrokeRange.value;
      renderCurrentStudioFrame();
    });
    studioSubBgCheck?.addEventListener("change", () => {
      studioState.subShowBg = Boolean(studioSubBgCheck.checked);
      renderCurrentStudioFrame();
    });
    studioToggleSubCheck?.addEventListener("change", () => {
      studioState.showSubtitles = Boolean(studioToggleSubCheck.checked);
      try {
        localStorage.setItem("studio_show_subtitles", String(studioState.showSubtitles));
      } catch (_) {}
      renderCurrentStudioFrame();
    });

    // Original Audio Buttons (Step 1 header & player bar)
    studioToggleOriginalAudioBtn?.addEventListener("click", toggleOriginalAudio);
    studioMuteOriginalBtn?.addEventListener("click", toggleOriginalAudio);

    function updateCensorBtnUI() {
      renderCensorUI();
    }

    // Live progress on the censor hero card while a scan is running
    function setCensorProgress(idx, total, pct, label, clipTitle) {
      const safePct = Math.max(0, Math.min(100, Number(pct) || 0));
      if (studioBlurChineseBtn) {
        studioBlurChineseBtn.innerHTML = `<span class="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></span> ⏳ ${escapeHtml(label)} (${idx + 1}/${total})`;
      }
      const bar = document.getElementById("studioCensorProgressBar");
      if (bar) bar.style.width = `${((idx + safePct / 100) / total) * 100}%`;
      const statusEl = document.getElementById("studioCensorStatusText");
      if (statusEl && clipTitle) statusEl.textContent = `กำลังเซนเซอร์: ${clipTitle}`;
    }

    async function applyCensoredVideoToClip(clip, censoredUrl) {
      clip.url = censoredUrl;
      clip.isCensored = true;
      clip.hasDecodedFrame = false;
      const resp = await fetch(censoredUrl);
      if (!resp.ok) throw new Error(`โหลดคลิปที่เซนเซอร์แล้วไม่สำเร็จ (HTTP ${resp.status})`);
      const blob = await resp.blob();
      const localBlobUrl = URL.createObjectURL(blob);
      clip.blobUrl = localBlobUrl;

      const vid = clip.videoEl;
      if (vid) {
        const curT = Number.isFinite(vid.currentTime) ? vid.currentTime : 0;
        await new Promise((resolve) => {
          const onReady = () => {
            vid.removeEventListener("loadeddata", onReady);
            resolve();
          };
          vid.addEventListener("loadeddata", onReady, { once: true });
          vid.src = localBlobUrl;
          vid.load();
          setTimeout(resolve, 2500);
        });
        try {
          vid.currentTime = curT;
        } catch (_) {}
        if (studioState.isPlaying && isEngineVisible()) {
          vid.play().catch(() => {});
        }
      }
    }

    async function runChineseCensorScan() {
      if (studioState.isCensoring) return;
      if (!studioState.clips.length) {
        toast("กรุณาเพิ่มคลิปเข้าคิวก่อนกดเซนเซอร์จีน");
        flashStudioSection("secFootage");
        return;
      }
      // Only scan clips not censored yet; if all are done, the button means "scan everything again"
      const pending = studioState.clips.filter((c) => !c.isCensored);
      const targets = pending.length ? pending : studioState.clips.slice();
      studioState.isCensoring = true;
      if (studioBlurChineseBtn) studioBlurChineseBtn.disabled = true;
      const censorCard = document.getElementById("censorCard");
      if (censorCard) censorCard.classList.remove("censor-pending");
      setCensorProgress(0, targets.length, 0, "เริ่มสแกน", targets[0].title);
      let totalHits = 0;
      try {
        for (let idx = 0; idx < targets.length; idx++) {
          const clip = targets[idx];
          const progressPlatform = clip.platform === "pc" ? "pc" : clip.platform;
          const progressId = clip.platform === "pc" ? clip.id : (clip.rawItem?.id || "");
          let pollTimer = null;
          if (progressId) {
            pollTimer = setInterval(async () => {
              try {
                const url = clip.platform === "pc"
                  ? `/api/studio/censor-progress?platform=pc&id=${encodeURIComponent(clip.id)}`
                  : `/api/studio/censor-progress?platform=${encodeURIComponent(progressPlatform)}&id=${encodeURIComponent(progressId)}`;
                const pr = await fetch(url);
                if (!pr.ok) return;
                const pd = await pr.json();
                if (pd.status === "idle") {
                  // backend is still downloading the source clip before it can scan
                  setCensorProgress(idx, targets.length, 0, "รอโหลดคลิป...", clip.title);
                } else if (typeof pd.pct === "number") {
                  const phase = pd.status === "rendering" ? "เรนเดอร์" : "สแกน";
                  setCensorProgress(idx, targets.length, pd.pct, `${phase} ${pd.pct}%`, clip.title);
                }
              } catch {}
            }, 350);
          } else {
            setCensorProgress(idx, targets.length, 0, "เซนเซอร์...", clip.title);
          }

          try {
            let data;
            if (clip.platform === "pc" && clip.rawFile) {
              const fd = new FormData();
              fd.append("file", clip.rawFile);
              fd.append("clip_key", `pc_${clip.id}`);
              const resp = await fetch("/api/studio/censor-chinese-upload", { method: "POST", body: fd });
              data = await resp.json();
              if (!resp.ok) throw new Error(data.detail || `HTTP ${resp.status}`);
            } else {
              const resp = await fetch("/api/studio/censor-chinese", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  platform: clip.platform,
                  id: clip.rawItem?.id || "",
                  direct_url: clip.rawItem?.direct_video_url || clip.rawItem?.url || "",
                  force: true,
                }),
              });
              data = await resp.json();
              if (!resp.ok) throw new Error(data.detail || `HTTP ${resp.status}`);
            }
            totalHits += Number(data.hits || 0);
            if (data.censored_url) {
              setCensorProgress(idx, targets.length, 100, "อัปเดตพรีวิว...", clip.title);
              await applyCensoredVideoToClip(clip, data.censored_url);
            }
          } finally {
            if (pollTimer) clearInterval(pollTimer);
          }
          updateClipsUI(); // flip this clip's badge to "censored" right away
        }
        studioState.isCensoring = false;
        updateClipsUI();
        renderCurrentStudioFrame();
        toast(`✅ เซนเซอร์ภาษาจีนเสร็จแล้ว (${totalHits} ช่วงเวลา) — พรีวิวใช้คลิปที่เซนเซอร์แล้ว`, false, 4500);
      } catch (err) {
        studioState.isCensoring = false;
        updateCensorBtnUI();
        toast(err?.message || "เซนเซอร์ภาษาจีนไม่สำเร็จ", false, 4500);
      } finally {
        studioState.isCensoring = false;
        renderCensorUI();
      }
    }

    // Auto-Censor Chinese Text from start to end of every clip in the queue
    studioBlurChineseBtn?.addEventListener("click", runChineseCensorScan);

    // Collapsible step cards (click the card header; buttons inside the header keep working)
    document.querySelectorAll("#pageStudioView .acc-head").forEach((head) => {
      head.addEventListener("click", (e) => {
        if (e.target.closest("button,label,input,select,a")) return;
        head.parentElement.classList.toggle("open");
      });
    });
    // Style card tabs: Template / Header / Script & subtitles
    document.querySelectorAll("#secStyle .tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => showStudioStyleTab(btn.dataset.tab));
    });
    renderCensorUI();

    // Live Preview Video Player Controls
    studioPlayPauseBtn?.addEventListener("click", toggleStudioPreview);
    studioCanvasPlayOverlay?.addEventListener("click", toggleStudioPreview);
    studioPreviewCanvas?.addEventListener("click", toggleStudioPreview);
    studioRestartBtn?.addEventListener("click", () => {
      seekStudioPreview(0);
      startStudioPreview();
    });
    studioMuteVoiceBtn?.addEventListener("click", () => {
      studioState.isVoiceMuted = !studioState.isVoiceMuted;
      if (studioState.voiceAudio) {
        studioState.voiceAudio.muted = studioState.isVoiceMuted;
      }
      if (studioMuteVoiceBtn) {
        studioMuteVoiceBtn.textContent = studioState.isVoiceMuted ? "🔇 ปิดเสียงพากย์" : "🔊 เสียงพากย์";
      }
    });
    studioTimelineScrubber?.addEventListener("input", () => {
      seekStudioPreview(Number(studioTimelineScrubber.value));
    });

    // Export Resolution Selector
    studioResolutionSelect?.addEventListener("change", () => {
      studioState.exportResolution = studioResolutionSelect.value || "720p";
      try {
        localStorage.setItem("studio_export_resolution", studioState.exportResolution);
      } catch (_) {}
    });

    // Export MP4 & Download
    studioExportMp4Btn?.addEventListener("click", exportStudioVideoToMp4);
    studioDownloadFinalMp4Btn?.addEventListener("click", downloadExportedMp4);
  }

  // ---------------------------------------------------------------------------
  // 10. ENGINE API FOR PAGE 3 (ทำหลายคลิป)
  // A project is "entered" by swapping its clips / script / voice / layout into studioState;
  // page 2's own values are kept aside and put back on leave. Preview, export and the
  // renderer are therefore the exact same code for page 2 and page 3.
  // ---------------------------------------------------------------------------
  const CTX_KEYS = [
    "clips",
    "cutSegments",
    "scenes",
    "spokenScript",
    "headerText",
    "showHeader",
    "showSubtitles",
    "headerPosY",
    "subPosY",
    "totalDuration",
    "voiceAudio",
    "voiceAudioDataUrl",
    "selectedTemplateId",
    "currentTime",
    "isPlaying",
    "voiceEngineLabel",
  ];
  let page2Snapshot = null;

  function enterBatchContext(ctx, canvas) {
    pauseStudioPreview();
    if (engineCtx === "page2") {
      page2Snapshot = {};
      CTX_KEYS.forEach((k) => {
        page2Snapshot[k] = studioState[k];
      });
    }
    engineCtx = "batch";
    CTX_KEYS.forEach((k) => {
      if (k in ctx) studioState[k] = ctx[k];
    });
    studioState.isPlaying = false;
    studioState.currentTime = 0;
    previewCanvasEl = canvas || null;
    renderCurrentStudioFrame();
  }

  function leaveBatchContext() {
    if (engineCtx !== "batch") return;
    pauseStudioPreview();
    engineCtx = "page2";
    if (page2Snapshot) {
      CTX_KEYS.forEach((k) => {
        studioState[k] = page2Snapshot[k];
      });
    }
    page2Snapshot = null;
    studioState.isPlaying = false;
    previewCanvasEl = studioPreviewCanvas;
    updateClipsUI();
    renderCutPreviewStrip();
    renderCurrentStudioFrame();
  }

  const SOURCE_LABELS = { douyin: "🎵 Douyin", xhs: "📕 RedNote", bilibili: "📺 Bilibili", pc: "💻 PC Upload" };

  // data: { key, platform, itemId, title, url, thumb, duration }
  function createRuntimeClip(data) {
    const clip = {
      id: data.key,
      title: data.title || "คลิป",
      platform: data.platform,
      sourceLabel: SOURCE_LABELS[data.platform] || data.platform,
      url: data.url,
      blobUrl: "",
      thumb: data.thumb || "",
      thumbImg: null,
      duration: Number(data.duration) || 12.0,
      rawItem: data.platform !== "pc" && data.itemId ? { id: data.itemId, platform: data.platform } : null,
      videoEl: null,
      lastFrameCanvas: null,
      hasDecodedFrame: false,
      isCaching: false,
      cacheProgress: 0,
      cacheLoadedMB: 0,
      cacheTotalMB: 0,
      cacheError: "",
      noAutoPlan: true,
    };
    setupClipVideoAndFrameBuffer(clip);
    return clip;
  }

  // Resolves once every clip is fully in RAM and decodable (or failed / timed out)
  function whenClipsReady(clips, timeoutMs = 120000) {
    const t0 = performance.now();
    return new Promise((resolve) => {
      const check = () => {
        const pending = clips.filter(
          (c) => !c.cacheError && (c.isCaching || !c.videoEl || c.videoEl.readyState < 2)
        );
        if (!pending.length || performance.now() - t0 > timeoutMs) {
          resolve(clips.filter((c) => c.cacheError).map((c) => `${c.title}: ${c.cacheError}`));
          return;
        }
        setTimeout(check, 200);
      };
      check();
    });
  }

  function disposeRuntimeClips(clips) {
    (clips || []).forEach((c) => {
      c.isCaching = false;
      if (c.videoEl) {
        try {
          c.videoEl.pause();
          c.videoEl.removeAttribute("src");
          c.videoEl.load();
        } catch (_) {}
        c.videoEl.remove();
        c.videoEl = null;
      }
      if (c.blobUrl) URL.revokeObjectURL(c.blobUrl);
      c.blobUrl = "";
    });
  }

  function getVoiceOptions() {
    if (!studioVoiceSelect) return [];
    return Array.from(studioVoiceSelect.options).map((o) => ({
      value: o.value,
      label: o.textContent.trim(),
      gender: o.getAttribute("data-gender") || "Male",
      disabled: o.disabled,
    }));
  }

  function selectOptions(sel) {
    return sel ? Array.from(sel.options).map((o) => ({ value: o.value, label: o.textContent.trim() })) : [];
  }

  function getPage2ClipData() {
    const clips = engineCtx === "page2" ? studioState.clips : (page2Snapshot?.clips || []);
    return clips.map((c) => ({
      platform: c.platform,
      itemId: c.platform === "pc" ? "" : c.rawItem?.id || "",
      directUrl: c.rawItem?.direct_video_url || (c.platform === "xhs" ? c.rawItem?.url || "" : ""),
      title: c.title,
      thumb: c.thumb || "",
      rawFile: c.rawFile || null,
    }));
  }

  // "เปิดแก้ละเอียดในหน้า 2": copy a page-3 project into page 2 (replaces page 2's current work)
  function loadProjectIntoPage2(p) {
    if (engineCtx !== "page2") leaveBatchContext();
    clearAllStudioClips();
    (p.clips || []).forEach((c) => {
      const clip = createRuntimeClip({
        key: c.key,
        platform: c.platform,
        itemId: c.itemId,
        title: c.title,
        url: p.censorOn && c.censoredUrl ? c.censoredUrl : c.url,
        thumb: c.thumb,
      });
      clip.noAutoPlan = false;
      clip.isCensored = Boolean(p.censorOn && c.censoredUrl);
      if (clip.rawItem) clip.rawItem.direct_video_url = c.directUrl || "";
      studioState.clips.push(clip);
    });
    if (studioShopeeUrlInput) studioShopeeUrlInput.value = p.shopeeUrl || "";
    if (studioProductTitle) studioProductTitle.value = p.productTitle || "";
    if (studioProductDesc) studioProductDesc.value = p.productDesc || "";
    setProductImage(p.productImage || "");
    if (studioTargetDuration && p.duration) studioTargetDuration.value = String(p.duration);
    if (studioSalesAngle && p.angle) studioSalesAngle.value = p.angle;
    if (studioVoiceSelect && p.voice) studioVoiceSelect.value = p.voice;
    if (studioVoiceSpeed && p.speed) studioVoiceSpeed.value = p.speed;
    studioState.headerText = p.header || studioState.headerText;
    if (studioHeaderInput) studioHeaderInput.value = studioState.headerText;
    studioState.spokenScript = p.script || "";
    if (studioScriptTextarea) studioScriptTextarea.value = studioState.spokenScript;
    if (Array.isArray(p.scenes) && p.scenes.length) studioState.scenes = p.scenes;
    if (p.audioDuration) studioState.totalDuration = Math.max(4, Number(p.audioDuration));
    if (studioState.voiceAudio) studioState.voiceAudio.pause();
    if (p.audioUrl) {
      studioState.voiceAudioDataUrl = p.audioUrl;
      const aud = new Audio(p.audioUrl);
      aud.preload = "auto";
      studioState.voiceAudio = aud;
    }
    if (p.template && STUDIO_TEMPLATES.some((t) => t.id === p.template)) {
      studioState.selectedTemplateId = p.template;
      renderTemplateSelectorGrid();
    }
    updateClipsUI();
    buildRandomCutPlan();
    switchAppPage("studio");
    seekStudioPreview(0);
    toast("🛠️ คัดลอกโปรเจคมาหน้า 2 แล้ว — แก้ที่นี่ไม่ย้อนกลับไปหน้า 3 (เรนเดอร์จากหน้า 2 ได้เลย)", false, 6000);
  }

  window.StudioEngine = {
    templates: STUDIO_TEMPLATES.map((t) => ({ id: t.id, name: t.name })),
    enter: enterBatchContext,
    leave: leaveBatchContext,
    isInBatch: () => engineCtx === "batch",
    set(key, value) {
      studioState[key] = value;
      if (key === "totalDuration") updateStudioPlayerHud();
      renderCurrentStudioFrame();
    },
    get: (key) => studioState[key],
    createRuntimeClip,
    whenClipsReady,
    disposeRuntimeClips,
    buildCutPlan(force = false) {
      buildRandomCutPlan(force);
      return studioState.cutSegments.map((s) => ({ ...s }));
    },
    play: startStudioPreview,
    pause: pauseStudioPreview,
    toggle: toggleStudioPreview,
    seek: seekStudioPreview,
    redraw: renderCurrentStudioFrame,
    playback: () => ({
      currentTime: studioState.currentTime,
      totalDuration: studioState.totalDuration,
      isPlaying: studioState.isPlaying,
    }),
    recordTimelineToBlob,
    convertRecordingToMp4,
    resolution: () => studioResolutionSelect?.value || studioState.exportResolution || "720p",
    keys: () => ({ gemini: studioState.geminiKeysText || "", openrouter: studioState.openrouterKeysText || "" }),
    voiceOptions: getVoiceOptions,
    speedOptions: () => selectOptions(studioVoiceSpeed),
    durationOptions: () => selectOptions(studioTargetDuration),
    angleOptions: () => selectOptions(studioSalesAngle),
    page2Defaults: () => ({
      voice: studioVoiceSelect?.value || "Puck",
      speed: studioVoiceSpeed?.value || "+15%",
      duration: Number(studioTargetDuration?.value || 20),
      angle: studioSalesAngle?.value || "podcast_ad",
      template: studioState.selectedTemplateId || "clean-no-anim",
    }),
    isBusy: () => Boolean(studioState.isExporting || studioState.isExportBusy || studioState.isCensoring),
    filterStorePolicyFromDesc,
    STORE_POLICY_WORDS,
    getPage2ClipData,
    loadProjectIntoPage2,
    outputDir: () => outputDirState.path,
    loadOutputDir,
    pickOutputDir,
    openOutputDir,
    toast,
    escapeHtml,
  };

  // Expose Studio API to Page 1
  window.StudioApp = {
    addClipFromPage1,
    syncShopeeProduct,
    switchAppPage,
    // Used by page 1 to mark search results that are already in the studio queue
    hasClip: (item) => Boolean(item) && studioState.clips.some((c) => c.id === `${item.platform}:${item.id}`),
    clipCount: () => studioState.clips.length,
  };
  window.dispatchEvent(new CustomEvent("studio:clips-changed"));

  // Boot
  try {
    const savedRes = localStorage.getItem("studio_export_resolution");
    if (savedRes && studioResolutionSelect) {
      studioResolutionSelect.value = savedRes;
    } else if (studioResolutionSelect) {
      studioResolutionSelect.value = "720p";
    }
    studioState.exportResolution = studioResolutionSelect?.value || "720p";

    const savedTpl = localStorage.getItem("studio_selected_template");
    if (savedTpl && STUDIO_TEMPLATES.some((t) => t.id === savedTpl)) {
      studioState.selectedTemplateId = savedTpl;
    } else {
      studioState.selectedTemplateId = "clean-no-anim";
    }

    const savedPace = localStorage.getItem("studio_cut_pace");
    if (savedPace && studioCutPaceSelect) {
      studioCutPaceSelect.value = savedPace;
    }
    const savedTrans = localStorage.getItem("studio_transition");
    if (studioTransitionSelect) {
      studioTransitionSelect.value = savedTrans || "none";
    }
    studioState.transitionMode = studioTransitionSelect?.value || "none";

    const savedHSize = localStorage.getItem("studio_header_font_size");
    const hSize = savedHSize ? Number(savedHSize) : 100;
    studioState.headerFontSize = hSize;
    if (studioHeaderSizeRange) studioHeaderSizeRange.value = String(hSize);
    if (studioHeaderSizeVal) studioHeaderSizeVal.textContent = String(hSize);

    const savedSubSize = localStorage.getItem("studio_sub_font_size");
    const subSize = savedSubSize ? Number(savedSubSize) : 76;
    studioState.subFontSize = subSize;
    if (studioSubSizeRange) studioSubSizeRange.value = String(subSize);
    if (studioSubSizeVal) studioSubSizeVal.textContent = String(subSize);

    const savedShowHeader = localStorage.getItem("studio_show_header");
    studioState.showHeader = savedShowHeader !== null ? savedShowHeader === "true" : true;
    if (studioToggleHeaderCheck) studioToggleHeaderCheck.checked = studioState.showHeader;

    const savedShowSub = localStorage.getItem("studio_show_subtitles");
    studioState.showSubtitles = savedShowSub !== null ? savedShowSub === "true" : true;
    if (studioToggleSubCheck) studioToggleSubCheck.checked = studioState.showSubtitles;

    const savedAudioMuted = localStorage.getItem("studio_original_audio_muted");
    studioState.isOriginalAudioMuted = savedAudioMuted !== null ? savedAudioMuted === "true" : true;
    updateOriginalAudioUI();
  } catch (_) {}

  // ---- Floating popup: move Header / Subtitle up & down (no horizontal movement) ----
  (function setupPositionPopup() {
    const popup = document.getElementById("studioPosPopup");
    const toggleBtn = document.getElementById("studioPosPopupToggleBtn");
    if (!popup || !toggleBtn) return;
    const handle = document.getElementById("studioPosPopupHandle");
    const DEFAULTS = { header: 13.5, sub: 77 };
    const STEP = 2;
    const targets = {
      header: {
        key: "headerPosY",
        storage: "studio_header_pos_y",
        range: document.getElementById("studioHeaderPosRange"),
        label: document.getElementById("studioHeaderPosVal"),
      },
      sub: {
        key: "subPosY",
        storage: "studio_sub_pos_y",
        range: document.getElementById("studioSubPosRange"),
        label: document.getElementById("studioSubPosVal"),
      },
    };

    function setPos(name, value, persist = true) {
      const t = targets[name];
      const v = Math.max(0, Math.min(100, Math.round(Number(value) * 2) / 2));
      studioState[t.key] = v;
      if (t.range) t.range.value = String(v);
      if (t.label) t.label.textContent = `${v}%`;
      if (persist) {
        try { localStorage.setItem(t.storage, String(v)); } catch (_) {}
      }
      renderCurrentStudioFrame();
    }

    Object.entries(targets).forEach(([name, t]) => {
      let saved = null;
      try { saved = localStorage.getItem(t.storage); } catch (_) {}
      setPos(name, saved !== null && saved !== "" ? Number(saved) : DEFAULTS[name], false);
      t.range?.addEventListener("input", () => setPos(name, t.range.value));
    });

    popup.querySelectorAll("[data-pos-target]").forEach((col) => {
      const name = col.dataset.posTarget;
      col.querySelectorAll("[data-pos-act]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const cur = Number(studioState[targets[name].key]) || 0;
          const act = btn.dataset.posAct;
          const next = act === "top" ? 0 : act === "bottom" ? 100 : act === "up" ? cur - STEP : cur + STEP;
          setPos(name, next);
        });
      });
    });

    document.getElementById("studioPosResetBtn")?.addEventListener("click", () => {
      setPos("header", DEFAULTS.header);
      setPos("sub", DEFAULTS.sub);
    });

    const PANEL_KEY = "studio_pos_popup_xy";
    function clampPanel(left, top) {
      const maxL = Math.max(0, window.innerWidth - popup.offsetWidth - 4);
      const maxT = Math.max(0, window.innerHeight - popup.offsetHeight - 4);
      popup.style.left = `${Math.max(4, Math.min(maxL, left))}px`;
      popup.style.top = `${Math.max(4, Math.min(maxT, top))}px`;
      popup.style.right = "auto";
      popup.style.bottom = "auto";
    }
    function showPopup(show) {
      popup.classList.toggle("hidden", !show);
      toggleBtn.classList.toggle("ring-2", show);
      toggleBtn.classList.toggle("ring-amber-400", show);
      if (show) {
        try {
          const xy = JSON.parse(localStorage.getItem(PANEL_KEY) || "null");
          if (xy) clampPanel(xy.left, xy.top);
        } catch (_) {}
      }
    }
    toggleBtn.addEventListener("click", () => showPopup(popup.classList.contains("hidden")));
    document.getElementById("studioPosPopupCloseBtn")?.addEventListener("click", () => showPopup(false));

    // Drag the popup window itself by its title bar
    handle?.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button")) return;
      const rect = popup.getBoundingClientRect();
      const dx = e.clientX - rect.left;
      const dy = e.clientY - rect.top;
      handle.setPointerCapture(e.pointerId);
      const move = (ev) => clampPanel(ev.clientX - dx, ev.clientY - dy);
      const up = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        const r = popup.getBoundingClientRect();
        try { localStorage.setItem(PANEL_KEY, JSON.stringify({ left: r.left, top: r.top })); } catch (_) {}
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
    });
    window.addEventListener("resize", () => {
      if (!popup.classList.contains("hidden")) {
        const r = popup.getBoundingClientRect();
        clampPanel(r.left, r.top);
      }
    });
  })();

  // ---- Persist all Page 2 Studio preferences to JSON (data/studio_config.json) + localStorage ----
  function collectStudioPreferences() {
    return {
      default_voice: studioVoiceSelect?.value || "Puck",
      voice_speed: studioVoiceSpeed?.value || "+15%",
      target_duration: Number(studioTargetDuration?.value || 20),
      sales_angle: studioSalesAngle?.value || "podcast_ad",
      cut_pace_sec: Number(studioState.cutPaceSec || 4.0),
      transition_mode: studioState.transitionMode || "none",
      is_original_audio_muted: Boolean(studioState.isOriginalAudioMuted),
      selected_template_id: studioState.selectedTemplateId || "clean-no-anim",
      show_header: Boolean(studioState.showHeader),
      header_font_size: Number(studioState.headerFontSize || 100),
      header_color: studioState.headerColor || "#fde047",
      header_stroke_color: studioState.headerStrokeColor || "#000000",
      header_stroke_width: Number(studioState.headerStrokeWidth || 20),
      header_pos_y: Number(studioState.headerPosY ?? 13.5),
      show_subtitles: Boolean(studioState.showSubtitles),
      sub_font_size: Number(studioState.subFontSize || 76),
      sub_stroke_width: Number(studioState.subStrokeWidth || 16),
      sub_show_bg: Boolean(studioState.subShowBg),
      sub_pos_y: Number(studioState.subPosY ?? 77),
      export_resolution: studioResolutionSelect?.value || studioState.exportResolution || "720p",
    };
  }

  function applyStudioPreferences(prefs) {
    if (!prefs || typeof prefs !== "object") return;
    if (prefs.default_voice && studioVoiceSelect) {
      const opt = Array.from(studioVoiceSelect.options).find((o) => o.value === prefs.default_voice);
      if (opt && !opt.disabled) studioVoiceSelect.value = prefs.default_voice;
    }
    if (prefs.voice_speed && studioVoiceSpeed) studioVoiceSpeed.value = prefs.voice_speed;
    if (prefs.target_duration && studioTargetDuration) studioTargetDuration.value = String(prefs.target_duration);
    if (prefs.sales_angle && studioSalesAngle) studioSalesAngle.value = prefs.sales_angle;

    if (typeof prefs.cut_pace_sec === "number") {
      studioState.cutPaceSec = prefs.cut_pace_sec;
      if (studioCutPaceSelect) studioCutPaceSelect.value = String(prefs.cut_pace_sec);
    }
    if (prefs.transition_mode) {
      studioState.transitionMode = prefs.transition_mode;
      if (studioTransitionSelect) studioTransitionSelect.value = prefs.transition_mode;
    }
    if (typeof prefs.is_original_audio_muted === "boolean") {
      studioState.isOriginalAudioMuted = prefs.is_original_audio_muted;
      updateOriginalAudioUI();
    }
    if (prefs.selected_template_id) {
      studioState.selectedTemplateId = prefs.selected_template_id;
    }
    if (typeof prefs.show_header === "boolean") {
      studioState.showHeader = prefs.show_header;
      if (studioToggleHeaderCheck) studioToggleHeaderCheck.checked = prefs.show_header;
    }
    if (typeof prefs.header_font_size === "number") {
      studioState.headerFontSize = prefs.header_font_size;
      if (studioHeaderSizeRange) studioHeaderSizeRange.value = String(prefs.header_font_size);
      if (studioHeaderSizeVal) studioHeaderSizeVal.textContent = String(prefs.header_font_size);
    }
    if (prefs.header_color) {
      studioState.headerColor = prefs.header_color;
      if (studioHeaderColor) studioHeaderColor.value = prefs.header_color;
    }
    if (prefs.header_stroke_color) {
      studioState.headerStrokeColor = prefs.header_stroke_color;
      if (studioHeaderStrokeColor) studioHeaderStrokeColor.value = prefs.header_stroke_color;
    }
    if (typeof prefs.header_stroke_width === "number") {
      studioState.headerStrokeWidth = prefs.header_stroke_width;
      if (studioHeaderStrokeRange) studioHeaderStrokeRange.value = String(prefs.header_stroke_width);
      if (studioHeaderStrokeVal) studioHeaderStrokeVal.textContent = String(prefs.header_stroke_width);
    }
    if (typeof prefs.header_pos_y === "number") {
      studioState.headerPosY = prefs.header_pos_y;
      const hPosR = document.getElementById("studioHeaderPosRange");
      const hPosV = document.getElementById("studioHeaderPosVal");
      if (hPosR) hPosR.value = String(prefs.header_pos_y);
      if (hPosV) hPosV.textContent = `${prefs.header_pos_y}%`;
    }
    if (typeof prefs.show_subtitles === "boolean") {
      studioState.showSubtitles = prefs.show_subtitles;
      if (studioToggleSubCheck) studioToggleSubCheck.checked = prefs.show_subtitles;
    }
    if (typeof prefs.sub_font_size === "number") {
      studioState.subFontSize = prefs.sub_font_size;
      if (studioSubSizeRange) studioSubSizeRange.value = String(prefs.sub_font_size);
      if (studioSubSizeVal) studioSubSizeVal.textContent = String(prefs.sub_font_size);
    }
    if (typeof prefs.sub_stroke_width === "number") {
      studioState.subStrokeWidth = prefs.sub_stroke_width;
      if (studioSubStrokeRange) studioSubStrokeRange.value = String(prefs.sub_stroke_width);
      if (studioSubStrokeVal) studioSubStrokeVal.textContent = String(prefs.sub_stroke_width);
    }
    if (typeof prefs.sub_show_bg === "boolean") {
      studioState.subShowBg = prefs.sub_show_bg;
      if (studioSubBgCheck) studioSubBgCheck.checked = prefs.sub_show_bg;
    }
    if (typeof prefs.sub_pos_y === "number") {
      studioState.subPosY = prefs.sub_pos_y;
      const sPosR = document.getElementById("studioSubPosRange");
      const sPosV = document.getElementById("studioSubPosVal");
      if (sPosR) sPosR.value = String(prefs.sub_pos_y);
      if (sPosV) sPosV.textContent = `${prefs.sub_pos_y}%`;
    }
    if (prefs.export_resolution) {
      studioState.exportResolution = prefs.export_resolution;
      if (studioResolutionSelect) studioResolutionSelect.value = prefs.export_resolution;
    }
    renderTemplateSelectorGrid();
    renderCurrentStudioFrame();
  }

  let _prefSaveTimer = null;
  function scheduleSaveStudioPreferences() {
    const prefs = collectStudioPreferences();
    try {
      localStorage.setItem("studio_preferences", JSON.stringify(prefs));
    } catch (_) {}
    clearTimeout(_prefSaveTimer);
    _prefSaveTimer = setTimeout(() => {
      fetch("/api/studio/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          preferences: prefs,
          default_voice: prefs.default_voice,
        }),
      }).catch(() => {});
    }, 250);
  }

  [
    studioVoiceSelect,
    studioVoiceSpeed,
    studioTargetDuration,
    studioSalesAngle,
    studioCutPaceSelect,
    studioTransitionSelect,
    studioResolutionSelect,
    studioToggleHeaderCheck,
    studioToggleSubCheck,
    studioHeaderSizeRange,
    studioHeaderColor,
    studioHeaderStrokeColor,
    studioHeaderStrokeRange,
    studioSubSizeRange,
    studioSubStrokeRange,
    studioSubBgCheck,
    document.getElementById("studioHeaderPosRange"),
    document.getElementById("studioSubPosRange"),
  ].forEach((el) => {
    el?.addEventListener("change", scheduleSaveStudioPreferences);
  });
  [
    studioToggleOriginalAudioBtn,
    studioMuteOriginalBtn,
    studioTemplateGrid,
    document.getElementById("studioPosPopup"),
  ].forEach((el) => {
    el?.addEventListener("click", () => setTimeout(scheduleSaveStudioPreferences, 30));
  });
  document.querySelectorAll(".hdr-color-preset, .hdr-stroke-preset").forEach((btn) => {
    btn.addEventListener("click", () => setTimeout(scheduleSaveStudioPreferences, 30));
  });

  renderTemplateSelectorGrid();
  updateClipsUI();
  buildRandomCutPlan();
  initStudioEvents();
  const studioConfigReady = loadStudioConfigFromServer().catch(() => {});
  window.StudioEngine.configReady = studioConfigReady;
  loadOutputDir();
  renderCurrentStudioFrame();
  requestAnimationFrame(runStudioPreviewLoop);
})();
