// content.js — Simplified Vi Extension Content Script
// Detects videos on the page and provides two actions:
//   1) Download Transcription
//   2) Ask Vi (opens a chat pane to ask questions about the video)

(() => {
  const BACKEND_BASE = "http://localhost:8787";

  // Clean up any stale UI from previous extension reloads on this tab
  [
    "#nycc-mp4-inline-panel",
    "#vcrag-inline-bar",
    "#vcrag-modal-root",
    "#vcrag-fab-btn",
    "#vi-chat-pane",
    ".vi-inline-actions"
  ].forEach((sel) => {
    document.querySelectorAll(sel).forEach((el) => el.remove());
  });
  document.querySelectorAll("[data-vi-buttons-added]").forEach((el) => {
    delete el.dataset.viButtonsAdded;
  });

  let pageVideos = [];
  let currentViVideo = null;
  let initPromise = null;
  let chatHistory = [];
  let activeChatAbortController = null;
  let currentChatRequestId = null;
  let currentThinkingBubble = null;

  const VI_ARROW_ICON_SVG = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 4l-6.5 6.5 1.41 1.41L11 7.83V20h2V7.83l4.09 4.08 1.41-1.41L12 4z"/></svg>`;
  const VI_SQUARE_ICON_SVG = `<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="2.5"/></svg>`;

  function setDrawerSendButtonState(isBusy) {
    const pane = document.getElementById("vi-chat-pane");
    if (!pane) return;
    const btn = pane.querySelector("#vi-send-btn");
    if (!btn) return;
    if (isBusy) {
      btn.classList.add("vi-btn-stop");
      btn.title = "Stop generation (click to interrupt)";
      btn.setAttribute("aria-label", "Stop generation");
      btn.innerHTML = VI_SQUARE_ICON_SVG;
    } else {
      btn.classList.remove("vi-btn-stop");
      btn.title = "Send question";
      btn.setAttribute("aria-label", "Send question");
      btn.innerHTML = VI_ARROW_ICON_SVG;
    }
  }

  function interruptDrawerChat() {
    if (activeChatAbortController) {
      try {
        activeChatAbortController.abort();
      } catch (_) {}
    }
    if (currentChatRequestId && typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
      try {
        chrome.runtime.sendMessage({ type: "VI_ABORT", requestId: currentChatRequestId });
      } catch (_) {}
    }
  }

  function cleanText(el) {
    if (!el) return "";
    return (el.textContent || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  }

  function resolveUrl(href) {
    if (!href || href === "#" || href.startsWith("javascript:") || href.startsWith("blob:")) {
      return null;
    }
    try {
      return new URL(href, window.location.href).toString();
    } catch {
      return null;
    }
  }

  async function getConfiguredBackendBase() {
    try {
      if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
        return await new Promise((resolve) => {
          chrome.storage.local.get({ backendUrl: BACKEND_BASE }, (cfg) => {
            resolve(((cfg && cfg.backendUrl) || BACKEND_BASE).replace(/\/+$/, ""));
          });
        });
      }
    } catch {
      // ignore if extension context was reloaded
    }
    return BACKEND_BASE;
  }

  /**
   * Resilient backend caller:
   * 1. Tries messaging background.js via chrome.runtime.sendMessage
   * 2. Falls back to direct fetch to configured backend if extension context was reloaded
   */
  async function callViBackend(messageType, endpoint, payload, options = {}) {
    const fullPayload = {
      pageUrl: window.location.href,
      ...payload
    };
    try {
      if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id) {
        const res = await chrome.runtime.sendMessage({
          type: messageType,
          ...fullPayload
        });
        if (res && typeof res === "object") {
          return res;
        }
      }
    } catch (err) {
      console.warn("[Vi] chrome.runtime.sendMessage fallback to direct fetch:", err.message);
    }

    // Fallback: call backend directly
    const baseUrl = await getConfiguredBackendBase();
    try {
      const resp = await fetch(`${baseUrl}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: options.signal,
        body: JSON.stringify(fullPayload)
      });
      const data = await resp.json();
      if (!resp.ok || !data.ok) {
        return { ok: false, error: data.error || `Backend HTTP ${resp.status}` };
      }
      return { ok: true, ...data };
    } catch (fetchErr) {
      if (fetchErr.name === "AbortError") {
        return { ok: false, aborted: true, error: "Request interrupted by user" };
      }
      return {
        ok: false,
        error: `Could not reach Vi backend at ${baseUrl} (${fetchErr.message})`
      };
    }
  }

  function triggerTextFileDownload(filename, textContent) {
    const blob = new Blob([textContent], { type: "text/plain;charset=utf-8" });
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = filename || "transcription.txt";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(blobUrl);
  }

  /**
   * Action 1: Download Transcription
   */
  async function handleDownloadTranscription(videoItem, buttonEl = null) {
    const originalLabel = buttonEl ? buttonEl.textContent : "";
    if (buttonEl) buttonEl.textContent = "⏳ Scraping transcript...";

    try {
      const res = await callViBackend("VI_DOWNLOAD_TRANSCRIPTION", "/api/transcribe", {
        url: videoItem.url,
        title: videoItem.title
      });

      if (res && res.ok && res.transcriptText) {
        triggerTextFileDownload(res.filename || "transcription.txt", res.transcriptText);
        if (buttonEl) buttonEl.textContent = "✓ Downloaded!";
      } else {
        if (buttonEl) buttonEl.textContent = "⚠️ Failed";
        alert((res && res.error) || "Could not scrape video transcription.");
      }
    } finally {
      if (buttonEl) {
        setTimeout(() => {
          buttonEl.textContent = originalLabel;
        }, 2200);
      }
    }
  }

  function ensureAskViPane() {
    let pane = document.getElementById("vi-chat-pane");
    if (pane) return pane;

    pane = document.createElement("div");
    pane.id = "vi-chat-pane";
    pane.className = "vi-chat-pane vi-hidden";
    pane.innerHTML = `
      <div class="vi-resize-handle" id="vi-resize-handle" title="Drag to resize Ask Vi (Double-click to reset)">
        <div class="vi-resize-grip"></div>
      </div>
      <div class="vi-pane-header">
        <div class="vi-pane-header-info">
          <div class="vi-pane-title" id="vi-pane-title">
            <img src="${typeof chrome !== 'undefined' && chrome.runtime?.getURL ? chrome.runtime.getURL('icons/icon32.png') : ''}" class="vi-brand-logo" width="18" height="18" alt="" />
            <span id="vi-pane-title-text" class="vi-pane-title-text" title="Initializing video transcription...">Initializing video transcription...</span>
          </div>
        </div>
        <div class="vi-pane-header-actions">
          <button type="button" class="vi-pane-btn" id="vi-pane-expand" title="Toggle wide view">⛶</button>
          <button type="button" class="vi-pane-btn vi-close-btn" id="vi-pane-close" title="Close">✕</button>
        </div>
      </div>
      <div class="vi-messages" id="vi-messages"></div>
      <form class="vi-input-row" id="vi-chat-form">
        <input
          type="text"
          class="vi-input"
          id="vi-chat-input"
          placeholder="Ask Vi"
          autocomplete="off"
        />
        <button type="submit" class="vi-send-btn" id="vi-send-btn" title="Send question" aria-label="Send">
          ${VI_ARROW_ICON_SVG}
        </button>
      </form>
    `;

    document.body.appendChild(pane);

    // Default sizing constants
    const DEFAULT_WIDTH = 420;
    const MIN_WIDTH = 320;
    const getMaxWidth = () => Math.min(1400, Math.max(MIN_WIDTH, window.innerWidth - 32));

    // Restore saved width if available
    try {
      const savedWidth = localStorage.getItem("vi_pane_width");
      if (savedWidth) {
        const parsed = parseInt(savedWidth, 10);
        if (!isNaN(parsed) && parsed >= MIN_WIDTH) {
          const clamped = Math.min(parsed, getMaxWidth());
          pane.style.width = `${clamped}px`;
        }
      }
    } catch (_) {}

    // Resizing logic via pointer events (mouse & touch)
    const handle = pane.querySelector("#vi-resize-handle");
    let isResizing = false;
    let startX = 0;
    let startWidth = DEFAULT_WIDTH;

    const onPointerMove = (e) => {
      if (!isResizing) return;
      // Because the pane is anchored on the right:
      // dragging to the left (smaller clientX) increases width.
      const deltaX = startX - e.clientX;
      const targetWidth = Math.max(MIN_WIDTH, Math.min(startWidth + deltaX, getMaxWidth()));
      pane.style.width = `${targetWidth}px`;
      if (pane.classList.contains("vi-maximized")) {
        pane.classList.remove("vi-maximized");
        const expandBtn = pane.querySelector("#vi-pane-expand");
        if (expandBtn) {
          expandBtn.textContent = "⛶";
          expandBtn.title = "Toggle wide view";
        }
      }
    };

    const onPointerUp = (e) => {
      if (!isResizing) return;
      isResizing = false;
      document.body.classList.remove("vi-resizing-active");
      pane.classList.remove("vi-resizing");
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      try {
        const finalWidth = parseInt(pane.style.width, 10);
        if (!isNaN(finalWidth)) {
          localStorage.setItem("vi_pane_width", String(finalWidth));
        }
      } catch (_) {}
    };

    handle.addEventListener("pointerdown", (e) => {
      if (e.button && e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      isResizing = true;
      startX = e.clientX;
      startWidth = pane.getBoundingClientRect().width;
      document.body.classList.add("vi-resizing-active");
      pane.classList.add("vi-resizing");
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerUp);
    });

    // Double-click handle to reset to default width
    handle.addEventListener("dblclick", (e) => {
      e.preventDefault();
      pane.classList.remove("vi-maximized");
      const expandBtn = pane.querySelector("#vi-pane-expand");
      if (expandBtn) {
        expandBtn.textContent = "⛶";
        expandBtn.title = "Toggle wide view";
      }
      pane.style.width = `${DEFAULT_WIDTH}px`;
      try {
        localStorage.setItem("vi_pane_width", String(DEFAULT_WIDTH));
      } catch (_) {}
    });

    // Toggle wide / maximize button
    const expandBtn = pane.querySelector("#vi-pane-expand");
    if (expandBtn) {
      expandBtn.addEventListener("click", () => {
        const isMax = pane.classList.toggle("vi-maximized");
        if (isMax) {
          expandBtn.title = "Restore normal view";
          expandBtn.textContent = "❐";
        } else {
          expandBtn.title = "Toggle wide view";
          expandBtn.textContent = "⛶";
          try {
            const saved = parseInt(localStorage.getItem("vi_pane_width"), 10);
            if (!isNaN(saved) && saved >= MIN_WIDTH) {
              pane.style.width = `${Math.min(saved, getMaxWidth())}px`;
            } else {
              pane.style.width = `${DEFAULT_WIDTH}px`;
            }
          } catch (_) {
            pane.style.width = `${DEFAULT_WIDTH}px`;
          }
        }
      });
    }

    // Keep pane within screen bounds on window resize
    window.addEventListener("resize", () => {
      if (pane.classList.contains("vi-maximized")) return;
      const currentWidth = parseInt(pane.style.width, 10);
      if (!isNaN(currentWidth)) {
        const maxW = getMaxWidth();
        if (currentWidth > maxW) {
          pane.style.width = `${maxW}px`;
        }
      }
    });

    pane.querySelector("#vi-pane-close").addEventListener("click", () => {
      pane.classList.add("vi-hidden");
    });

    const sendBtn = pane.querySelector("#vi-send-btn");
    if (sendBtn) {
      sendBtn.addEventListener("click", (e) => {
        if (activeChatAbortController) {
          e.preventDefault();
          e.stopPropagation();
          interruptDrawerChat();
        }
      });
    }

    pane.querySelector("#vi-chat-form").addEventListener("submit", (e) => {
      e.preventDefault();
      if (activeChatAbortController) {
        interruptDrawerChat();
        return;
      }
      const input = pane.querySelector("#vi-chat-input");
      const q = input.value.trim();
      if (!q) return;
      input.value = "";
      sendQuestionToVi(q);
    });

    return pane;
  }

  function renderAssistantMarkdown(text) {
    if (typeof window !== "undefined" && window.ViMarkdown && typeof window.ViMarkdown.render === "function") {
      return window.ViMarkdown.render(String(text || ""));
    }
    // Minimal safe fallback if markdown.js failed to load
    return String(text || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\n/g, "<br/>");
  }

  function seekPageVideo(seconds) {
    const video = document.querySelector("video");
    if (video && Number.isFinite(seconds)) {
      try {
        video.currentTime = seconds;
        video.play().catch(() => {});
        video.scrollIntoView({ behavior: "smooth", block: "center" });
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  function appendViBubble(role, text) {
    const pane = ensureAskViPane();
    const list = pane.querySelector("#vi-messages");
    const div = document.createElement("div");
    div.className = `vi-bubble ${role}`;

    if (role === "user") {
      div.textContent = text;
    } else {
      div.classList.add("vi-markdown");
      div.innerHTML = renderAssistantMarkdown(text);
      div.querySelectorAll(".vi-ts-badge").forEach((badge) => {
        badge.addEventListener("click", (e) => {
          e.preventDefault();
          const sec = Number(badge.dataset.seconds);
          if (!seekPageVideo(sec)) {
            navigator.clipboard?.writeText(badge.dataset.timestamp || "").catch(() => {});
            badge.classList.add("vi-ts-copied");
            setTimeout(() => badge.classList.remove("vi-ts-copied"), 1200);
          }
        });
      });
    }

    list.appendChild(div);
    list.scrollTop = list.scrollHeight;
    return div;
  }

  function appendViTypingBubble() {
    const pane = ensureAskViPane();
    const list = pane.querySelector("#vi-messages");
    const div = document.createElement("div");
    div.className = "vi-bubble assistant vi-typing-bubble";
    div.setAttribute("aria-label", "Vi is typing");
    div.innerHTML = `<div class="vi-typing-dots"><span></span><span></span><span></span></div>`;
    list.appendChild(div);
    list.scrollTop = list.scrollHeight;
    return div;
  }

  /**
   * Action 2: Open "Ask Vi" chat pane, scrape transcript (if not already generated),
   * and index the transcript if it is too large.
   */
  async function openAskViForVideo(videoItem) {
    const pane = ensureAskViPane();
    pane.classList.remove("vi-hidden");

    const titleEl = pane.querySelector("#vi-pane-title-text") || pane.querySelector("#vi-pane-subtitle");
    const messages = pane.querySelector("#vi-messages");

    if (currentViVideo && currentViVideo.url === videoItem.url && currentViVideo.videoId) {
      return currentViVideo;
    }

    if (initPromise) {
      return initPromise;
    }

    messages.innerHTML = "";
    chatHistory = [];
    if (titleEl) {
      titleEl.textContent = "Vi is loading up...";
      titleEl.title = "Vi is loading up...";
    }
    const loadingBubble = appendViBubble("assistant", "Vi is loading up...");

    initPromise = (async () => {
      try {
        const res = await callViBackend("VI_INIT", "/api/vi/init", {
          url: videoItem.url,
          title: videoItem.title
        });

        loadingBubble.remove();

        if (!res || !res.ok || !res.video) {
          if (titleEl) {
            titleEl.textContent = "Error loading video";
            titleEl.title = "Error loading video";
          }
          appendViBubble(
            "assistant",
            `⚠️ ${(res && res.error) || "Could not load this video."}`
          );
          return null;
        }

        currentViVideo = {
          ...videoItem,
          videoId: res.video.videoId,
          meta: res.video
        };

        if (titleEl) {
          titleEl.textContent = res.video.title;
          titleEl.title = res.video.title;
        }

        appendViBubble(
          "assistant",
          `Hi! I'm **Vi**. Ask me anything about this video!`
        );
        return currentViVideo;
      } catch (err) {
        loadingBubble.remove();
        if (titleEl) {
          titleEl.textContent = "Error loading video";
          titleEl.title = "Error loading video";
        }
        appendViBubble("assistant", `⚠️ Error: ${err.message || String(err)}`);
        return null;
      } finally {
        initPromise = null;
      }
    })();

    return initPromise;
  }

  async function sendQuestionToVi(question) {
    // If initialization is currently in flight or hasn't run yet, await/run it automatically!
    if (!currentViVideo || !currentViVideo.videoId) {
      if (initPromise) {
        await initPromise;
      } else if (pageVideos.length > 0) {
        await openAskViForVideo(pageVideos[0]);
      }
    }

    const activeUrl = (currentViVideo && currentViVideo.url) || (pageVideos[0] && pageVideos[0].url);
    const activeVideoId = currentViVideo ? currentViVideo.videoId : null;

    if (!activeUrl && !activeVideoId) {
      appendViBubble("assistant", "⚠️ No video detected on this page.");
      return;
    }

    appendViBubble("user", question);
    currentThinkingBubble = appendViTypingBubble();
    activeChatAbortController = new AbortController();
    currentChatRequestId = "req_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7);
    setDrawerSendButtonState(true);

    try {
      const res = await callViBackend("VI_CHAT", "/api/vi/chat", {
        videoId: activeVideoId,
        url: activeUrl,
        message: question,
        history: chatHistory,
        requestId: currentChatRequestId
      }, { signal: activeChatAbortController.signal });

      if (currentThinkingBubble) {
        currentThinkingBubble.remove();
        currentThinkingBubble = null;
      }

      if (res && res.aborted) {
        appendViBubble("assistant", "⏹ *[Generation stopped]*");
        return;
      }

      if (!res || !res.ok) {
        appendViBubble("assistant", `⚠️ ${(res && res.error) || "Error getting answer from Vi."}`);
        return;
      }

      if (!currentViVideo && res.videoId) {
        currentViVideo = { url: activeUrl, videoId: res.videoId };
      }

      chatHistory.push({ role: "user", content: question });
      chatHistory.push({ role: "assistant", content: res.answer });
      appendViBubble("assistant", res.answer);
    } catch (err) {
      if (currentThinkingBubble) {
        currentThinkingBubble.remove();
        currentThinkingBubble = null;
      }
      if (err.name === "AbortError" || activeChatAbortController?.signal?.aborted) {
        appendViBubble("assistant", "⏹ *[Generation stopped]*");
      } else {
        appendViBubble("assistant", `⚠️ ${err.message || String(err)}`);
      }
    } finally {
      if (currentThinkingBubble) {
        currentThinkingBubble.remove();
        currentThinkingBubble = null;
      }
      activeChatAbortController = null;
      currentChatRequestId = null;
      setDrawerSendButtonState(false);
    }
  }

  function scanPageForVideos() {
    const found = [];
    const seen = new Set();

    const addVideo = (title, url, anchorEl = null) => {
      if (!url || seen.has(url)) return;
      seen.add(url);
      const item = {
        id: `vid-${found.length + 1}`,
        title: title || `Video ${found.length + 1}`,
        url
      };
      found.push(item);

      if (anchorEl && !anchorEl.dataset.viButtonsAdded) {
        anchorEl.dataset.viButtonsAdded = "1";
        const wrap = document.createElement("span");
        wrap.className = "vi-inline-actions";

        const dlBtn = document.createElement("button");
        dlBtn.type = "button";
        dlBtn.className = "vi-action-btn";
        dlBtn.textContent = "⬇ Download Transcription";
        dlBtn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          handleDownloadTranscription(item, dlBtn);
        });

        const askBtn = document.createElement("button");
        askBtn.type = "button";
        askBtn.className = "vi-action-btn primary";
        const logoUrl = typeof chrome !== "undefined" && chrome.runtime?.getURL ? chrome.runtime.getURL("icons/icon32.png") : "";
        askBtn.innerHTML = `${logoUrl ? `<img src="${logoUrl}" class="vi-action-btn-logo" width="14" height="14" alt="" />` : ""}<span>Ask Vi</span>`;
        askBtn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          openAskViForVideo(item);
        });

        wrap.appendChild(dlBtn);
        wrap.appendChild(askBtn);
        anchorEl.insertAdjacentElement("afterend", wrap);
      }
    };

    const pageTitle = document.title || window.location.hostname;
    const currentUrl = window.location.href;
    const host = window.location.hostname.toLowerCase();

    // 1. Direct .mp4 links
    document.querySelectorAll("a[href]").forEach((a) => {
      const resolved = resolveUrl(a.getAttribute("href"));
      if (resolved && /\.mp4(\?.*|#.*)?$/i.test(resolved)) {
        addVideo(cleanText(a) || resolved.split("/").pop().split("?")[0], resolved, a);
      }
    });

    // 2. NYC City Council & NY Legistar Video.aspx links (NYC, Westchester, Yonkers, Albany, Rochester, etc.)
    const committee = cleanText(document.getElementById("ctl00_ContentPlaceHolder1_hypName"));
    const dateStr = cleanText(document.getElementById("ctl00_ContentPlaceHolder1_lblDate"));
    const meetingLabel = committee && dateStr ? `${committee} (${dateStr})` : pageTitle;

    document
      .querySelectorAll("#ctl00_ContentPlaceHolder1_hypVideo, a.videolink, a[onclick*='Video.aspx']")
      .forEach((a) => {
        const onclick = a.getAttribute("onclick") || "";
        if (onclick.includes("Video.aspx")) {
          const row = a.closest("tr");
          const rowLabel = row ? cleanText(row.querySelector("td")) : "";
          addVideo(rowLabel ? `${rowLabel}` : meetingLabel, onclick, a);
        }
      });

    // 3. NY State Assembly (nyassembly.gov/av) & NY Granicus portals (MediaPlayer.php / /player/clip/)
    document
      .querySelectorAll("a[href*='MediaPlayer.php'], a[href*='/player/clip/'], a[onclick*='MediaPlayer.php']")
      .forEach((a) => {
        const href = a.getAttribute("href") || "";
        const onclick = a.getAttribute("onclick") || "";
        const resolved = resolveUrl(href) || onclick;
        if (resolved) {
          const row = a.closest("tr");
          const rowTitle = row ? cleanText(row.querySelector("td")) : "";
          addVideo(rowTitle || cleanText(a) || pageTitle, resolved, a);
        }
      });

    // 4. NY Municipal Swagit portals (*.swagit.com/videos/<id>)
    if (host.includes("swagit.com")) {
      document.querySelectorAll("a[href*='/videos/']").forEach((a) => {
        const resolved = resolveUrl(a.getAttribute("href"));
        if (resolved && /\/videos\/\d+\b/i.test(resolved) && !/\/(download|transcript|embed)/i.test(resolved)) {
          const row = a.closest("tr");
          const rowTitle = row ? cleanText(row.querySelector("td")) : "";
          addVideo(rowTitle || cleanText(a) || pageTitle, resolved, a);
        }
      });
    }

    // 5. NY State Senate (nysenate.gov) & NY/NYC Gov pages with embedded YouTube hearing videos
    const isNyGovHost =
      /(?:nysenate\.gov|nyassembly\.gov|ny\.gov|nyc\.gov|mta\.info|legistar\.com|granicus\.com|viebit\.com|swagit\.com)/i.test(
        host
      );
    if (isNyGovHost) {
      document
        .querySelectorAll("iframe[src*='youtube.com/embed/'], iframe[src*='youtube-nocookie.com/embed/']")
        .forEach((iframe) => {
          const src = iframe.getAttribute("src");
          if (src) {
            addVideo(pageTitle, src, iframe);
          }
        });
    }

    // 6. If the user is directly on a Granicus, VieBit, or Swagit video player page
    if (
      /granicus\.com\/(?:MediaPlayer\.php|player\/clip\/\d+)/i.test(currentUrl) ||
      /viebit\.com\/vod\//i.test(currentUrl) ||
      /swagit\.com\/videos\/\d+/i.test(currentUrl)
    ) {
      const headerAnchor =
        document.querySelector("h1, h2, .video-title, #title") || document.body.firstElementChild;
      addVideo(pageTitle, currentUrl, headerAnchor);
    }

    // 7. HTML5 <video> elements
    document.querySelectorAll("video").forEach((v, idx) => {
      const src = resolveUrl(v.currentSrc || v.getAttribute("src"));
      if (src) {
        addVideo(v.getAttribute("title") || `${pageTitle} Video ${idx + 1}`, src, v);
      }
    });

    pageVideos = found;
    return found;
  }

  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || !msg.type) return false;

      if (msg.type === "GET_PAGE_VIDEOS") {
        const videos = scanPageForVideos();
        sendResponse({ ok: true, videos });
        return true;
      }

      if (msg.type === "OPEN_ASK_VI_PANE") {
        scanPageForVideos();
        const chosen =
          pageVideos.find((v) => v.id === msg.videoId || v.url === msg.url) ||
          (msg.url ? { id: "custom", title: msg.title || "Selected Video", url: msg.url } : pageVideos[0]);
        if (chosen) {
          openAskViForVideo(chosen);
        }
        sendResponse({ ok: true });
        return true;
      }

      return false;
    });
  }

  scanPageForVideos();
})();
