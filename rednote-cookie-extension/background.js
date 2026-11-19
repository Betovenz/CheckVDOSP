// RedNote Helper Background Service Worker
chrome.runtime.onInstalled.addListener(() => {
  console.log("RedNote Helper & Video Downloader v1.3.0 installed/updated.");
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "download_video") {
    let { url, filename, title } = request;
    if (!url) {
      sendResponse({ success: false, error: "ไม่พบ URL ของวิดีโอ" });
      return true;
    }

    // Force https
    const targetUrl = url.replace(/^http:\/\//i, "https://");

    // Clean filename for Windows file systems
    const baseName = (title || filename || "RedNote_Video")
      .replace(/[\\/:*?"<>|\r\n\t]+/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 70);
    const safeFilename = `${baseName}.mp4`;

    chrome.downloads.download(
      {
        url: targetUrl,
        filename: safeFilename,
        saveAs: false,
        conflictAction: "uniquify"
      },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          console.warn("Direct download failed, trying fetch fallback:", chrome.runtime.lastError.message);
          // Fallback: fetch blob via extension privileges and download as data/blob URL
          fetch(targetUrl)
            .then((res) => {
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              return res.blob();
            })
            .then((blob) => {
              const reader = new FileReader();
              reader.onloadend = () => {
                chrome.downloads.download(
                  {
                    url: reader.result,
                    filename: safeFilename,
                    saveAs: false,
                    conflictAction: "uniquify"
                  },
                  (blobDlId) => {
                    if (chrome.runtime.lastError) {
                      sendResponse({ success: false, error: chrome.runtime.lastError.message });
                    } else {
                      sendResponse({ success: true, downloadId: blobDlId, filename: safeFilename });
                    }
                  }
                );
              };
              reader.readAsDataURL(blob);
            })
            .catch((err) => {
              sendResponse({ success: false, error: "ดาวน์โหลดล้มเหลว: " + err.message });
            });
        } else {
          sendResponse({ success: true, downloadId: downloadId, filename: safeFilename });
        }
      }
    );
    return true; // Keep message channel open for async response
  }

  if (request.action === "resolve_via_hub") {
    const hubUrl = "http://127.0.0.1:8000/api/resolve";
    fetch(hubUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: request.url })
    })
      .then((res) => {
        if (!res.ok) throw new Error(`Hub server returned status ${res.status}`);
        return res.json();
      })
      .then((data) => {
        const item = data.item || data;
        const videoUrl = item.direct_video_url || item.video_url;
        if (videoUrl) {
          sendResponse({
            success: true,
            videoUrl: videoUrl,
            title: item.title || "",
            id: item.id || ""
          });
        } else {
          sendResponse({ success: false, error: "Hub อ่านข้อมูลได้แต่ไม่พบวิดีโอ" });
        }
      })
      .catch((err) => {
        sendResponse({
          success: false,
          error: "ไม่สามารถเชื่อมต่อ Hub (localhost:8000): " + err.message
        });
      });
    return true;
  }

  if (request.action === "download_image") {
    const { url, filename } = request;
    if (!url) {
      sendResponse({ success: false, error: "ไม่พบ URL รูปภาพ" });
      return true;
    }
    const safeFilename = (filename || "RedNote_image.jpg")
      .replace(/[\\/:*?"<>|\r\n\t]+/g, "_")
      .slice(0, 80);

    chrome.downloads.download(
      {
        url: url.replace(/^http:\/\//i, "https://"),
        filename: safeFilename,
        saveAs: false,
        conflictAction: "uniquify"
      },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ success: true, downloadId });
        }
      }
    );
    return true;
  }

  if (request.action === "send_to_hub") {
    const hubUrl = "http://127.0.0.1:8000/api/resolve";
    fetch(hubUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: request.url })
    })
      .then((res) => {
        if (!res.ok) throw new Error(`Hub server returned status ${res.status}`);
        return res.json();
      })
      .then((data) => {
        sendResponse({ success: true, data });
      })
      .catch((err) => {
        sendResponse({
          success: false,
          error: "ไม่สามารถเชื่อมต่อ Hub (localhost:8000) ได้ กรุณาเปิดโปรแกรม Hub ก่อนครับ: " + err.message
        });
      });
    return true;
  }

  if (request.action === "fetch_note_html") {
    fetch(request.url, { credentials: "include" })
      .then((res) => res.text())
      .then((html) => sendResponse({ success: true, html }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }
});
