// popup.js — Simplified Vi Popup Controller
// 1. Select a video on the page
// 2. Click "Download Transcription" OR "Ask Vi" (opens chat pane)

const EXAMPLE_URL =
  "https://legistar.council.nyc.gov/MeetingDetail.aspx?ID=1437157&GUID=78DE09C8-0EB9-43B1-811B-89885C58A8DE&Options=info%7C&Search=";
const DEFAULT_BACKEND_URL = "http://localhost:8787";

const videoSelect = document.getElementById("videoSelect");
const downloadTranscriptBtn = document.getElementById("downloadTranscriptBtn");
const askViBtn = document.getElementById("askViBtn");
const statusLine = document.getElementById("statusLine");

const chatPane = document.getElementById("chatPane");
const chatMessages = document.getElementById("chatMessages");
const chatForm = document.getElementById("chatForm");
const chatInput = document.getElementById("chatInput");
const chatSendBtn = document.getElementById("chatSendBtn");

const ARROW_ICON_SVG = `<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M12 4l-6.5 6.5 1.41 1.41L11 7.83V20h2V7.83l4.09 4.08 1.41-1.41L12 4z"/></svg>`;
const SQUARE_ICON_SVG = `<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>`;

let popupChatAbortController = null;
let popupChatRequestId = null;
let popupThinkingBubble = null;

const settingsToggleBtn = document.getElementById("settingsToggleBtn");
const settingsPanel = document.getElementById("settingsPanel");
const backendUrlInput = document.getElementById("backendUrlInput");
const apiKeyInput = document.getElementById("apiKeyInput");
const saveSettingsBtn = document.getElementById("saveSettingsBtn");

let videos = [];
let initializedVideo = null;
let initPromise = null;
let chatHistory = [];

