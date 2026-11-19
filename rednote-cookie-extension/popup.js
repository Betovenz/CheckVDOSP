document.addEventListener("DOMContentLoaded", async () => {
  const statusDot = document.getElementById("statusDot");
  const statusText = document.getElementById("statusText");
  const domainText = document.getElementById("domainText");
  const cookieCount = document.getElementById("cookieCount");
  const copyBtn = document.getElementById("copyBtn");
  const openXhsBtn = document.getElementById("openXhsBtn");
  const msgBox = document.getElementById("msgBox");
  const togglePreviewBtn = document.getElementById("togglePreviewBtn");
  const cookiePreview = document.getElementById("cookiePreview");

  let fullCookieString = "";
  let detectedDomain = "";

  function showMessage(text, type = "info") {
    msgBox.textContent = text;
    msgBox.className = `msg ${type}`;
  }

  // Toggle preview
  togglePreviewBtn.addEventListener("click", () => {
    const isHidden = cookiePreview.style.display === "none" || !cookiePreview.style.display;
    cookiePreview.style.display = isHidden ? "block" : "none";
    togglePreviewBtn.textContent = isHidden ? "ซ่อนข้อความ Cookie ▴" : "ดูข้อความ Cookie ▾";
  });

  // Open site button
  openXhsBtn.addEventListener("click", () => {
    chrome.tabs.create({ url: "https://www.xiaohongshu.com/" });
  });

  async function getCookiesForDomain(domain) {
    return new Promise((resolve) => {
      chrome.cookies.getAll({ domain }, (cookies) => {
        resolve(cookies || []);
      });
    });
  }

  async function loadCookies() {
    statusDot.className = "dot";
    statusText.textContent = "กำลังค้นหา Cookie...";

    // 1. Check current active tab domain first
    let activeDomain = "";
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.url) {
        const u = new URL(tab.url);
        if (u.hostname.includes("rednote.com")) activeDomain = "rednote.com";
        else if (u.hostname.includes("xiaohongshu.com")) activeDomain = "xiaohongshu.com";
      }
    } catch (_) {}

    // 2. Fetch from both domains
    let xhsCookies = await getCookiesForDomain("xiaohongshu.com");
    let rednoteCookies = await getCookiesForDomain("rednote.com");

    let chosenCookies = [];
    if (activeDomain === "rednote.com" && rednoteCookies.length > 0) {
      chosenCookies = rednoteCookies;
      detectedDomain = "rednote.com";
    } else if (xhsCookies.length > 0) {
      chosenCookies = xhsCookies;
      detectedDomain = "xiaohongshu.com";
    } else if (rednoteCookies.length > 0) {
      chosenCookies = rednoteCookies;
      detectedDomain = "rednote.com";
    }

    if (chosenCookies.length === 0) {
      statusDot.className = "dot amber";
      statusText.textContent = "ไม่พบ Cookie";
      domainText.textContent = "ยังไม่ได้ล็อกอิน";
      cookieCount.textContent = "0 รายการ";
      copyBtn.disabled = true;
      copyBtn.style.opacity = "0.5";
      showMessage("ยังไม่พบ Cookie กรุณาเปิดเว็บ RedNote แล้วเข้าสู่ระบบก่อนครับ", "error");
      return;
    }

    // Format into standard header string
    // Filter duplicates and create standard cookie string
    const map = new Map();
    for (const c of chosenCookies) {
      if (c.name && c.value) {
        map.set(c.name, c.value);
      }
    }

    const cookiePairs = [];
    map.forEach((val, key) => {
      cookiePairs.push(`${key}=${val}`);
    });

    fullCookieString = cookiePairs.join("; ");
    cookiePreview.value = fullCookieString;

    const hasSession = map.has("web_session") || map.has("a1") || map.has("x-rednote-session") || map.has("sessionid");
    statusDot.className = hasSession ? "dot green" : "dot amber";
    statusText.textContent = hasSession ? "เข้าสู่ระบบแล้ว" : "พบ Cookie ทั่วไป";
    domainText.textContent = detectedDomain;
    cookieCount.textContent = `${map.size} รายการ`;

    copyBtn.disabled = false;
    copyBtn.style.opacity = "1";
  }

  // Copy to clipboard
  copyBtn.addEventListener("click", async () => {
    if (!fullCookieString) return;
    try {
      await navigator.clipboard.writeText(fullCookieString);
      showMessage("✅ คัดลอก Cookie สำเร็จแล้ว! พร้อมนำไปวางในเว็บ Hub", "success");
    } catch (e) {
      // Fallback
      cookiePreview.style.display = "block";
      cookiePreview.select();
      document.execCommand("copy");
      showMessage("✅ คัดลอก Cookie สำเร็จแล้ว!", "success");
    }
  });

  loadCookies();
});
