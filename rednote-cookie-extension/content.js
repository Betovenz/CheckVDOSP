// RedNote Helper & Video Downloader - Content Script v1.3.0
(() => {
  "use strict";

  if (window.__REDNOTE_HELPER_LOADED__) return;
  window.__REDNOTE_HELPER_LOADED__ = true;

  // In-memory media cache populated by injected.js (MAIN world) and runtime queries
  const capturedMediaMap = {};

  // Listen for captured media items from injected.js
  window.addEventListener("message", (event) => {
    if (event.data && event.data.type === "__RH_MEDIA_CAPTURED__") {
      const item = event.data.item;
      if (item && item.noteId) {
        capturedMediaMap[item.noteId.toLowerCase()] = item;
      }
    }
  });

  const SVG_DOWNLOAD = `<svg viewBox="0 0 24 24"><path d="M12 15.5l-5-5h3V4h4v6.5h3l-5 5zm7 2.5H5v-2H3v3a1 1 0 001 1h16a1 1 0 001-1v-3h-2v2z"/></svg>`;
  const SVG_HUB = `<svg viewBox="0 0 24 24"><path d="M13.13 2.19l-9 9a1 1 0 00-.24.37L2.05 18a1 1 0 001.21 1.21l6.44-1.84a1 1 0 00.37-.24l9-9a1 1 0 000-1.41l-4.52-4.53a1 1 0 00-1.42 0zM5.41 16.59l.71-2.47 1.76 1.76-2.47.71zM14.54 9.46l-6.36 6.36-1.42-1.41 6.37-6.37 1.41 1.42zm2.12-2.12l-1.41-1.42 1.41-1.41 1.42 1.41-1.42 1.42z"/></svg>`;
  const SVG_COPY = `<svg viewBox="0 0 24 24"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>`;

  function showToast(message, type = "info") {
    const existing = document.querySelector(".rh-toast");
    if (existing) existing.remove();

    const toast = document.createElement("div");
    toast.className = `rh-toast ${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = "0";
      toast.style.transition = "opacity 0.3s ease";
      setTimeout(() => toast.remove(), 300);
    }, 2800);
  }

  // Extract Note ID from link URL or string
  function extractNoteId(url) {
    if (!url) return null;
    const m = url.match(/[0-9a-f]{24}/i);
    return m ? m[0].toLowerCase() : null;
  }

  // Helper: query local Hub server to resolve note
  function queryHubResolve(url) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { action: "resolve_via_hub", url: url },
        (resp) => {
          if (resp && resp.success && resp.videoUrl) {
            resolve({
              type: "video",
              title: resp.title || "RedNote_Video",
              videoUrl: resp.videoUrl,
              fromHub: true
            });
          } else {
            resolve(null);
          }
        }
      );
    });
  }

  // Resolve video or image media for a note
  async function resolveMedia(cardUrl, noteId, cardEl) {
    noteId = (noteId || "").toLowerCase();

    // 1. Check in-memory captured cache (captured by injected.js from RedNote API)
    if (noteId && capturedMediaMap[noteId]) {
      const cached = capturedMediaMap[noteId];
      if (cached.videoUrl || (cached.images && cached.images.length)) {
        return cached;
      }
    }

    // 2. Check if a <video> element exists in this card or active modal player
    const modalVideo = document.querySelector(".media-container video, .note-detail-mask video, .note-container video");
    const cardVideo = cardEl?.querySelector("video");
    const activeVideo = cardVideo || modalVideo;
    if (activeVideo) {
      const src = activeVideo.currentSrc || activeVideo.src || "";
      if (src && src.startsWith("http") && !src.startsWith("blob:")) {
        const title = cardEl?.querySelector(".title")?.innerText?.trim() || `RedNote_${noteId}`;
        const item = {
          noteId: noteId,
          type: "video",
          title: title.slice(0, 70),
          videoUrl: src,
        };
        capturedMediaMap[noteId] = item;
        return item;
      }
    }

    // 3. Query local Hub server if running (Hub uses yt-dlp + headless browser, resolves in ~3s)
    const hubMedia = await queryHubResolve(cardUrl);
    if (hubMedia && hubMedia.videoUrl) {
      capturedMediaMap[noteId] = hubMedia;
      return hubMedia;
    }

    // 4. Try opening the note in modal (click card) so RedNote loads the note via its signed API
    if (cardEl && !document.querySelector(".note-detail-mask, .media-container")) {
      const clickable = cardEl.querySelector("a, .cover, img") || cardEl;
      if (clickable) {
        clickable.click();
        // Wait up to 1.5s for video element or API capture
        for (let i = 0; i < 8; i++) {
          await new Promise((r) => setTimeout(r, 200));
          if (capturedMediaMap[noteId]?.videoUrl) {
            return capturedMediaMap[noteId];
          }
          const v = document.querySelector(".media-container video, .note-detail-mask video");
          if (v && v.src && v.src.startsWith("http") && !v.src.startsWith("blob:")) {
            const item = {
              noteId: noteId,
              type: "video",
              title: cardEl?.querySelector(".title")?.innerText?.trim() || `RedNote_${noteId}`,
              videoUrl: v.src,
            };
            capturedMediaMap[noteId] = item;
            return item;
          }
        }
      }
    }

    // 5. Fallback: ask background to fetch note HTML
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: "fetch_note_html", url: cardUrl }, (resp) => {
        if (resp && resp.success && resp.html) {
          const m = resp.html.match(/https?:\/\/[a-zA-Z0-9\.\-_]+\.rednotecdn\.com\/stream\/[^\s"']+\.mp4/i) ||
                    resp.html.match(/https?:\/\/sns-video-bd\.xhscdn\.com\/[^\s"']+/i);
          if (m) {
            resolve({
              type: "video",
              title: `RedNote_${noteId}`,
              videoUrl: m[0],
            });
            return;
          }
        }
        resolve(null);
      });
    });
  }

  // Trigger Download
  async function triggerDownload(cardUrl, noteId, cardEl, btnTextEl) {
    if (btnTextEl) btnTextEl.innerHTML = `<span class="rh-spinner"></span> ดึงคลิป...`;
    showToast("⏳ กำลังดึงข้อมูลวิดีโอ...", "info");

    const media = await resolveMedia(cardUrl, noteId, cardEl);
    if (!media) {
      showToast("❌ ดึงวิดีโอไม่สำเร็จ (เปิดดูคลิปก่อน 1 ครั้ง หรือเปิดโปรแกรม Hub ไว้)", "error");
      if (btnTextEl) btnTextEl.textContent = "ดาวน์โหลด";
      return;
    }

    if (media.type === "video" && media.videoUrl) {
      chrome.runtime.sendMessage(
        {
          action: "download_video",
          url: media.videoUrl,
          title: media.title,
        },
        (resp) => {
          if (resp && resp.success) {
            showToast(`✅ เริ่มดาวน์โหลด: ${resp.filename}`, "success");
            if (btnTextEl) btnTextEl.textContent = "✓ กำลังโหลด";
            setTimeout(() => {
              if (btnTextEl) btnTextEl.textContent = "ดาวน์โหลด";
            }, 3000);
          } else {
            showToast("❌ ดาวน์โหลดล้มเหลว: " + (resp?.error || "Unknown"), "error");
            if (btnTextEl) btnTextEl.textContent = "ดาวน์โหลด";
          }
        }
      );
    } else if (media.type === "image" && media.images?.length) {
      showToast(`📸 โน้ตนี้เป็นรูปภาพ (${media.images.length} รูป) กำลังดาวน์โหลด...`, "info");
      media.images.forEach((imgUrl, idx) => {
        chrome.runtime.sendMessage({
          action: "download_image",
          url: imgUrl,
          filename: `${media.title}_${idx + 1}.jpg`,
        });
      });
      if (btnTextEl) btnTextEl.textContent = "✓ โหลดรูปแล้ว";
      setTimeout(() => {
        if (btnTextEl) btnTextEl.textContent = "ดาวน์โหลด";
      }, 3000);
    } else {
      showToast("❌ ไม่พบลิงก์วิดีโอในโน้ตนี้", "error");
      if (btnTextEl) btnTextEl.textContent = "ดาวน์โหลด";
    }
  }

  // Send to Hub (localhost:8000) Action
  function triggerSendToHub(cardUrl) {
    showToast("🚀 กำลังส่งเข้า Douyin & Bilibili Hub...", "info");
    chrome.runtime.sendMessage({ action: "send_to_hub", url: cardUrl }, (resp) => {
      if (resp && resp.success) {
        showToast("✅ ส่งเข้า Hub สำเร็จ! เปิดหน้าเว็บ Hub เพื่อใช้งานได้เลย", "success");
      } else {
        showToast("⚠️ ไม่สามารถส่งเข้า Hub ได้: " + (resp?.error || "กรุณาเปิดโปรแกรม Hub (localhost:8000) ก่อน"), "error");
      }
    });
  }

  // Copy Direct Video URL
  async function triggerCopyDirectUrl(cardUrl, noteId, cardEl) {
    showToast("⏳ กำลังดึงลิงก์วิดีโอตรง...", "info");
    const media = await resolveMedia(cardUrl, noteId, cardEl);
    if (media && media.videoUrl) {
      navigator.clipboard.writeText(media.videoUrl).then(() => {
        showToast("📋 คัดลอกลิงก์ตรง (MP4 URL) เรียบร้อยแล้ว!", "success");
      });
    } else {
      showToast("❌ ไม่พบลิงก์วิดีโอตรง", "error");
    }
  }

  // Attach download badge & popup to a video card
  function processCard(card) {
    if (card.hasAttribute("data-rh-ready")) return;

    // Find note link inside card
    const linkEl =
      card.tagName === "A"
        ? card
        : card.querySelector('a[href*="/explore/"], a[href*="/search_result/"], a[href*="/discovery/item/"]');
    if (!linkEl) return;

    const href = linkEl.getAttribute("href") || "";
    const noteId = extractNoteId(href);
    if (!noteId) return;

    const fullUrl = href.startsWith("http") ? href : `${window.location.origin}${href}`;

    // Target container to append badge into (prefer .cover if exists)
    const container = card.querySelector(".cover, [class*='cover']") || card;
    card.setAttribute("data-rh-ready", "true");

    // Create Badge Element
    const wrap = document.createElement("div");
    wrap.className = "rh-card-badge-wrap";
    wrap.innerHTML = `
      <div class="rh-dl-btn" title="คลิกเพื่อดาวน์โหลดวิดีโอ MP4 หรือกดสามเหลี่ยมเพื่อดูตัวเลือก">
        ${SVG_DOWNLOAD}
        <span class="rh-btn-text">โหลดคลิป</span>
        <span class="rh-menu-toggle" title="ตัวเลือกเพิ่มเติม">▾</span>
      </div>
      <div class="rh-card-popup">
        <div class="rh-menu-item dl-item">${SVG_DOWNLOAD} ดาวน์โหลดวิดีโอ (MP4)</div>
        <div class="rh-menu-item hub-item">${SVG_HUB} ส่งเข้า Hub Studio</div>
        <div class="rh-menu-item copy-cdn-item">${SVG_COPY} คัดลอกลิงก์ตรง (MP4)</div>
        <div class="rh-menu-item copy-link-item">${SVG_COPY} คัดลอกลิงก์โพสต์นี้</div>
      </div>
    `;

    const dlBtn = wrap.querySelector(".rh-dl-btn");
    const btnText = wrap.querySelector(".rh-btn-text");
    const menuToggle = wrap.querySelector(".rh-menu-toggle");
    const popup = wrap.querySelector(".rh-card-popup");

    // Click main button -> Download immediately
    dlBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      triggerDownload(fullUrl, noteId, card, btnText);
    });

    // Click arrow toggle -> Toggle popup menu
    menuToggle.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      document.querySelectorAll(".rh-card-popup.show").forEach((p) => {
        if (p !== popup) p.classList.remove("show");
      });
      popup.classList.toggle("show");
    });

    // Popup menu item clicks
    popup.querySelector(".dl-item").addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      popup.classList.remove("show");
      triggerDownload(fullUrl, noteId, card, btnText);
    });

    popup.querySelector(".hub-item").addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      popup.classList.remove("show");
      triggerSendToHub(fullUrl);
    });

    popup.querySelector(".copy-cdn-item").addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      popup.classList.remove("show");
      triggerCopyDirectUrl(fullUrl, noteId, card);
    });

    popup.querySelector(".copy-link-item").addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      popup.classList.remove("show");
      navigator.clipboard.writeText(fullUrl).then(() => {
        showToast("📋 คัดลอกลิงก์โพสต์เรียบร้อยแล้ว!", "success");
      });
    });

    container.appendChild(wrap);
  }

  // Scan entire document for note cards
  function scanCards() {
    const selector = "section.note-item, .note-item, [class*='note-item']";
    const cards = document.querySelectorAll(selector);
    cards.forEach(processCard);

    // Also check detail modal when watching video full/overlay
    scanModalPlayer();
  }

  // Attach Floating Bar to Active Modal Video Player
  function scanModalPlayer() {
    const modal = document.querySelector(
      ".media-container, .note-detail-mask, .note-container, div[class*='note-detail']"
    );
    if (!modal) return;

    if (modal.hasAttribute("data-rh-modal-ready")) return;
    const video = modal.querySelector("video");
    if (!video) return;

    modal.setAttribute("data-rh-modal-ready", "true");

    const modalBar = document.createElement("div");
    modalBar.className = "rh-modal-bar";
    modalBar.innerHTML = `
      <button class="rh-modal-btn primary modal-dl-btn">${SVG_DOWNLOAD} ดาวน์โหลดคลิปนี้ (MP4)</button>
      <button class="rh-modal-btn secondary modal-hub-btn">${SVG_HUB} ส่งเข้า Hub</button>
      <button class="rh-modal-btn secondary modal-copy-btn">${SVG_COPY} คัดลอกลิงก์</button>
    `;

    modalBar.querySelector(".modal-dl-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      const currentUrl = window.location.href;
      const noteId = extractNoteId(currentUrl);
      const title =
        document.querySelector(".note-content .title, .title")?.innerText?.trim() || `RedNote_${noteId}`;

      const videoSrc = video.currentSrc || video.src || "";
      if (videoSrc && videoSrc.startsWith("http") && !videoSrc.startsWith("blob:")) {
        chrome.runtime.sendMessage(
          {
            action: "download_video",
            url: videoSrc,
            title: title,
          },
          (resp) => {
            if (resp && resp.success) showToast(`✅ เริ่มดาวน์โหลด: ${resp.filename}`, "success");
            else showToast("❌ ดาวน์โหลดล้มเหลว", "error");
          }
        );
      } else {
        triggerDownload(currentUrl, noteId, modal, null);
      }
    });

    modalBar.querySelector(".modal-hub-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      triggerSendToHub(window.location.href);
    });

    modalBar.querySelector(".modal-copy-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      const videoSrc = video.currentSrc || video.src || "";
      if (videoSrc && videoSrc.startsWith("http")) {
        navigator.clipboard.writeText(videoSrc).then(() => showToast("📋 คัดลอกลิงก์ตรง (MP4) แล้ว!", "success"));
      } else {
        navigator.clipboard.writeText(window.location.href).then(() =>
          showToast("📋 คัดลอกลิงก์โพสต์แล้ว!", "success")
        );
      }
    });

    document.body.appendChild(modalBar);

    // Remove bar when modal closes
    const closeChecker = setInterval(() => {
      if (!document.querySelector(".media-container, .note-detail-mask, .note-container, div[class*='note-detail']")) {
        modalBar.remove();
        clearInterval(closeChecker);
      }
    }, 500);
  }

  // Close open popups when clicking outside
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".rh-card-badge-wrap")) {
      document.querySelectorAll(".rh-card-popup.show").forEach((p) => p.classList.remove("show"));
    }
  });

  // Debounced scan observer for infinite scrolling feeds
  let scanTimer = null;
  const observer = new MutationObserver(() => {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scanCards, 150);
  });

  observer.observe(document.body, { childList: true, subtree: true });

  // Initial scan
  scanCards();
  console.log("[RedNote Helper & Video Downloader v1.3.0] Content script activated.");
})();