async function callViBackend(messageType, endpoint, payload, options = {}) {
  try {
    const res = await chrome.runtime.sendMessage({
      type: messageType,
      ...payload
    });
    if (res && typeof res === "object") {
      return res;
    }
  } catch (err) {
    console.warn("[Vi Popup] Falling back to direct fetch:", err.message);
  }

  try {
    const baseUrl = (backendUrlInput.value.trim() || DEFAULT_BACKEND_URL).replace(/\/+$/, "");
    const resp = await fetch(`${baseUrl}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: options.signal,
      body: JSON.stringify(payload)
    });
    const data = await resp.json();
    if (!resp.ok || !data.ok) {
      return { ok: false, error: data.error || `Backend HTTP ${resp.status}` };
    }
    return { ok: true, ...data };
  } catch (err) {
    if (err.name === "AbortError") {
      return { ok: false, aborted: true, error: "Request interrupted by user" };
    }
    return { ok: false, error: `Could not reach backend (${err.message})` };
  }
}

const popoutBtn = document.getElementById("popoutBtn");
if (popoutBtn) {
  if (window.innerWidth > 520 || window.location.search.includes("tab=1")) {
    popoutBtn.style.display = "none";
  } else {
    popoutBtn.addEventListener("click", () => {
      const url = chrome?.runtime?.getURL ? chrome.runtime.getURL("popup.html?tab=1") : "popup.html?tab=1";
      if (chrome?.tabs?.create) {
        chrome.tabs.create({ url });
      } else {
        window.open(url, "_blank");
      }
    });
  }
}

settingsToggleBtn.addEventListener("click", () => {
  settingsPanel.classList.toggle("hidden");
});

saveSettingsBtn.addEventListener("click", () => {
  if (chrome?.storage?.local) {
    chrome.storage.local.set(
      {
        backendUrl: backendUrlInput.value.trim() || DEFAULT_BACKEND_URL,
        apiKey: apiKeyInput.value.trim()
      },
      () => {
        settingsPanel.classList.add("hidden");
      }
    );
  } else {
    settingsPanel.classList.add("hidden");
  }
});

function getSelectedVideo() {
  return videos.find((v) => v.id === videoSelect.value) || videos[0] || null;
}

function appendBubble(role, text) {
  const div = document.createElement("div");
  div.className = `bubble ${role}`;
  if (role === "user") {
    div.textContent = text;
  } else {
    div.classList.add("vi-markdown");
    if (window.ViMarkdown && typeof window.ViMarkdown.render === "function") {
      div.innerHTML = window.ViMarkdown.render(String(text || ""));
    } else {
      div.textContent = String(text || "");
    }
    div.querySelectorAll(".vi-ts-badge").forEach((badge) => {
      badge.addEventListener("click", () => {
        navigator.clipboard?.writeText(badge.dataset.timestamp || "").catch(() => {});
        badge.classList.add("vi-ts-copied");
        setTimeout(() => badge.classList.remove("vi-ts-copied"), 1200);
      });
    });
  }
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return div;
}

function appendTypingBubble() {
  const div = document.createElement("div");
  div.className = "bubble assistant typing-bubble";
  div.setAttribute("aria-label", "Vi is typing");
  div.innerHTML = `<div class="typing-dots"><span></span><span></span><span></span></div>`;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return div;
}

// 1) Download Transcription button
downloadTranscriptBtn.addEventListener("click", async () => {
  const selected = getSelectedVideo();
  if (!selected) return;

  statusLine.textContent = "Preparing transcription...";
  downloadTranscriptBtn.disabled = true;

  try {
    const res = await callViBackend("VI_DOWNLOAD_TRANSCRIPTION", "/api/transcribe", {
      url: selected.url,
      title: selected.title
    });

    if (!res || !res.ok || !res.transcriptText) {
      statusLine.textContent = `⚠️ ${(res && res.error) || "Failed to download transcription."}`;
      return;
    }

    const blob = new Blob([res.transcriptText], { type: "text/plain;charset=utf-8" });
    const blobUrl = URL.createObjectURL(blob);
    chrome.downloads.download({
      url: blobUrl,
      filename: res.filename || "transcription.txt"
    });

    statusLine.textContent = `✓ Downloaded ${res.filename}`;
  } finally {
    downloadTranscriptBtn.disabled = false;
  }
});

// 2) Ask Vi button — opens chat pane, scrapes transcript if needed, and indexes if too large
async function ensureViInitialized() {
  const selected = getSelectedVideo();
  if (!selected) return null;

  chatPane.classList.remove("hidden");

  if (initializedVideo && initializedVideo.url === selected.url && initializedVideo.videoId) {
    return initializedVideo;
  }

  if (initPromise) {
    return initPromise;
  }

  chatMessages.innerHTML = "";
  chatHistory = [];
  statusLine.textContent = "Vi is loading up...";
  const loading = appendBubble("assistant", "Vi is loading up...");

  initPromise = (async () => {
    try {
      const res = await callViBackend("VI_INIT", "/api/vi/init", {
        url: selected.url,
        title: selected.title
      });

      loading.remove();

      if (!res || !res.ok || !res.video) {
        statusLine.textContent = `⚠️ ${(res && res.error) || "Failed to load Vi."}`;
        appendBubble("assistant", `⚠️ ${(res && res.error) || "Could not load Vi."}`);
        return null;
      }

      initializedVideo = {
        ...selected,
        videoId: res.video.videoId,
        meta: res.video
      };

      statusLine.textContent = "✓ Vi is ready";
      appendBubble(
        "assistant",
        `Hi! I'm **Vi**. Ask me anything about this video!`
      );
      return initializedVideo;
    } catch (err) {
      loading.remove();
      appendBubble("assistant", `⚠️ ${err.message || String(err)}`);
      return null;
    } finally {
      initPromise = null;
    }
  })();

  return initPromise;
}

askViBtn.addEventListener("click", async () => {
  await ensureViInitialized();
  chatInput.focus();
});

function setPopupSendButtonState(isBusy) {
  if (!chatSendBtn) return;
  if (isBusy) {
    chatSendBtn.classList.add("btn-stop");
    chatSendBtn.title = "Stop generation (click to interrupt)";
    chatSendBtn.setAttribute("aria-label", "Stop generation");
    chatSendBtn.innerHTML = SQUARE_ICON_SVG;
  } else {
    chatSendBtn.classList.remove("btn-stop");
    chatSendBtn.title = "Send question";
    chatSendBtn.setAttribute("aria-label", "Send question");
    chatSendBtn.innerHTML = ARROW_ICON_SVG;
  }
}

