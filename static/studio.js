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

  const ZOOM_EFFECTS = ["zoomIn", "zoomOut", "panLeft", "panRight", "kenBurns"];
  const TRANSITION_POOL = ["cross-zoom", "whip-slide", "flash-pop"];

  // Thai Word Segmenter (Guarantees Thai words are NEVER broken in the middle!)
  const thaiWordSegmenter =
    typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
      ? new Intl.Segmenter("th", { granularity: "word" })
      : null;

  function segmentThaiWords(text) {
    const clean = String(text || "").replace(/\s+/g, " ").trim();
    if (!clean) return [];
    if (thaiWordSegmenter) {
      const tokens = [];
      for (const part of thaiWordSegmenter.segment(clean)) {
        tokens.push(part.segment);
      }
      return tokens;
    }
    return clean.split(" ");
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
      "position:fixed;left:-9999px;top:-9999px;width:320px;height:568px;overflow:hidden;opacity:0.01;pointer-events:none;z-index:-1;";
    document.body.appendChild(hiddenVideoPool);
  }

  const studioState = {
    activePage: "search", // 'search' | 'studio'
    clips: [], // { id, title, platform, url, blobUrl, thumb, thumbImg, videoEl, lastFrameCanvas, hasDecodedFrame, duration, sourceLabel, isCaching }
    cutSegments: [], // { index, start, duration, clipId, trimStart, zoomEffect, transition }
    selectedTemplateId: "slide-zoom",
    cutPaceSec: 2.0,
    transitionMode: "random",

    // Header Config (Strictly NO background box behind Header, large bold with thick stroke)
    headerText: "ของใช้ตรงปก หยิบใช้ง่ายสะดวก",
    headerFontSize: 80,
    headerColor: "#fde047",
    headerStrokeColor: "#000000",
    headerStrokeWidth: 20,

    // Subtitle Config
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
    subFontSize: 54,
    subStrokeWidth: 14,
    subShowBg: false,

    // Audio & Playback State
    totalDuration: 20.0,
    currentTime: 0.0,
    isPlaying: false,
    isVoiceMuted: false,
    isExporting: false,
    voiceAudio: null,
    voiceAudioDataUrl: "",
    voiceEngineLabel: "9:16 Full HD (1080×1920)",

    // Exported MP4
    lastExportedMp4Url: "",
    lastExportedMp4Blob: null,

    // API Keys
    geminiKeysText: "",
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
  const testApiKeyBtn = document.getElementById("testApiKeyBtn");
  const saveApiKeyBtn = document.getElementById("saveApiKeyBtn");
  const apiKeyStatusBox = document.getElementById("apiKeyStatusBox");
  const apiKeyStatusDot = document.getElementById("apiKeyStatusDot");

  const studioBackToSearchBtn = document.getElementById("studioBackToSearchBtn");
  const studioGoSearchClipsBtn = document.getElementById("studioGoSearchClipsBtn");
  const studioPcVideoInput = document.getElementById("studioPcVideoInput");
  const studioClipsList = document.getElementById("studioClipsList");
  const studioQueueCountText = document.getElementById("studioQueueCountText");
  const studioClearClipsBtn = document.getElementById("studioClearClipsBtn");
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

  const studioPreviewCanvas = document.getElementById("studioPreviewCanvas");
  const studioCanvasPlayOverlay = document.getElementById("studioCanvasPlayOverlay");
  const studioTimelineScrubber = document.getElementById("studioTimelineScrubber");
  const studioPlayPauseBtn = document.getElementById("studioPlayPauseBtn");
  const studioRestartBtn = document.getElementById("studioRestartBtn");
  const studioMuteVoiceBtn = document.getElementById("studioMuteVoiceBtn");
  const studioTimecodeText = document.getElementById("studioTimecodeText");
  const studioVoiceEngineBadge = document.getElementById("studioVoiceEngineBadge");
  const studioCutSummaryText = document.getElementById("studioCutSummaryText");
  const studioCutPreviewStrip = document.getElementById("studioCutPreviewStrip");

  const studioExportMp4Btn = document.getElementById("studioExportMp4Btn");
  const studioExportProgressWrap = document.getElementById("studioExportProgressWrap");
  const studioExportProgressText = document.getElementById("studioExportProgressText");
  const studioExportPctText = document.getElementById("studioExportPctText");
  const studioExportProgressBar = document.getElementById("studioExportProgressBar");

  const studioFinalMp4Card = document.getElementById("studioFinalMp4Card");
  const studioFinalVideoPlayer = document.getElementById("studioFinalVideoPlayer");
  const studioDownloadFinalMp4Btn = document.getElementById("studioDownloadFinalMp4Btn");

  function toast(msg, loading = false, dur = 3500) {
    if (typeof window.showToast === "function") {
      window.showToast(msg, loading, dur);
    }
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str || "";
    return div.innerHTML;
  }

  // ---------------------------------------------------------------------------
  // 1. PAGE SWITCHER (Page 1: Search <-> Page 2: AI Video Studio)
  // ---------------------------------------------------------------------------
  function switchAppPage(targetPage) {
    studioState.activePage = targetPage === "studio" ? "studio" : "search";
    const isStudio = studioState.activePage === "studio";

    if (pageSearchView) pageSearchView.classList.toggle("hidden", isStudio);
    if (pageStudioView) pageStudioView.classList.toggle("hidden", !isStudio);

    const activeCls =
      "px-4 py-2 rounded-xl text-xs sm:text-sm font-bold transition flex items-center gap-2 bg-gradient-to-r from-rose-500 via-indigo-500 to-sky-500 text-white shadow-md";
    const inactiveCls =
      "px-4 py-2 rounded-xl text-xs sm:text-sm font-bold transition flex items-center gap-2 text-slate-300 hover:text-white";

    if (navPage1Btn) navPage1Btn.className = isStudio ? inactiveCls : activeCls;
    if (navPage2Btn) navPage2Btn.className = isStudio ? activeCls : inactiveCls;

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
    const localKeys = localStorage.getItem("studio_gemini_api_keys") || "";
    if (localKeys) {
      studioState.geminiKeysText = localKeys;
      if (geminiApiKeysInput) geminiApiKeysInput.value = localKeys;
      updateApiKeyDot(localKeys);
    }
    try {
      const resp = await fetch("/api/studio/config");
      if (!resp.ok) return;
      const data = await resp.json();
      const serverKeys = (data.gemini_api_keys_text || "").trim();
      if (serverKeys) {
        studioState.geminiKeysText = serverKeys;
        if (geminiApiKeysInput) geminiApiKeysInput.value = serverKeys;
        localStorage.setItem("studio_gemini_api_keys", serverKeys);
        updateApiKeyDot(serverKeys);
      }
      if (data.default_voice && studioVoiceSelect) {
        studioVoiceSelect.value = data.default_voice;
      }
    } catch (_) {}
  }

  function updateApiKeyDot(keysText) {
    const hasKey = Boolean((keysText || "").trim());
    if (apiKeyStatusDot) {
      apiKeyStatusDot.className = hasKey
        ? "w-2 h-2 rounded-full bg-emerald-400 shadow shadow-emerald-400"
        : "w-2 h-2 rounded-full bg-slate-500";
    }
  }

  function openApiKeyModal() {
    if (apiKeyModal) apiKeyModal.classList.remove("hidden");
    if (apiKeyStatusBox) apiKeyStatusBox.classList.add("hidden");
  }

  function closeApiKeyModal() {
    if (apiKeyModal) apiKeyModal.classList.add("hidden");
  }

  async function saveApiKeys() {
    const raw = (geminiApiKeysInput?.value || "").trim();
    studioState.geminiKeysText = raw;
    localStorage.setItem("studio_gemini_api_keys", raw);
    updateApiKeyDot(raw);

    try {
      const resp = await fetch("/api/studio/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          gemini_api_keys: raw,
          default_voice: studioVoiceSelect?.value || "Puck",
        }),
      });
      const data = await resp.json();
      showApiKeyNotice(
        `บันทึก API Key สำเร็จ (${data.key_count || 0} คีย์ พร้อมสลับโควตาอัตโนมัติ)`,
        true
      );
      toast(`บันทึก Google AI API Key สำเร็จ (${data.key_count || 0} คีย์)`);
    } catch (err) {
      showApiKeyNotice(`บันทึกลงเบราว์เซอร์แล้ว (${err.message})`, true);
    }
  }

  async function testApiKeys() {
    const raw = (geminiApiKeysInput?.value || "").trim();
    showApiKeyNotice("กำลังทดสอบการเชื่อมต่อกับ Google Gemini AI...", true);
    try {
      const resp = await fetch("/api/studio/test-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: raw }),
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
    frameCanvas.width = 540;
    frameCanvas.height = 960;
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
      if (vid.readyState >= 2 && vid.videoWidth > 0) {
        clip.lastFrameCanvas.width = vid.videoWidth;
        clip.lastFrameCanvas.height = vid.videoHeight;
        const fctx = clip.lastFrameCanvas.getContext("2d");
        if (fctx) {
          try {
            fctx.drawImage(vid, 0, 0, vid.videoWidth, vid.videoHeight);
            clip.hasDecodedFrame = true;
          } catch (_) {}
        }
        renderCurrentStudioFrame();
      }
    };

    vid.addEventListener("loadedmetadata", () => {
      if (Number.isFinite(vid.duration) && vid.duration > 1) {
        clip.duration = vid.duration;
        buildRandomCutPlan();
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
      updateClipsUI();
      fetch(clip.url)
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.blob();
        })
        .then((blob) => {
          if (blob && blob.size > 10000) {
            const localBlobUrl = URL.createObjectURL(blob);
            clip.blobUrl = localBlobUrl;
            clip.isCaching = false;
            const curT = vid.currentTime || 0;
            vid.src = localBlobUrl;
            vid.load();
            vid.currentTime = curT;
            if (studioState.isPlaying && studioState.activePage === "studio") {
              vid.play().catch(() => {});
            }
            updateClipsUI();
            renderCurrentStudioFrame();
          }
        })
        .catch(() => {
          clip.isCaching = false;
          updateClipsUI();
        });
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
    const cacheClipUrl = `/api/studio/clip-file?platform=${encodeURIComponent(item.platform)}&id=${encodeURIComponent(item.id)}&direct_url=${encodeURIComponent(item.direct_video_url || "")}`;
    const thumbUrl = item.cover ? `/api/proxy-image?url=${encodeURIComponent(item.cover)}` : "";

    const newClip = {
      id: clipKey,
      title: item.title || `คลิปจาก ${item.platform}`,
      platform: item.platform,
      sourceLabel: item.platform === "douyin" ? "🎵 Douyin" : "📺 Bilibili",
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

  function updateClipsUI() {
    const count = studioState.clips.length;
    if (studioClipCountBadge) studioClipCountBadge.textContent = `${count} คลิป`;
    if (studioQueueCountText) studioQueueCountText.textContent = String(count);
    if (studioClearClipsBtn) studioClearClipsBtn.classList.toggle("hidden", count === 0);

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
      <div class="flex items-center justify-between gap-2.5 p-2.5 rounded-xl bg-slate-950 border border-slate-800">
        <div class="flex items-center gap-2.5 min-w-0">
          <div class="w-12 h-12 rounded-lg bg-slate-900 border border-slate-800 overflow-hidden shrink-0 flex items-center justify-center text-xs font-bold text-fuchsia-400">
            ${
              clip.thumb
                ? `<img src="${clip.thumb}" class="w-full h-full object-cover" alt="" />`
                : `<span>#${i + 1}</span>`
            }
          </div>
          <div class="min-w-0">
            <div class="flex items-center gap-1.5 flex-wrap">
              <span class="px-1.5 py-0.5 rounded bg-slate-800 text-[10px] font-bold text-slate-300">${escapeHtml(clip.sourceLabel)}</span>
              <span class="text-[10px] text-emerald-400 font-semibold">🔇 ปิดเสียงแล้ว</span>
              ${
                clip.isCaching
                  ? `<span class="text-[10px] text-amber-300 animate-pulse">⏳ กำลังซิงค์ลงพรีวิว...</span>`
                  : `<span class="text-[10px] text-sky-400 font-semibold">✓ พร้อมตัดสลับ</span>`
              }
            </div>
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
  function buildRandomCutPlan() {
    const totalDur = Math.max(4, Number(studioState.totalDuration) || 20);
    const basePace = Math.max(1.2, Number(studioCutPaceSelect?.value || studioState.cutPaceSec || 2.0));
    studioState.cutPaceSec = basePace;
    studioState.transitionMode = studioTransitionSelect?.value || "random";

    const clips = studioState.clips;
    const rawSlices = [];

    if (clips.length > 0) {
      clips.forEach((clip, cIdx) => {
        const vidDur = Math.max(4, Number(clip.duration) || 12);
        const usableStart = vidDur > 3 ? 0.3 : 0;
        const usableEnd = Math.max(usableStart + basePace, vidDur - 0.5);
        let cursor = usableStart;
        while (cursor < usableEnd) {
          rawSlices.push({
            clipId: clip.id,
            clipIndex: cIdx + 1,
            trimStart: Number(cursor.toFixed(2)),
          });
          cursor += basePace * 0.85;
        }
      });

      // Fisher-Yates random shuffle
      for (let i = rawSlices.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = rawSlices[i];
        rawSlices[i] = rawSlices[j];
        rawSlices[j] = tmp;
      }
    }

    const segments = [];
    let t = 0;
    let idx = 0;

    while (t < totalDur - 0.15) {
      const jitter = 0.9 + Math.random() * 0.2;
      let segDur = Number((basePace * jitter).toFixed(2));
      if (t + segDur > totalDur - 0.4) {
        segDur = Number((totalDur - t).toFixed(2));
      }

      const slice =
        rawSlices.length > 0
          ? { ...rawSlices[idx % rawSlices.length] }
          : { clipId: null, clipIndex: 0, trimStart: 0 };

      if (
        segments.length > 0 &&
        rawSlices.length > 1 &&
        slice.clipId === segments[segments.length - 1].clipId &&
        Math.abs(slice.trimStart - segments[segments.length - 1].trimStart) < 1.0
      ) {
        const alt = rawSlices[(idx + 1) % rawSlices.length];
        if (alt) {
          slice.clipId = alt.clipId;
          slice.clipIndex = alt.clipIndex;
          slice.trimStart = alt.trimStart;
        }
      }

      const zoom = ZOOM_EFFECTS[Math.floor(Math.random() * ZOOM_EFFECTS.length)];
      let trans = "none";
      if (idx > 0) {
        if (studioState.transitionMode === "random") {
          trans = TRANSITION_POOL[Math.floor(Math.random() * TRANSITION_POOL.length)];
        } else {
          trans = studioState.transitionMode;
        }
      }

      segments.push({
        index: idx,
        start: Number(t.toFixed(2)),
        duration: segDur,
        clipId: slice.clipId,
        clipIndex: slice.clipIndex,
        trimStart: slice.trimStart,
        zoomEffect: zoom,
        transition: trans,
      });

      t = Number((t + segDur).toFixed(2));
      idx++;
    }

    studioState.cutSegments = segments;
    renderCutPreviewStrip();
  }

  function renderCutPreviewStrip() {
    if (!studioCutPreviewStrip) return;
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
        class="shrink-0 px-2 py-1 rounded-lg bg-slate-950 hover:bg-slate-800 border border-slate-800 text-slate-300 font-mono transition"
        title="คลิกเพื่อดูพรีวิวฉากที่ ${s.index + 1}"
      >
        ✂️ ฉาก ${s.index + 1} ${s.clipIndex ? `(คลิป#${s.clipIndex} @${s.trimStart.toFixed(1)}s)` : `(${s.start.toFixed(1)}s)`}
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

  function syncShopeeProduct(product, silent = false) {
    if (!product) return;
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
        ? "กำลังให้ Google AI คิดบท + สร้าง Header + พากย์เสียง..."
        : "กำลังพากย์เสียงและซิงค์ซับไตเติ้ลใหม่...";
    }
    toast("กำลังสร้างบทพากย์ เสียงพากย์ไทย และซับไตเติ้ล...", true, 0);

    try {
      const selectedOpt = studioVoiceSelect?.selectedOptions?.[0];
      const voiceGender = selectedOpt?.getAttribute("data-gender") || "Male";

      const resp = await fetch("/api/studio/generate-all", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          product_title: title,
          product_description: desc,
          target_duration: Number(studioTargetDuration?.value || 20),
          sales_angle: studioSalesAngle?.value || "podcast_ad",
          custom_header: rewriteScript ? "" : studioHeaderInput?.value || "",
          custom_script: rewriteScript ? "" : customScript,
          voice_name: studioVoiceSelect?.value || "Puck",
          voice_gender: voiceGender,
          speed_rate: studioVoiceSpeed?.value || "+15%",
          api_key: studioState.geminiKeysText || "",
          rewrite_script: rewriteScript,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        throw new Error(data.detail || "สร้างบทและเสียงพากย์ไม่สำเร็จ");
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
        studioState.selectedTemplateId = btn.getAttribute("data-tpl-id") || "slide-zoom";
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
      if (vid && vid.readyState >= 2 && vid.videoWidth > 0) {
        drawableSource = vid;
        srcW = vid.videoWidth;
        srcH = vid.videoHeight;
        // Update frame cache so if next frame seeks, we still have a crisp frame!
        // Throttled: copying a full-res frame every tick is expensive and causes dropped frames.
        const nowMs = performance.now();
        if (clipObj.lastFrameCanvas && (!clipObj.hasDecodedFrame || nowMs - (clipObj.lastCacheTs || 0) > 250)) {
          clipObj.lastCacheTs = nowMs;
          if (clipObj.lastFrameCanvas.width !== srcW || clipObj.lastFrameCanvas.height !== srcH) {
            clipObj.lastFrameCanvas.width = srcW;
            clipObj.lastFrameCanvas.height = srcH;
          }
          const fctx = clipObj.lastFrameCanvas.getContext("2d");
          if (fctx) {
            try {
              fctx.drawImage(vid, 0, 0, srcW, srcH);
              clipObj.hasDecodedFrame = true;
            } catch (_) {}
          }
        }
      } else if (clipObj.hasDecodedFrame && clipObj.lastFrameCanvas) {
        drawableSource = clipObj.lastFrameCanvas;
        srcW = clipObj.lastFrameCanvas.width || 540;
        srcH = clipObj.lastFrameCanvas.height || 960;
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

      let zoom = 1.05;
      let panX = 0;
      let panY = 0;
      const zType = activeSeg?.zoomEffect || "zoomIn";
      if (zType === "zoomIn") zoom = 1.02 + 0.14 * prog;
      else if (zType === "zoomOut") zoom = 1.16 - 0.14 * prog;
      else if (zType === "panLeft") {
        zoom = 1.12;
        panX = (0.5 - prog) * 55;
      } else if (zType === "panRight") {
        zoom = 1.12;
        panX = (prog - 0.5) * 55;
      } else if (zType === "kenBurns") {
        zoom = 1.04 + 0.12 * prog;
        panX = (0.5 - prog) * 40;
        panY = (0.5 - prog) * 30;
      }

      const transDur = 0.26;
      let slideOffsetX = 0;
      let flashAlpha = 0;
      if (activeSeg && activeSeg.index > 0 && localT < transDur) {
        const tp = localT / transDur;
        if (activeSeg.transition === "whip-slide") {
          slideOffsetX = (1 - tp) * vw * (activeSeg.index % 2 === 0 ? 1 : -1);
        } else if (activeSeg.transition === "cross-zoom") {
          zoom *= 1.16 - 0.16 * tp;
        } else if (activeSeg.transition === "flash-pop") {
          flashAlpha = (1 - tp) * 0.55;
        }
      }

      const scale = Math.max(vw / srcW, vh / srcH) * zoom;
      const drawW = srcW * scale;
      const drawH = srcH * scale;
      const drawX = vx + (vw - drawW) / 2 + panX + slideOffsetX;
      const drawY = vy + (vh - drawH) / 2 + panY;

      try {
        ctx.drawImage(drawableSource, drawX, drawY, drawW, drawH);
      } catch (_) {}

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
  function drawProminentStrokedHeader(ctx, w, h, timeSec) {
    const rawHeader = (studioState.headerText || "").trim();
    if (!rawHeader) return;

    let fontSize = Number(studioState.headerFontSize) || 80;
    const strokeWidth = Number(studioState.headerStrokeWidth) || 20;
    const fillColor = studioState.headerColor || "#fde047";
    const strokeColor = studioState.headerStrokeColor || "#000000";

    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    const maxW = w * 0.88;
    ctx.font = `900 ${fontSize}px "Kanit", "IBM Plex Sans Thai", sans-serif`;

    // Wrap ONLY on complete Thai word boundaries
    let lines = wrapThaiTextByWords(ctx, rawHeader, maxW, 2);

    // Auto-scale font size down slightly if any line still exceeds maxW
    while (
      fontSize > 42 &&
      lines.some((line) => ctx.measureText(line).width > maxW)
    ) {
      fontSize -= 2;
      ctx.font = `900 ${fontSize}px "Kanit", "IBM Plex Sans Thai", sans-serif`;
      lines = wrapThaiTextByWords(ctx, rawHeader, maxW, 2);
    }

    const popScale = 1 + Math.sin(timeSec * 3.5) * 0.015;
    const centerX = w / 2;
    const centerY = h * 0.135;
    const lineHeight = fontSize * 1.22;

    ctx.translate(centerX, centerY);
    ctx.scale(popScale, popScale);

    lines.forEach((line, idx) => {
      const ly = (idx - (lines.length - 1) / 2) * lineHeight;

      if (strokeWidth > 0) {
        ctx.save();
        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = strokeWidth;
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        ctx.miterLimit = 2;
        ctx.shadowColor = "rgba(0, 0, 0, 0.85)";
        ctx.shadowBlur = 18;
        ctx.shadowOffsetY = 6;
        ctx.strokeText(line, 0, ly);
        ctx.restore();
      }

      ctx.fillStyle = fillColor;
      ctx.fillText(line, 0, ly);
    });

    ctx.restore();
  }

  /**
   * Draw Synchronized 2-Line Voiceover Subtitles (Word-safe + Auto-fit)
   */
  function drawSynchronizedSubtitle(ctx, w, h, timeSec, tpl) {
    const activeScene = getActiveSubtitleScene(timeSec);
    if (!activeScene) return;

    let fontSize = Number(studioState.subFontSize) || 54;
    const strokeWidth = Number(studioState.subStrokeWidth) || 14;
    const showBg = Boolean(studioState.subShowBg);
    const maxW = w * 0.88;

    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `800 ${fontSize}px "Kanit", "IBM Plex Sans Thai", sans-serif`;

    // Prefer full_narration wrapped cleanly by whole Thai words so words never break across lines
    const fullText = (
      activeScene.full_narration ||
      `${activeScene.line_top || ""} ${activeScene.line_bottom || ""}`
    ).trim();
    if (!fullText) {
      ctx.restore();
      return;
    }

    let lines = wrapThaiTextByWords(ctx, fullText, maxW, 2);

    while (
      fontSize > 34 &&
      lines.some((line) => ctx.measureText(line).width > maxW)
    ) {
      fontSize -= 2;
      ctx.font = `800 ${fontSize}px "Kanit", "IBM Plex Sans Thai", sans-serif`;
      lines = wrapThaiTextByWords(ctx, fullText, maxW, 2);
    }

    const localT = Math.max(0, timeSec - (activeScene.start || 0));
    const entryP = Math.min(1, localT / 0.14);
    const scale = 0.9 + 0.1 * entryP;

    const centerX = w / 2;
    const centerY = h * 0.77;
    const lineHeight = fontSize * 1.28;

    ctx.translate(centerX, centerY);
    ctx.scale(scale, scale);

    if (showBg) {
      const maxLineW = Math.max(...lines.map((l) => ctx.measureText(l).width));
      const boxW = maxLineW + 64;
      const boxH = lines.length * lineHeight + 36;
      ctx.fillStyle = "rgba(9, 13, 22, 0.82)";
      ctx.strokeStyle = tpl.accentColor || "#fde047";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.roundRect(-boxW / 2, -boxH / 2, boxW, boxH, 24);
      ctx.fill();
      ctx.stroke();
    }

    lines.forEach((line, idx) => {
      const ly = (idx - (lines.length - 1) / 2) * lineHeight;

      if (strokeWidth > 0) {
        ctx.save();
        ctx.strokeStyle = "#000000";
        ctx.lineWidth = strokeWidth;
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        ctx.miterLimit = 2;
        ctx.shadowColor = "rgba(0,0,0,0.75)";
        ctx.shadowBlur = 12;
        ctx.shadowOffsetY = 4;
        ctx.strokeText(line, 0, ly);
        ctx.restore();
      }

      ctx.fillStyle = idx === 0 ? "#ffffff" : tpl.accentColor || "#fde047";
      ctx.fillText(line, 0, ly);
    });

    ctx.restore();
  }

  function renderStudioFrameAt(ctx, w, h, timeSec) {
    const tpl = getActiveTemplate();
    drawVideoLayer(ctx, w, h, timeSec, tpl);
    drawTemplateDecorations(ctx, w, h, timeSec, tpl);
    drawProminentStrokedHeader(ctx, w, h, timeSec);
    drawSynchronizedSubtitle(ctx, w, h, timeSec, tpl);
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
        const dur = Math.max(1, Number.isFinite(vid.duration) && vid.duration > 0 ? vid.duration : 10);
        const targetTime = ((activeSeg.trimStart || 0) + Math.max(0, timeSec - activeSeg.start)) % dur;

        if (shouldPlay) {
          if (!vid.seeking && Math.abs(vid.currentTime - targetTime) > 0.7) {
            try {
              vid.currentTime = targetTime;
            } catch (_) {}
          }
          if (vid.paused && vid.readyState >= 2) {
            vid.play().catch(() => {});
          }
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
    if (!studioPreviewCanvas) return;
    const ctx = studioPreviewCanvas.getContext("2d");
    if (!ctx) return;

    syncActiveClipVideoElement(
      studioState.currentTime,
      studioState.isPlaying && studioState.activePage === "studio" && !studioState.isExporting
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

    if (studioState.activePage === "studio" && !studioState.isExporting && studioState.isPlaying) {
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

  async function exportStudioVideoToMp4() {
    if (studioState.isExporting) return;
    pauseStudioPreview();
    studioState.isExporting = true;

    if (studioExportMp4Btn) studioExportMp4Btn.disabled = true;
    if (studioExportProgressWrap) studioExportProgressWrap.classList.remove("hidden");
    if (studioExportProgressBar) studioExportProgressBar.style.width = "0%";
    if (studioExportPctText) studioExportPctText.textContent = "0%";
    if (studioExportProgressText) studioExportProgressText.textContent = "กำลังเรนเดอร์ภาพและเสียงพากย์...";

    try {
      const fps = 30;
      const width = 720;
      const height = 1280;
      const targetDur = Math.max(3, Number(studioState.totalDuration) || 20);

      const offCanvas = document.createElement("canvas");
      offCanvas.width = width;
      offCanvas.height = height;
      const ctx = offCanvas.getContext("2d", { alpha: false });

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

      // H.264 first (usually hardware-encoded = far less CPU, fewer dropped frames); VP9 is the slowest.
      const mimeCandidates = [
        "video/mp4;codecs=avc1.42E01F,mp4a.40.2",
        "video/webm;codecs=h264,opus",
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
        videoBitsPerSecond: 5_000_000,
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
      // Clock = audio clock when available, so picture and voice can't drift apart
      const audioStartAt = audioCtx ? audioCtx.currentTime + 0.05 : 0;
      if (audioSource) audioSource.start(audioStartAt);
      const startTs = performance.now() + (audioCtx ? 50 : 0);
      const clockNow = () =>
        audioCtx ? audioCtx.currentTime - audioStartAt : (performance.now() - startTs) / 1000;

      const frameInterval = 1 / fps;
      let lastFrameT = -1;
      let lastUiTs = 0;

      await new Promise((resolve) => {
        const tick = () => {
          const elapsed = clockNow();
          if (elapsed >= targetDur) {
            resolve();
            return;
          }

          if (elapsed >= 0 && elapsed - lastFrameT >= frameInterval * 0.9) {
            lastFrameT = elapsed;
            syncActiveClipVideoElement(elapsed, true);
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
            const pct = Math.min(95, Math.round((shown / targetDur) * 90));
            if (studioExportProgressBar) studioExportProgressBar.style.width = `${pct}%`;
            if (studioExportPctText) studioExportPctText.textContent = `${pct}%`;
            if (studioExportProgressText) {
              studioExportProgressText.textContent = `กำลังบันทึกวิดีโอ ${shown.toFixed(1)}s / ${targetDur.toFixed(1)}s... (อย่าสลับแท็บระหว่างเรนเดอร์)`;
            }
          }

          // rAF = smooth & vsync-aligned; if the tab is hidden rAF stops, so fall back to a timer
          if (document.hidden) setTimeout(tick, 1000 / fps / 2);
          else requestAnimationFrame(tick);
        };
        tick();
      });

      studioState.clips.forEach((c) => {
        if (c.videoEl && !c.videoEl.paused) c.videoEl.pause();
      });

      recorder.stop();
      const recordedBlob = await stopPromise;

      if (studioExportProgressBar) studioExportProgressBar.style.width = "95%";
      if (studioExportPctText) studioExportPctText.textContent = "95%";
      if (studioExportProgressText) {
        studioExportProgressText.textContent = "กำลังแปลงเป็นไฟล์ .MP4 (H.264 + AAC)...";
      }

      let mp4Blob = null;

      // 1. Primary: Direct binary stream upload via FormData (avoids 30MB base64 memory overhead)
      try {
        const formData = new FormData();
        formData.append("file", recordedBlob, "recording.webm");
        formData.append("fps", String(fps));

        const convResp = await fetch("/api/studio/convert-mp4-file", {
          method: "POST",
          body: formData,
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
          console.warn("[Studio] Binary convert failed, trying JSON fallback:", errDetail);
        }
      } catch (uploadErr) {
        console.warn("[Studio] Binary upload error:", uploadErr);
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
            console.warn("[Studio] Base64 convert also failed:", errDetail);
          }
        } catch (jsonErr) {
          console.warn("[Studio] Base64 convert exception:", jsonErr);
        }
      }

      // 3. Ultimate Fallback: If backend FFmpeg fails, do NOT lose user's work!
      // Provide the recorded video blob directly so user can preview and download immediately.
      if (!mp4Blob) {
        mp4Blob = recordedBlob;
        toast("ระบบบันทึกไฟล์วิดีโอต้นฉบับให้เรียบร้อย สามารถเปิดดูและดาวน์โหลดได้ทันที", false, 4500);
      }
      if (studioState.lastExportedMp4Url) {
        URL.revokeObjectURL(studioState.lastExportedMp4Url);
      }
      const mp4Url = URL.createObjectURL(mp4Blob);
      studioState.lastExportedMp4Blob = mp4Blob;
      studioState.lastExportedMp4Url = mp4Url;

      if (studioExportProgressBar) studioExportProgressBar.style.width = "100%";
      if (studioExportPctText) studioExportPctText.textContent = "100%";
      if (studioExportProgressText) {
        studioExportProgressText.textContent = "เรนเดอร์ไฟล์ .MP4 เสร็จสมบูรณ์!";
      }

      if (studioFinalMp4Card) studioFinalMp4Card.classList.remove("hidden");
      if (studioFinalVideoPlayer) {
        studioFinalVideoPlayer.src = mp4Url;
        studioFinalVideoPlayer.load();
        studioFinalVideoPlayer.play().catch(() => {});
      }
      studioFinalMp4Card?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      toast("🎬 สร้างไฟล์วิดีโอ .MP4 เสร็จสมบูรณ์! ดูพรีวิวและกดดาวน์โหลดได้เลย", false, 4500);
    } catch (err) {
      toast(`เรนเดอร์วิดีโอไม่สำเร็จ: ${err.message}`, false, 4500);
    } finally {
      studioState.isExporting = false;
      if (studioExportMp4Btn) studioExportMp4Btn.disabled = false;
    }
  }

  function downloadExportedMp4() {
    if (!studioState.lastExportedMp4Url) return;
    const a = document.createElement("a");
    a.href = studioState.lastExportedMp4Url;
    const cleanName = (studioState.headerText || "ai-review-video")
      .replace(/[\\/:*?"<>|]+/g, "")
      .trim()
      .slice(0, 40);
    a.download = `${cleanName || "ai-review-video"}.mp4`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  // ---------------------------------------------------------------------------
  // 9. EVENT LISTENERS & INITIALIZATION
  // ---------------------------------------------------------------------------
  function initStudioEvents() {
    navPage1Btn?.addEventListener("click", () => switchAppPage("search"));
    navPage2Btn?.addEventListener("click", () => switchAppPage("studio"));
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
    studioClearClipsBtn?.addEventListener("click", clearAllStudioClips);
    studioCutPaceSelect?.addEventListener("change", () => {
      buildRandomCutPlan();
      renderCurrentStudioFrame();
    });
    studioTransitionSelect?.addEventListener("change", () => {
      buildRandomCutPlan();
      renderCurrentStudioFrame();
    });
    studioReshuffleBtn?.addEventListener("click", () => {
      buildRandomCutPlan();
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
    studioHeaderSizeRange?.addEventListener("input", () => {
      studioState.headerFontSize = Number(studioHeaderSizeRange.value);
      if (studioHeaderSizeVal) studioHeaderSizeVal.textContent = studioHeaderSizeRange.value;
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

    // Export MP4 & Download
    studioExportMp4Btn?.addEventListener("click", exportStudioVideoToMp4);
    studioDownloadFinalMp4Btn?.addEventListener("click", downloadExportedMp4);
  }

  // Expose Studio API to Page 1
  window.StudioApp = {
    addClipFromPage1,
    syncShopeeProduct,
    switchAppPage,
  };

  // Boot
  renderTemplateSelectorGrid();
  updateClipsUI();
  buildRandomCutPlan();
  initStudioEvents();
  loadStudioConfigFromServer();
  renderCurrentStudioFrame();
  requestAnimationFrame(runStudioPreviewLoop);
})();
