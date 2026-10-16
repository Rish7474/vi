// background.js — Vi Extension Service Worker
// Forwards "Download Transcription", "Ask Vi (init)", and "Ask Vi (chat)" calls to the backend service.

const DEFAULT_BACKEND_URL = "http://localhost:8787";

async function getConfig() {
  try {
    if (chrome && chrome.storage && chrome.storage.local) {
      return await new Promise((resolve) => {
        chrome.storage.local.get(
          {
            backendUrl: DEFAULT_BACKEND_URL,
            provider: "gemini",
            apiKey: "",
            model: "gemini-3.8-flash"
          },
          (res) =>
            resolve(
              res || {
                backendUrl: DEFAULT_BACKEND_URL,
                provider: "gemini",
                apiKey: "",
                model: "gemini-3.8-flash"
              }
            )
        );
      });
    }
  } catch (err) {
    console.warn("Storage fallback:", err);
  }
  return {
    backendUrl: DEFAULT_BACKEND_URL,
    provider: "gemini",
    apiKey: "",
    model: "gemini-3.8-flash"
  };
}

// Re-inject content script into open tabs when extension is reloaded so tabs don't get stuck
chrome.runtime.onInstalled.addListener(async () => {
  try {
    if (!chrome.tabs || !chrome.scripting) return;
    const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
    for (const tab of tabs) {
      if (!tab.id) continue;
      chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["content.css"] }).catch(() => {});
      chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["markdown.js", "content.js"] }).catch(() => {});
    }
  } catch {
    // Ignore tabs where scripting isn't permitted
  }
});

const activeRequests = new Map();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return false;

  // 0. Interrupt / Abort in-flight request
  if (message.type === "VI_ABORT") {
    const reqId = message.requestId;
    if (reqId && activeRequests.has(reqId)) {
      const ctrl = activeRequests.get(reqId);
      ctrl.abort();
      activeRequests.delete(reqId);
      sendResponse({ ok: true, aborted: true });
    } else {
      sendResponse({ ok: true, aborted: false });
    }
    return false;
  }

  // 1. Download Transcription -> calls POST /api/transcribe on backend
  if (message.type === "VI_DOWNLOAD_TRANSCRIPTION") {
    (async () => {
      try {
        const cfg = await getConfig();
        const baseUrl = (cfg.backendUrl || DEFAULT_BACKEND_URL).replace(/\/+$/, "");
        const resp = await fetch(`${baseUrl}/api/transcribe`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: message.url,
            title: message.title,
            pageUrl: message.pageUrl || (sender && sender.tab && sender.tab.url) || null,
            provider: cfg.provider,
            apiKey: cfg.apiKey,
            model: cfg.model
          })
        });
        const data = await resp.json();
        if (!resp.ok || !data.ok) {
          throw new Error(data.error || `Backend error (${resp.status})`);
        }
        sendResponse({ ok: true, ...data });
      } catch (err) {
        sendResponse({ ok: false, error: err.message || String(err) });
      }
    })();
    return true;
  }

  // 2. Initialize Ask Vi -> calls POST /api/vi/init on backend (scrapes transcript & indexes if large)
  if (message.type === "VI_INIT") {
    (async () => {
      try {
        const cfg = await getConfig();
        const baseUrl = (cfg.backendUrl || DEFAULT_BACKEND_URL).replace(/\/+$/, "");
        const resp = await fetch(`${baseUrl}/api/vi/init`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: message.url,
            title: message.title,
            pageUrl: message.pageUrl || (sender && sender.tab && sender.tab.url) || null,
            provider: cfg.provider,
            apiKey: cfg.apiKey,
            model: cfg.model
          })
        });
        const data = await resp.json();
        if (!resp.ok || !data.ok) {
          throw new Error(data.error || `Backend error (${resp.status})`);
        }
        sendResponse({ ok: true, ...data });
      } catch (err) {
        sendResponse({ ok: false, error: err.message || String(err) });
      }
    })();
    return true;
  }

  // 3. Send message in Ask Vi chat pane -> calls POST /api/vi/chat on backend
  if (message.type === "VI_CHAT") {
    (async () => {
      const requestId = message.requestId || ("req_" + Date.now() + "_" + Math.random().toString(36).slice(2));
      const controller = new AbortController();
      activeRequests.set(requestId, controller);

      try {
        const cfg = await getConfig();
        const baseUrl = (cfg.backendUrl || DEFAULT_BACKEND_URL).replace(/\/+$/, "");
        const resp = await fetch(`${baseUrl}/api/vi/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            videoId: message.videoId,
            url: message.url,
            pageUrl: message.pageUrl || (sender && sender.tab && sender.tab.url) || null,
            message: message.message,
            history: message.history || [],
            llmConfig: {
              provider: cfg.provider,
              apiKey: cfg.apiKey,
              model: cfg.model
            }
          })
        });
        const data = await resp.json();
        if (!resp.ok || !data.ok) {
          throw new Error(data.error || `Backend chat error (${resp.status})`);
        }
        sendResponse({ ok: true, ...data });
      } catch (err) {
        if (err.name === "AbortError" || controller.signal.aborted) {
          sendResponse({ ok: false, aborted: true, error: "Request interrupted by user" });
        } else {
          sendResponse({ ok: false, error: err.message || String(err) });
        }
      } finally {
        activeRequests.delete(requestId);
      }
    })();
    return true;
  }

  return false;
});