function interruptPopupChat() {
  if (popupChatAbortController) {
    try {
      popupChatAbortController.abort();
    } catch (_) {}
  }
  if (popupChatRequestId) {
    try {
      chrome.runtime?.sendMessage?.({ type: "VI_ABORT", requestId: popupChatRequestId });
    } catch (_) {}
  }
}

if (chatSendBtn) {
  chatSendBtn.addEventListener("click", (e) => {
    if (popupChatAbortController) {
      e.preventDefault();
      e.stopPropagation();
      interruptPopupChat();
    }
  });
}

// Send message in Ask Vi chat pane
chatForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (popupChatAbortController) {
    interruptPopupChat();
    return;
  }

  const question = chatInput.value.trim();
  if (!question) return;
  chatInput.value = "";

  if (!initializedVideo) {
    await ensureViInitialized();
  }
  const selected = initializedVideo || getSelectedVideo();
  if (!selected) return;

  appendBubble("user", question);
  popupThinkingBubble = appendTypingBubble();
  popupChatAbortController = new AbortController();
  popupChatRequestId = "req_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7);
  setPopupSendButtonState(true);

  try {
    const res = await callViBackend("VI_CHAT", "/api/vi/chat", {
      videoId: initializedVideo ? initializedVideo.videoId : null,
      url: selected.url,
      message: question,
      history: chatHistory,
      requestId: popupChatRequestId
    }, { signal: popupChatAbortController.signal });

    if (popupThinkingBubble) {
      popupThinkingBubble.remove();
      popupThinkingBubble = null;
    }

    if (res && res.aborted) {
      appendBubble("assistant", "⏹ *[Generation stopped]*");
      return;
    }

    if (!res || !res.ok) {
      appendBubble("assistant", `⚠️ ${(res && res.error) || "Failed to get answer."}`);
      return;
    }

    chatHistory.push({ role: "user", content: question });
    chatHistory.push({ role: "assistant", content: res.answer });
    appendBubble("assistant", res.answer);
  } catch (err) {
    if (popupThinkingBubble) {
      popupThinkingBubble.remove();
      popupThinkingBubble = null;
    }
    if (err.name === "AbortError" || popupChatAbortController?.signal?.aborted) {
      appendBubble("assistant", "⏹ *[Generation stopped]*");
    } else {
      appendBubble("assistant", `⚠️ ${err.message || String(err)}`);
    }
  } finally {
    if (popupThinkingBubble) {
      popupThinkingBubble.remove();
      popupThinkingBubble = null;
    }
    popupChatAbortController = null;
    popupChatRequestId = null;
    setPopupSendButtonState(false);
  }
});

// Initialize popup: load videos from active tab
(async function init() {
  if (chrome?.storage?.local) {
    chrome.storage.local.get(
      {
        backendUrl: DEFAULT_BACKEND_URL,
        apiKey: ""
      },
      (cfg) => {
        if (cfg) {
          backendUrlInput.value = cfg.backendUrl || DEFAULT_BACKEND_URL;
          apiKeyInput.value = cfg.apiKey || "";
        }
      }
    );
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.id) {
    try {
      const res = await chrome.tabs.sendMessage(tab.id, { type: "GET_PAGE_VIDEOS" });
      if (res && res.ok && Array.isArray(res.videos) && res.videos.length > 0) {
        videos = res.videos;
      }
    } catch {
      // Content script not loaded yet
    }

    if (
      videos.length === 0 &&
      tab.url &&
      (/\.mp4(\?.*)?$/i.test(tab.url) || tab.url.includes("legistar.council.nyc.gov/MeetingDetail.aspx"))
    ) {
      videos = [
        {
          id: "active-tab",
          title: tab.title || "Current Page Video",
          url: tab.url
        }
      ];
    }
  }

  if (videos.length === 0) {
    videos = [
      {
        id: "example",
        title: "NYC Council Youth Oversight Hearing (9/16/2026)",
        url: EXAMPLE_URL
      }
    ];
  }

  videoSelect.innerHTML = "";
  videos.forEach((v) => {
    const opt = document.createElement("option");
    opt.value = v.id;
    opt.textContent = v.title;
    videoSelect.appendChild(opt);
  });
})();
