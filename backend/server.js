#!/usr/bin/env node
/**
 * Vi Production Backend Service
 * Fast NY/NYC Government Caption Exploiter + Term->Line[] Inverted Index + Summary Blobs Q&A
 *
 * Core Endpoints:
 *   GET  / or /api/health -> Production health & readiness check
 *   POST /api/transcribe  -> Scrapes exploitable NY/NYC gov caption track (never uses LLM/Whisper to transcribe)
 *   POST /api/vi/init     -> Scrapes caption track, builds Term -> Line[] Inverted Index & Large Summary Blobs
 *   POST /api/vi/chat     -> LLM fanout queries -> Inverted Index lines + neighbors + Summary Blobs -> Cited Answer
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const {
  parseCaptionTextToLines,
  formatSeconds,
  extractTerms,
  LineInvertedIndex
} = require("../rag.js");

// Load .env from project root if present
const ENV_PATH = path.join(__dirname, "..", ".env");
if (fs.existsSync(ENV_PATH)) {
  const envLines = fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/);
  for (const line of envLines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim().replace(/^['"]|['"]$/g, "");
      if (!process.env[key]) {
        process.env[key] = val;
      }
    }
  }
}

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 8787);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const CACHE_FILE = path.join(DATA_DIR, "vi_line_cache.json");
const LEGISTAR_ORIGIN = "https://legistar.council.nyc.gov";
const MAX_CACHED_VIDEOS = Number(process.env.MAX_CACHED_VIDEOS || 100);
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";

// Threshold above which a transcript is indexed with the Term -> Line[] inverted index + summary blobs
const LARGE_TRANSCRIPT_CHAR_THRESHOLD = 8000;

try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
} catch (err) {
  console.warn("[Vi Backend] Could not create data dir:", err.message);
}

function normalizeSourceKey(inputUrl) {
  if (!inputUrl) return "";
  try {
    const raw = String(inputUrl).trim();
    if (!raw.includes("://")) return raw.toLowerCase();
    const u = new URL(raw);
    return `${u.origin}${u.pathname}${u.search}`.toLowerCase();
  } catch {
    return String(inputUrl).trim().toLowerCase();
  }
}

/**
 * LRUStaticContextCache
 * Maintains shared static context in memory with Least Recently Used (LRU) eviction.
 * - get(key): Retrieves entry, refreshes LRU access order (moved to end of Map).
 * - set(videoId, entry): Stores entry, evicts oldest entry if size >= maxSize, registers source aliases.
 * - findBySource(key): Resolves videoId by URL, pageUrl, mp4Url, or vttUrl.
 */
class LRUStaticContextCache {
  constructor(maxSize = MAX_CACHED_VIDEOS) {
    this.maxSize = maxSize;
    this.map = new Map(); // videoId -> entry
    this.sourceToId = new Map(); // normalized URL -> videoId
  }

  get(key) {
    if (!key) return null;
    let videoId = key;
    if (!this.map.has(videoId)) {
      const norm = normalizeSourceKey(key);
      if (this.sourceToId.has(norm)) {
        videoId = this.sourceToId.get(norm);
      }
    }

    if (!videoId || !this.map.has(videoId)) {
      // Linear fallback check on meta properties
      for (const [id, entry] of this.map.entries()) {
        if (
          entry.meta &&
          (entry.meta.videoId === key ||
            entry.meta.mp4Url === key ||
            entry.meta.vttUrl === key ||
            entry.meta.pageUrl === key)
        ) {
          videoId = id;
          this.registerSourceAliases(id, entry);
          break;
        }
      }
    }

    if (!videoId || !this.map.has(videoId)) return null;

    const entry = this.map.get(videoId);
    // Refresh LRU order: delete and re-insert at the end (most recently used)
    this.map.delete(videoId);
    this.map.set(videoId, entry);
    entry.lastAccessedAt = Date.now();
    entry.accessCount = (entry.accessCount || 0) + 1;
    return entry;
  }

  set(videoId, entry) {
    if (!videoId || !entry) return;
    if (this.map.has(videoId)) {
      this.map.delete(videoId);
    } else if (this.map.size >= this.maxSize) {
      // Evict least recently used (first item in Map)
      const lruKey = this.map.keys().next().value;
      if (lruKey) {
        const lruEntry = this.map.get(lruKey);
        console.log(
          `[Vi Backend LRU] Evicting least recently used static context: "${lruEntry?.meta?.title || lruKey}" (ID: ${lruKey})`
        );
        this.delete(lruKey);
      }
    }

    entry.lastAccessedAt = Date.now();
    entry.accessCount = (entry.accessCount || 0) + 1;
    this.map.set(videoId, entry);
    this.registerSourceAliases(videoId, entry);
  }

  has(key) {
    return Boolean(this.get(key));
  }

  delete(videoId) {
    for (const [src, id] of this.sourceToId.entries()) {
      if (id === videoId) this.sourceToId.delete(src);
    }
    return this.map.delete(videoId);
  }

  registerSourceAliases(videoId, entry) {
    if (!entry || !entry.meta) return;
    const candidates = [
      entry.meta.videoId,
      entry.meta.mp4Url,
      entry.meta.vttUrl,
      entry.meta.pageUrl,
      entry.meta.fileName
    ].filter(Boolean);

    for (const c of candidates) {
      const norm = normalizeSourceKey(c);
      if (norm) this.sourceToId.set(norm, videoId);
    }
  }

  get size() {
    return this.map.size;
  }

  keys() {
    return this.map.keys();
  }

  values() {
    return this.map.values();
  }

  entries() {
    return this.map.entries();
  }
}

// videoId -> { meta, lines, transcriptText, lineIndex, temporalBlobs, generalSummary }
const videoStore = new LRUStaticContextCache(MAX_CACHED_VIDEOS);
// Deduplicate concurrent init/scrape requests for the same video key
const inFlightJobs = new Map();

function setVideoStoreEntry(videoId, entry) {
  videoStore.set(videoId, entry);
}

function getVideoStoreEntry(videoId) {
  return videoStore.get(videoId);
}

function formatLinesAsPlainText(lines, meta = {}) {
  const header = [
    `Video Transcription: ${meta.title || "Video"}`,
    meta.mp4Url ? `Video URL: ${meta.mp4Url}` : null,
    `------------------------------------------------------------------------`,
    ""
  ]
    .filter(Boolean)
    .join("\n");

  return header + "\n" + lines.map((l) => l.formatted).join("\n") + "\n";
}

function formatTemporalBlobs(temporalBlobs = []) {
  if (!Array.isArray(temporalBlobs) || temporalBlobs.length === 0) return "";
  return temporalBlobs
    .map(
      (b) =>
        `[Static Temporal Context — Timeline Blob ${b.blobIndex}/${b.totalBlobs || 10} | ${b.startTimestamp} – ${b.endTimestamp} | Lines ${b.startLine}–${b.endLine} (${b.lineCount || (b.endLine - b.startLine + 1)} lines)]\n${b.summary}`
    )
    .join("\n\n");
}

function formatGeneralSummary(generalSummary = "") {
  return String(generalSummary || "").trim();
}

function formatCitations(windows = [], fallbackText = "") {
  if (Array.isArray(windows) && windows.length > 0) {
    return windows
      .map((w, idx) => {
        const header = `[Citation ${idx + 1} | ${w.startTimestamp} – ${w.endTimestamp} | Lines ${w.startLine}–${w.endLine} | Matched Terms: ${(w.terms || []).join(", ")}]`;
        const body = (w.lines || []).map((l) => l.formatted).join("\n");
        return `${header}\n${body}`;
      })
      .join("\n\n---\n\n");
  }
  return fallbackText || "No matching citations found.";
}

// Backwards-compatible helper
function formatSummaryBlobsAsGeneralContext(summaryBlobs = []) {
  return formatTemporalBlobs(summaryBlobs);
}

function loadCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    for (const [videoId, item] of Object.entries(raw)) {
      if (item && item.meta && Array.isArray(item.lines)) {
        const lineIndex = item.meta.isIndexed
          ? new LineInvertedIndex(item.lines, item.meta)
          : null;
        if (lineIndex) {
          item.meta.uniqueTermCount = Object.keys(lineIndex.termToLines).length;
        }
        const temporalBlobs = Array.isArray(item.temporalBlobs)
          ? item.temporalBlobs
          : (Array.isArray(item.summaryBlobs) && item.summaryBlobs.length === 10 ? item.summaryBlobs : []);
        const generalSummary = item.generalSummary || "";
        item.meta.temporalBlobCount = temporalBlobs.length;
        item.meta.hasGeneralSummary = Boolean(generalSummary);
        item.meta.summaryBlobCount = temporalBlobs.length;
        setVideoStoreEntry(videoId, {
          meta: item.meta,
          lines: item.lines,
          transcriptText: item.transcriptText || formatLinesAsPlainText(item.lines, item.meta),
          lineIndex,
          temporalBlobs,
          generalSummary,
          summaryBlobs: temporalBlobs
        });
      }
    }
    console.log(`[Vi Backend] Loaded ${videoStore.size} cached video transcript(s).`);
  } catch (err) {
    console.warn("[Vi Backend] Cache load warning:", err.message);
  }
}

function saveCache() {
  try {
    const out = {};
    for (const [videoId, entry] of videoStore.entries()) {
      out[videoId] = {
        meta: entry.meta,
        lines: entry.lines,
        transcriptText: entry.transcriptText,
        temporalBlobs: entry.temporalBlobs || [],
        generalSummary: entry.generalSummary || "",
        summaryBlobs: entry.temporalBlobs || entry.summaryBlobs || []
      };
    }
    const tmpFile = `${CACHE_FILE}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(out, null, 2), "utf8");
    fs.renameSync(tmpFile, CACHE_FILE);
  } catch (err) {
    console.warn("[Vi Backend] Cache save warning:", err.message);
  }
}

function makeVideoId(url) {
  return crypto.createHash("sha1").update(String(url)).digest("hex").slice(0, 16);
}

function decodeHtmlEntities(str) {
  if (!str) return "";
  return str
    .replace(/&amp;/gi, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function extractVodOrMp4Url(rawInput, baseOrigin = LEGISTAR_ORIGIN) {
  if (!rawInput) return null;
  const decoded = decodeHtmlEntities(rawInput);

  if (/^https?:\/\/[^/]*viebit\.com\//i.test(decoded)) {
    return decoded;
  }

  const urlParamMatch = decoded.match(/[?&]URL=([^&'"\s)]+)/i);
  if (urlParamMatch && urlParamMatch[1]) {
    try {
      const urlDecoded = decodeURIComponent(urlParamMatch[1]);
      const base64Decoded = Buffer.from(urlDecoded.trim(), "base64").toString("utf8");
      if (/^https?:\/\//i.test(base64Decoded)) {
        return base64Decoded;
      }
    } catch {
      // Fallback below
    }
  }

  const videoAspxMatch = decoded.match(/(Video\.aspx\?[^'"\s)]+)/i);
  if (videoAspxMatch && videoAspxMatch[1]) {
    return new URL(videoAspxMatch[1], baseOrigin || LEGISTAR_ORIGIN).toString();
  }

  const granicusMatch = decoded.match(/(https?:\/\/[^'"\s)]*granicus\.com\/[^'"\s)]+|MediaPlayer\.php\?[^'"\s)]+|\/player\/clip\/\d+[^'"\s)]*)/i);
  if (granicusMatch && granicusMatch[1]) {
    return new URL(granicusMatch[1], baseOrigin || "https://nystateassembly.granicus.com").toString();
  }

  if (/^https?:\/\//i.test(decoded)) {
    return decoded;
  }

  return null;
}

function extractYouTubeId(urlOrHtml = "") {
  const m = String(urlOrHtml).match(
    /(?:youtube\.com\/(?:watch\?v=|embed\/|live\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/i
  );
  return m ? m[1] : null;
}

function timedTextXmlToVtt(xmlText = "") {
  if (!xmlText) return "";
  if (xmlText.includes("WEBVTT") || xmlText.includes("-->")) return xmlText;

  const fmt = (sec) => {
    const s = Math.max(0, Number(sec) || 0);
    const hrs = Math.floor(s / 3600);
    const mins = Math.floor((s % 3600) / 60);
    const secs = (s % 60).toFixed(3).padStart(6, "0");
    return `${String(hrs).padStart(2, "0")}:${String(mins).padStart(2, "0")}:${secs}`;
  };

  const lines = ["WEBVTT", ""];
  // Match <p t="4971" d="4071">...</p> or <text start="4.97" dur="4.07">...</text>
  const pRegex = /<(?:p|text)\b([^>]*)>([\s\S]*?)<\/(?:p|text)>/gi;
  let match;
  while ((match = pRegex.exec(xmlText)) !== null) {
    const attrs = match[1] || "";
    const inner = match[2] || "";
    const tMatch = attrs.match(/\bt="(\d+)"/i);
    const dMatch = attrs.match(/\bd="(\d+)"/i);
    const startMatch = attrs.match(/\bstart="([\d.]+)"/i);
    const durMatch = attrs.match(/\bdur="([\d.]+)"/i);

    let startSec = 0;
    let durSec = 3;
    if (tMatch) {
      startSec = Number(tMatch[1]) / 1000;
      durSec = dMatch ? Number(dMatch[1]) / 1000 : 3;
    } else if (startMatch) {
      startSec = Number(startMatch[1]);
      durSec = durMatch ? Number(durMatch[1]) : 3;
    } else {
      continue;
    }

    const cleanText = decodeHtmlEntities(inner.replace(/<[^>]+>/g, " "));
    if (!cleanText) continue;

    lines.push(`${fmt(startSec)} --> ${fmt(startSec + durSec)}`);
    lines.push(cleanText);
    lines.push("");
  }

  return lines.length > 2 ? lines.join("\n") : "";
}

async function fetchYouTubeCaptionsFast(videoId) {
  const pResp = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      context: { client: { clientName: "ANDROID", clientVersion: "20.10.38" } },
      videoId
    })
  });
  if (!pResp.ok) return null;
  const pData = await pResp.json();
  const title = pData?.videoDetails?.title || null;
  const tracks = pData?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  if (tracks.length === 0) return { title, vttText: null };

  const enTrack = tracks.find((t) => /^en/i.test(t.languageCode)) || tracks[0];
  if (!enTrack || !enTrack.baseUrl) return { title, vttText: null };

  const capResp = await fetch(enTrack.baseUrl);
  if (!capResp.ok) return { title, vttText: null };
  const rawXml = await capResp.text();
  const vttText = timedTextXmlToVtt(rawXml);
  return { title, vttText };
}

async function resolveSelectedVideo(payload = {}) {
  let mp4Url = payload.mp4Url || null;
  let vttUrl = payload.vttUrl || null;
  let preScrapedVttText = null;
  let transcriptSourceLabel = null;
  let title = payload.title || null;
  const pageUrl = payload.pageUrl || null;
  let baseOrigin = LEGISTAR_ORIGIN;
  if (pageUrl && /^https?:\/\//i.test(pageUrl)) {
    try {
      baseOrigin = new URL(pageUrl).origin;
    } catch {
      // ignore
    }
  }

  const rawSource = payload.url || payload.vodUrl || payload.rawVideoAttr || mp4Url;
  if (!rawSource) {
    throw new Error("No video URL provided.");
  }

  let targetUrl = extractVodOrMp4Url(rawSource, baseOrigin);

  // Fast-Path 1: Legistar MeetingDetail.aspx (NYC Council, Westchester, Yonkers, Albany, Rochester, etc.)
  if (targetUrl && /MeetingDetail\.aspx/i.test(targetUrl)) {
    const legistarOrigin = new URL(targetUrl).origin;
    const pageResp = await fetch(targetUrl);
    if (!pageResp.ok) {
      throw new Error(`Failed to fetch meeting page (HTTP ${pageResp.status}).`);
    }
    const pageHtml = await pageResp.text();
    const nameMatch = pageHtml.match(/id="ctl00_ContentPlaceHolder1_hypName"[^>]*>([\s\S]*?)<\/a>/i);
    const dateMatch = pageHtml.match(/id="ctl00_ContentPlaceHolder1_lblDate"[^>]*>([\s\S]*?)<\/span>/i);
    if (nameMatch) {
      const committee = decodeHtmlEntities(nameMatch[1].replace(/<[^>]+>/g, ""));
      const dateStr = dateMatch ? decodeHtmlEntities(dateMatch[1].replace(/<[^>]+>/g, "")) : "";
      title = title || `${committee} (${dateStr})`.trim();
    }
    const videoMatch =
      pageHtml.match(/id="ctl00_ContentPlaceHolder1_hypVideo"[^>]*onclick="([^"]+)"/i) ||
      pageHtml.match(/onclick="([^"]*Video\.aspx\?[^"]+)"/i);
    if (!videoMatch) {
      throw new Error("No video link found on this Legistar meeting page.");
    }
    targetUrl = extractVodOrMp4Url(videoMatch[1], legistarOrigin);
  }

  // Fast-Path 2: Direct YouTube link or NYSenate.gov / NY.gov / NYC.gov page with embedded YouTube hearing
  let ytId = extractYouTubeId(targetUrl);
  if (
    !ytId &&
    targetUrl &&
    /(?:nysenate\.gov|nyassembly\.gov|ny\.gov|nyc\.gov|mta\.info)/i.test(targetUrl) &&
    !/\.mp4(\?.*)?$/i.test(targetUrl)
  ) {
    try {
      const govResp = await fetch(targetUrl);
      if (govResp.ok) {
        const govHtml = await govResp.text();
        const titleTag = govHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        if (titleTag && !title) {
          title = decodeHtmlEntities(titleTag[1].replace(/\s*\|.*$/, ""));
        }
        ytId = extractYouTubeId(govHtml);
        if (!ytId) {
          // Check if the NY Gov page embeds a Granicus or VieBit link
          const granicusEmbed = govHtml.match(/https?:\/\/[^\s"'<>]+granicus\.com\/(?:MediaPlayer\.php\?[^\s"'<>]+|player\/clip\/\d+[^\s"'<>]*)/i);
          if (granicusEmbed) targetUrl = decodeHtmlEntities(granicusEmbed[0]);
        }
      }
    } catch {
      // Fall through
    }
  }

  if (ytId) {
    const ytData = await fetchYouTubeCaptionsFast(ytId);
    if (ytData && ytData.vttText) {
      title = title || ytData.title || `NY Hearing (${ytId})`;
      mp4Url = `https://www.youtube.com/watch?v=${ytId}`;
      preScrapedVttText = ytData.vttText;
      transcriptSourceLabel = "Scraped NY Gov YouTube Captions (Innertube Fast-Path)";
      return {
        mp4Url,
        vttUrl: null,
        preScrapedVttText,
        transcriptSourceLabel,
        title,
        fileName: `${ytId}.mp4`
      };
    }
  }

  // Fast-Path 3, 4, 5: VieBit (NYC Council), Granicus (NY State Assembly, Westchester, etc.), Swagit, or direct MP4
  if (!mp4Url || /viebit\.com\/(vod|watch|player|embed)/i.test(mp4Url)) {
    const checkUrl = mp4Url && !/viebit\.com\/(vod|watch|player|embed)/i.test(mp4Url) ? mp4Url : targetUrl;
    if (/\.mp4(\?.*)?$/i.test(checkUrl) && !/viebit\.com\/vod\//i.test(checkUrl)) {
      mp4Url = checkUrl;
    } else {
      const resp = await fetch(checkUrl, { redirect: "follow" });
      if (!resp.ok) {
        throw new Error(`Failed to load video player page (HTTP ${resp.status}).`);
      }
      const finalUrl = resp.url || checkUrl;
      const finalOrigin = new URL(finalUrl).origin;
      const ct = resp.headers.get("content-type") || "";
      if (ct.includes("video/mp4")) {
        mp4Url = finalUrl;
      } else {
        const html = await resp.text();
        const htmlTitle = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        if (htmlTitle && !title) {
          const cleanT = decodeHtmlEntities(htmlTitle[1]);
          if (cleanT && !/^(?:video|granicus|viebit)$/i.test(cleanT)) {
            title = cleanT;
          }
        }

        // A) VieBit `pageConfig` exploit (NYC City Council & NY VieBit portals)
        const pageConfigMatch =
          html.match(/var\s+pageConfig\s*=\s*(\{[\s\S]*?\});\s*<\/script>/i) ||
          html.match(/var\s+pageConfig\s*=\s*(\{[^\n\r]*\});/i);

        if (pageConfigMatch && pageConfigMatch[1]) {
          try {
            const pageConfig = JSON.parse(pageConfigMatch[1]);
            const video = pageConfig.video || {};
            title = title || video.title;

            if (Array.isArray(video.src) && video.src.length > 0 && video.src[0].storage) {
              const storageBase = video.src[0].storage.replace(/\/otfp\//i, "/");
              const fName =
                video.title || (video.src[0].url ? video.src[0].url.split(",")[0] + ".mp4" : null);
              if (fName) {
                mp4Url = new URL(fName, storageBase).toString();
              }
            }
            if (!mp4Url && video.poster) {
              mp4Url = video.title
                ? new URL(video.title, video.poster).toString()
                : video.poster.replace(/\.jpg(\?.*)?$/i, ".mp4");
            }
            if (Array.isArray(video.textTracks) && video.textTracks.length > 0 && video.textTracks[0].src) {
              vttUrl = video.textTracks[0].src;
              transcriptSourceLabel = "Scraped VieBit Captions (.vtt)";
            }
          } catch (e) {
            console.warn("[Vi Backend] pageConfig parse error:", e.message);
          }
        }

        // B) Granicus exploit (NY State Assembly `nystateassembly.granicus.com`, Westchester, Yonkers, etc.)
        const granicusClipMatch =
          finalUrl.match(/[?&]clip_id=(\d+)/i) ||
          finalUrl.match(/\/player\/clip\/(\d+)/i) ||
          html.match(/\/videos\/(\d+)\/captions\.vtt/i);

        if (granicusClipMatch && granicusClipMatch[1] && /granicus\.com/i.test(finalUrl)) {
          const clipId = granicusClipMatch[1];
          vttUrl = vttUrl || `${finalOrigin}/videos/${clipId}/captions.vtt`;
          transcriptSourceLabel = "Scraped Granicus Captions (.vtt)";
        }

        // C) Swagit / HTML5 `<track>` / direct `.vtt` in HTML exploit
        if (!vttUrl) {
          const trackSrcMatch =
            html.match(/<track[^>]+src=["']([^"']+\.vtt(?:\?[^"']*)?)["']/i) ||
            html.match(/https?:\/\/[^\s"'<>\\]+\.vtt(?:\?[^\s"'<>\\]*)?/i);
          if (trackSrcMatch) {
            const rawVtt = trackSrcMatch[1] || trackSrcMatch[0];
            vttUrl = new URL(decodeHtmlEntities(rawVtt), finalOrigin).toString();
            transcriptSourceLabel = "Scraped Portal Captions (.vtt)";
          }
        }

        // Direct .mp4 in HTML (works for Granicus `archive-video.granicus.com/...mp4`, VieBit, etc.)
        if (!mp4Url) {
          const directMp4 = html.match(/https?:\/\/[^\s"'<>\\]+\.mp4(?:\?[^\s"'<>\\]*)?/i);
          if (directMp4) mp4Url = directMp4[0];
        }

        // Swagit `/videos/<id>/download` fallback for mp4Url
        if (!mp4Url && /swagit\.com\/videos\/(\d+)/i.test(finalUrl)) {
          const swId = finalUrl.match(/\/videos\/(\d+)/i)[1];
          mp4Url = `${finalOrigin}/videos/${swId}/download`;
        }

        // If we found a valid vttUrl on a gov player page even without a direct .mp4 URL, use finalUrl as video identifier
        if (!mp4Url && vttUrl) {
          mp4Url = finalUrl;
        }
      }
    }
  }

  if (!mp4Url) {
    throw new Error("Could not resolve video stream or caption track for this page.");
  }

  if (!vttUrl && /\.mp4(\?.*)?$/i.test(mp4Url)) {
    vttUrl = mp4Url.replace(/\.mp4(\?.*)?$/i, ".vtt");
  }

  const fileName = mp4Url.split("/").pop().split("?")[0] || "video.mp4";
  return {
    mp4Url,
    vttUrl,
    preScrapedVttText,
    transcriptSourceLabel,
    title: title || fileName,
    fileName
  };
}

/**
 * Strictly scrape exploitable caption tracks only (VieBit .vtt, Granicus .vtt, Swagit .vtt,
 * NY Gov YouTube Innertube captions, or companion .vtt/.srt files).
 * Never generates a transcript using an LLM or Whisper audio model.
 */
async function scrapeExploitableCaptionsOnly(resolved) {
  const { vttUrl, preScrapedVttText, transcriptSourceLabel } = resolved;

  if (preScrapedVttText) {
    return {
      transcriptSource: transcriptSourceLabel || "Scraped Video Captions (.vtt)",
      rawCaptionText: preScrapedVttText
    };
  }

  if (vttUrl) {
    try {
      const vttResp = await fetch(vttUrl);
      if (vttResp.ok) {
        const text = await vttResp.text();
        if (text && (text.includes("-->") || text.includes("WEBVTT"))) {
          return {
            transcriptSource: transcriptSourceLabel || "Scraped Video Captions (.vtt)",
            rawCaptionText: text
          };
        }
      }
    } catch {
      // Fall through
    }

    const srtUrl = vttUrl.replace(/\.vtt(\?.*)?$/i, ".srt");
    if (srtUrl !== vttUrl) {
      try {
        const srtResp = await fetch(srtUrl);
        if (srtResp.ok) {
          const text = await srtResp.text();
          if (text && text.includes("-->")) {
            return {
              transcriptSource: "Scraped Video Subtitles (.srt)",
              rawCaptionText: text
            };
          }
        }
      } catch {
        // Fall through
      }
    }
  }

  throw new Error(
    "No exploitable caption track found on this webpage. Vi only transcribes supported NY/NYC government videos with fast caption tracks (Legistar, VieBit, Granicus, Swagit, or NY Gov YouTube)."
  );
}

/**
 * Generate large summary blobs across the video during indexing.
 * These summary blobs serve as General Context that is ALWAYS fed to the LLM,
 * distinct from Supporting Evidence (the specific fetched lines + neighbors).
 */
/**
 * Unified LLM caller supporting Google Gemini (default: gemini-3.8-flash)
 * with transparent fallback to OpenAI.
 */
async function callLLM({
  systemPrompt = "",
  messages = [],
  jsonMode = false,
  temperature = 0.2,
  maxTokens = 900,
  provider,
  apiKey,
  model
}) {
  const defaultProvider = process.env.DEFAULT_LLM_PROVIDER || (process.env.GEMINI_API_KEY ? "gemini" : "openai");
  const effectiveProvider = provider || defaultProvider;

  const effectiveKey = (
    apiKey ||
    (effectiveProvider === "gemini" ? process.env.GEMINI_API_KEY : process.env.OPENAI_API_KEY) ||
    process.env.GEMINI_API_KEY ||
    process.env.OPENAI_API_KEY ||
    ""
  ).trim();

  if (!effectiveKey) return null;

  const isGemini =
    effectiveProvider === "gemini" ||
    effectiveKey.startsWith("AQ.") ||
    effectiveKey.startsWith("AIza") ||
    (Boolean(process.env.GEMINI_API_KEY) && !effectiveKey.startsWith("sk-"));

  if (isGemini) {
    const geminiModel =
      model && !model.includes("gpt")
        ? model
        : process.env.GEMINI_MODEL || "gemini-3.8-flash";

    const contents = [];
    for (const msg of messages) {
      contents.push({
        role: msg.role === "assistant" ? "model" : "user",
        parts: [{ text: String(msg.content || "") }]
      });
    }

    // Gemini 3.x Flash is a thinking model: internal reasoning tokens are billed against
    // maxOutputTokens. Reserve generous headroom so the visible answer is never truncated.
    const THINKING_HEADROOM_TOKENS = Number(process.env.GEMINI_THINKING_HEADROOM || 8192);
    const body = {
      contents,
      generationConfig: {
        temperature,
        maxOutputTokens: maxTokens + THINKING_HEADROOM_TOKENS,
        ...(jsonMode ? { responseMimeType: "application/json" } : {})
      }
    };
    if (systemPrompt) {
      body.systemInstruction = {
        parts: [{ text: systemPrompt }]
      };
    }

    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${effectiveKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      }
    );

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Gemini API error (${resp.status}): ${err.slice(0, 200)}`);
    }

    const data = await resp.json();
    const candidate = data?.candidates?.[0];
    if (candidate?.finishReason === "MAX_TOKENS") {
      console.warn(
        `[Vi Backend] Gemini hit MAX_TOKENS (thoughts=${data?.usageMetadata?.thoughtsTokenCount}, output=${data?.usageMetadata?.candidatesTokenCount}). Consider raising GEMINI_THINKING_HEADROOM.`
      );
    }
    return (candidate?.content?.parts || [])
      .filter((p) => !p.thought && typeof p.text === "string")
      .map((p) => p.text)
      .join("");
  }

  // Fallback to OpenAI if explicitly requested or with sk- key
  const openAiModel = model || "gpt-4o-mini";
  const openAiMessages = [];
  if (systemPrompt) openAiMessages.push({ role: "system", content: systemPrompt });
  for (const m of messages) {
    openAiMessages.push({ role: m.role, content: m.content });
  }

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${effectiveKey}`
    },
    body: JSON.stringify({
      model: openAiModel,
      temperature,
      max_tokens: maxTokens,
      ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
      messages: openAiMessages
    })
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`OpenAI error (${resp.status}): ${err.slice(0, 200)}`);
  }

  const data = await resp.json();
  return data?.choices?.[0]?.message?.content || "";
}

/**
 * Context Type 1: Static Temporal Context (10 Timeline Memory Blobs)
 * After transcribing, divides the lines into 10 approximately equal segments across the entire video.
 * Each blob summarizes the chronological milestones, active speakers, topics, and metrics in that decile.
 */
async function generateTemporalMemoryBlobs(lines, meta = {}, llmConfig = {}) {
  if (!Array.isArray(lines) || lines.length === 0) return [];

  const targetBlobs = 10;
  const numBlobs = Math.min(targetBlobs, lines.length);
  const segments = [];
  for (let i = 0; i < numBlobs; i++) {
    const startLine = Math.floor((i * lines.length) / numBlobs);
    const endLine = Math.min(lines.length - 1, Math.floor(((i + 1) * lines.length) / numBlobs) - 1);
    if (startLine > endLine) continue;
    const slice = lines.slice(startLine, endLine + 1);
    segments.push({
      blobIndex: i + 1,
      totalBlobs: numBlobs,
      startLine,
      endLine,
      lineCount: slice.length,
      startTimestamp: slice[0].timestamp,
      endTimestamp: slice[slice.length - 1].timestamp,
      slice
    });
  }

  const blobs = await Promise.all(
    segments.map(async (seg) => {
      const buildFallbackBlob = () => {
        const step = Math.max(1, Math.floor(seg.slice.length / 10));
        const sampled = [];
        for (let idx = 0; idx < seg.slice.length; idx += step) {
          sampled.push(seg.slice[idx].formatted);
        }
        return (
          `Timeline Segment ${seg.blobIndex}/${seg.totalBlobs} (${seg.startTimestamp} – ${seg.endTimestamp}, ${seg.lineCount} lines):\n` +
          sampled.join("\n")
        );
      };

      const segmentText = seg.slice
        .map((l) => l.formatted)
        .join("\n")
        .slice(0, 50000);

      try {
        const summary = await callLLM({
          systemPrompt:
            `You are generating Static Temporal Context Blob ${seg.blobIndex}/${seg.totalBlobs} (${seg.startTimestamp} to ${seg.endTimestamp}, covering lines ${seg.startLine}–${seg.endLine}) for the video "${meta.title || "Video"}".\n` +
            `This memory blob provides the LLM with the chronological timeline context of what occurs during this part of the video.\n` +
            `Write a dense, chronological summary (2-3 concise paragraphs or structured bullet points with approximate [HH:MM:SS] timestamps) covering:\n` +
            `1. Speakers, council members, commissioners, or witnesses active during this timeframe.\n` +
            `2. Key agenda items, questions, arguments, or policy topics introduced or discussed.\n` +
            `3. Key claims, statistics, funding numbers, or assertions made.\n` +
            `Be strictly factual and concise.`,
          messages: [{ role: "user", content: segmentText }],
          temperature: 0.1,
          maxTokens: 1200,
          provider: llmConfig.provider,
          apiKey: llmConfig.apiKey,
          model: llmConfig.model || process.env.GEMINI_MODEL || "gemini-3.8-flash"
        });

        return {
          blobIndex: seg.blobIndex,
          totalBlobs: seg.totalBlobs,
          startLine: seg.startLine,
          endLine: seg.endLine,
          lineCount: seg.lineCount,
          startTimestamp: seg.startTimestamp,
          endTimestamp: seg.endTimestamp,
          summary: (summary || "").trim() || buildFallbackBlob()
        };
      } catch (err) {
        console.warn(`[Vi Backend] Temporal blob ${seg.blobIndex} fallback:`, err.message);
        return {
          blobIndex: seg.blobIndex,
          totalBlobs: seg.totalBlobs,
          startLine: seg.startLine,
          endLine: seg.endLine,
          lineCount: seg.lineCount,
          startTimestamp: seg.startTimestamp,
          endTimestamp: seg.endTimestamp,
          summary: buildFallbackBlob()
        };
      }
    })
  );

  return blobs;
}

/**
 * Context Type 2: Static General Summary Blob
 * A comprehensive, static whole-video executive summary blob.
 * Runs in parallel with the 10 temporal memory blobs.
 */
async function generateStaticGeneralSummaryBlob(lines, meta = {}, llmConfig = {}) {
  if (!Array.isArray(lines) || lines.length === 0) return "";

  // Prepare whole-hearing transcript excerpt:
  // If lines are concise (<80,000 chars), use all formatted lines directly.
  // Otherwise, sample 500 lines evenly spaced across 0% to 100% of duration
  // so the whole arc of the meeting is represented within ~30,000 chars.
  const fullText = lines.map((l) => l.formatted).join("\n");
  let summaryInputText = fullText;
  if (fullText.length > 80000) {
    const step = Math.ceil(lines.length / 500);
    const sampled = [];
    for (let i = 0; i < lines.length; i += step) {
      sampled.push(lines[i].formatted);
    }
    summaryInputText = sampled.join("\n");
  }

  const buildFallbackSummary = () => {
    return (
      `Hearing Title: ${meta.title || "Government Video Hearing"}\n` +
      `Duration: ${meta.durationFormatted || "Unknown"} (${meta.lineCount || lines.length} transcript lines)\n` +
      `Overview: Official government hearing session covering public policy, oversight, and community testimony.`
    );
  };

  try {
    const summary = await callLLM({
      systemPrompt:
        `You are generating the Static General Summary Blob for the entire government video "${meta.title || "Video"}" (Duration: ${meta.durationFormatted || "Unknown"}).\n` +
        `This static general summary blob serves as high-level whole-video grounding for all subsequent Q&A.\n` +
        `Based on the video title, duration, and whole-hearing transcript excerpt below, write a comprehensive, structured executive summary covering:\n` +
        `1. OVERALL PURPOSE & MANDATE: The purpose of the hearing, presiding body, and legislative context.\n` +
        `2. PRESIDING OFFICIALS & KEY WITNESSES: Main committee chairs, agency commissioners, providers, and public advocates who testified.\n` +
        `3. MAJOR THEMES & DEBATES: The 3-5 biggest issues, debates, budget disputes, and policy concerns discussed across the entire hearing.\n` +
        `4. OUTCOMES, DATA & NEXT STEPS: Core statistics cited, key takeaways, and conclusions.\n` +
        `Format clearly with structured sections and bullet points. Be factual and authoritative.`,
      messages: [{ role: "user", content: summaryInputText }],
      temperature: 0.1,
      maxTokens: 2000,
      provider: llmConfig.provider,
      apiKey: llmConfig.apiKey,
      model: llmConfig.model || process.env.GEMINI_MODEL || "gemini-3.8-flash"
    });

    return (summary || "").trim() || buildFallbackSummary();
  } catch (err) {
    console.warn("[Vi Backend] General summary blob fallback:", err.message);
    return buildFallbackSummary();
  }
}

// Backwards-compatible alias for older callers
async function generateSummaryBlobs(lines, meta = {}, llmConfig = {}) {
  return generateTemporalMemoryBlobs(lines, meta, llmConfig);
}

/**
 * Scrape the video transcript from exploitable caption tracks (if not already cached) and,
 * if the transcript is large, build IN PARALLEL:
 *   1. The Term -> Line[] Inverted Index (`LineInvertedIndex`) for Supporting Evidence lookup
 *   2. 10 Static Temporal Memory Blobs (`temporalBlobs`) for Timeline Context
 *   3. 1 Static General Summary Blob (`generalSummary`) for Whole-Video Overview
 *
 * Maintains an LRU cache so static context is shared with all future requests for the same source.
 */
async function ensureVideoTranscribedAndIndexed(payload = {}, { indexIfLarge = true } = {}) {
  const canonicalSource = payload.videoId || payload.url || payload.mp4Url || payload.pageUrl || "";
  const normalizedKey = normalizeSourceKey(canonicalSource);
  const jobKey = `${normalizedKey}::${indexIfLarge ? "idx" : "raw"}`;

  if (inFlightJobs.has(jobKey)) {
    console.log(`[Vi Backend] Sharing in-flight static context generation for "${canonicalSource}" with concurrent request`);
    return inFlightJobs.get(jobKey);
  }

  // Fast path: if static context is already in the shared LRU cache, reuse it immediately!
  let existingEntry = videoStore.get(canonicalSource);
  if (
    existingEntry &&
    (!indexIfLarge ||
      (existingEntry.lineIndex &&
        Array.isArray(existingEntry.temporalBlobs) &&
        existingEntry.temporalBlobs.length === 10 &&
        existingEntry.generalSummary))
  ) {
    console.log(
      `[Vi Backend Cache HIT] Shared cached static context for "${existingEntry.meta.title}" (${existingEntry.meta.videoId})`
    );
    return existingEntry;
  }

  const jobPromise = (async () => {
    const resolved = await resolveSelectedVideo(payload);
    const videoId = makeVideoId(resolved.mp4Url);

    let entry = videoStore.get(videoId) || videoStore.get(resolved.mp4Url) || videoStore.get(payload.pageUrl);

    if (!entry) {
      const { transcriptSource, rawCaptionText } = await scrapeExploitableCaptionsOnly(resolved);
      const lines = parseCaptionTextToLines(rawCaptionText);
      if (lines.length === 0) {
        throw new Error("Scraped transcript was empty.");
      }

      const durationSec = lines[lines.length - 1].endSec || 0;
      const meta = {
        videoId,
        title: resolved.title,
        fileName: resolved.fileName,
        mp4Url: resolved.mp4Url,
        vttUrl: resolved.vttUrl,
        pageUrl: payload.pageUrl || null,
        transcriptSource,
        lineCount: lines.length,
        durationSec,
        durationFormatted: formatSeconds(durationSec, true),
        isIndexed: false,
        uniqueTermCount: 0,
        temporalBlobCount: 0,
        hasGeneralSummary: false,
        summaryBlobCount: 0,
        chunkCount: 0
      };

      const transcriptText = formatLinesAsPlainText(lines, meta);
      meta.charCount = transcriptText.length;

      entry = {
        meta,
        lines,
        transcriptText,
        lineIndex: null,
        temporalBlobs: [],
        generalSummary: "",
        summaryBlobs: []
      };
      setVideoStoreEntry(videoId, entry);
    }

    const isTooLarge = (entry.meta.charCount || entry.transcriptText.length) > LARGE_TRANSCRIPT_CHAR_THRESHOLD;

    if (indexIfLarge && isTooLarge) {
      // 1. Build simple Term -> Line[] Inverted Index if not already built
      if (!entry.lineIndex) {
        entry.lineIndex = new LineInvertedIndex(entry.lines, entry.meta);
      }
      const termCount = Object.keys(entry.lineIndex.termToLines).length;
      entry.meta.isIndexed = true;
      entry.meta.uniqueTermCount = termCount;
      entry.meta.chunkCount = termCount;

      // 2. Generate ALL Static Context components IN PARALLEL!
      const needsTemporalBlobs = !Array.isArray(entry.temporalBlobs) || entry.temporalBlobs.length !== 10;
      const needsGeneralSummary = !entry.generalSummary || !entry.generalSummary.trim();

      if (needsTemporalBlobs || needsGeneralSummary) {
        console.log(
          `[Vi Backend] Generating ALL static context components IN PARALLEL for "${entry.meta.title}"...`
        );
        const parallelTasks = [];

        if (needsTemporalBlobs) {
          parallelTasks.push(
            generateTemporalMemoryBlobs(entry.lines, entry.meta, {
              provider: payload.provider,
              apiKey: payload.apiKey,
              model: payload.model
            }).then((blobs) => {
              entry.temporalBlobs = blobs;
              entry.summaryBlobs = blobs;
              entry.meta.temporalBlobCount = blobs.length;
              entry.meta.summaryBlobCount = blobs.length;
            })
          );
        }

        if (needsGeneralSummary) {
          parallelTasks.push(
            generateStaticGeneralSummaryBlob(entry.lines, entry.meta, {
              provider: payload.provider,
              apiKey: payload.apiKey,
              model: payload.model
            }).then((summary) => {
              entry.generalSummary = summary;
              entry.meta.hasGeneralSummary = Boolean(summary);
            })
          );
        }

        // Run all 10 temporal memory blobs + 1 general summary blob concurrently
        await Promise.all(parallelTasks);
        console.log(
          `[Vi Backend] Finished parallel static context generation for "${entry.meta.title}": 10 temporal blobs + 1 general summary.`
        );
      }
    } else if (entry.lineIndex) {
      const termCount = Object.keys(entry.lineIndex.termToLines).length;
      entry.meta.isIndexed = true;
      entry.meta.uniqueTermCount = termCount;
      entry.meta.chunkCount = termCount;
      entry.meta.temporalBlobCount = Array.isArray(entry.temporalBlobs) ? entry.temporalBlobs.length : 0;
      entry.meta.summaryBlobCount = entry.meta.temporalBlobCount;
      entry.meta.hasGeneralSummary = Boolean(entry.generalSummary);
    }

    setVideoStoreEntry(videoId, entry);
    saveCache();
    return entry;
  })();

  inFlightJobs.set(jobKey, jobPromise);
  try {
    return await jobPromise;
  } finally {
    inFlightJobs.delete(jobKey);
  }
}

/**
 * Step 1 of Querying: Have Gemini 3.8 Flash generate fast fanout search terms for the inverted index.
 * Feeds both the General Summary and the Temporal Timeline Digest so the LLM knows exact speaker names & terms.
 */
async function generateFanoutTermsWithLLM(
  question,
  videoTitle,
  generalContextText = "",
  temporalContextText = "",
  llmConfig = {}
) {
  const baseTerms = extractTerms(question);

  try {
    const rawJson = await callLLM({
      systemPrompt:
        `You generate fast keyword fanout queries for a word-level inverted index of the video transcript "${videoTitle}".\n` +
        `Given a user's question (and the general video summary & timeline context below), return JSON {"terms": ["word1", "word2", ...]} with 8 to 15 single-word lowercase keywords, speaker last names, synonyms, acronyms, and specific nouns likely spoken in the transcript lines that provide supporting evidence for the question.\n\n` +
        (generalContextText ? `=== GENERAL VIDEO SUMMARY CONTEXT ===\n${generalContextText.slice(0, 4000)}\n\n` : "") +
        (temporalContextText ? `=== TEMPORAL TIMELINE DIGEST ===\n${temporalContextText.slice(0, 4000)}` : ""),
      messages: [{ role: "user", content: question }],
      jsonMode: true,
      temperature: 0,
      maxTokens: 400,
      provider: llmConfig.provider,
      apiKey: llmConfig.apiKey,
      model: llmConfig.model || process.env.GEMINI_MODEL || "gemini-3.8-flash"
    });

    if (!rawJson) return baseTerms;
    const parsed = JSON.parse(rawJson);
    if (Array.isArray(parsed.terms)) {
      return Array.from(new Set([...baseTerms, ...parsed.terms.map((t) => String(t).toLowerCase().trim())]));
    }
  } catch (err) {
    console.warn("[Vi Backend] Fanout term generation fallback:", err.message);
  }
  return baseTerms;
}

/**
 * Step 2 & 3 of Querying:
 * Assembles the THREE DISTINCT TYPES OF CONTEXT:
 *   1. Static Temporal Context (10 chronological timeline memory blobs)
 *   2. Static General Summary Context (the whole-video executive summary blob)
 *   3. Citations (fetched via fanout queries — MUST BE THE LAST TYPE OF MEMORY)
 * Feeds them to Gemini 3.8 Flash with a strictly defined system prompt explaining each context type.
 */
async function answerWithVi({ entry, question, history = [], llmConfig = {} }) {
  const { meta, lines, lineIndex, temporalBlobs = [], generalSummary = "" } = entry;

  const temporalContext = formatTemporalBlobs(temporalBlobs);
  const generalContext = formatGeneralSummary(generalSummary);
  let supportingEvidence = "";
  let fanoutTerms = [];
  let retrievalLatencyMs = 0;
  let windows = [];

  if (lineIndex) {
    // 1. LLM generates fast fanout query terms for the inverted index (informed by generalContext & temporalContext)
    fanoutTerms = await generateFanoutTermsWithLLM(question, meta.title, generalContext, temporalContext, llmConfig);

    // 2. Query the Term -> Line[] inverted index & grab +/- 8 neighboring lines around hits
    const lookup = lineIndex.fanoutQuery(fanoutTerms, {
      neighborRadius: 8,
      maxWindows: 10
    });
    supportingEvidence = lookup.rawContext;
    windows = lookup.windows;
    retrievalLatencyMs = lookup.latencyMs;
    console.log(
      `[Vi Backend] Fanout terms: [${fanoutTerms.join(", ")}] -> ${windows.length} supporting line windows (${retrievalLatencyMs}ms)`
    );
  } else {
    // Transcript is short enough to feed all timestamped lines directly as citations
    supportingEvidence = lines.map((l) => l.formatted).join("\n");
  }

  // Format Citations (Context Type 3) — MUST be the LAST type of memory in the prompt
  const citationsText = formatCitations(windows, supportingEvidence);

  const systemPrompt = [
    `You are Vi, an expert AI video assistant providing comprehensive, factual, and precisely cited analysis of the government video: "${meta.title}".`,
    ``,
    `You are provided with THREE DISTINCT TYPES OF CONTEXT in the following order:`,
    ``,
    `================================================================================`,
    `CONTEXT TYPE 1: STATIC TEMPORAL CONTEXT (10 Chronological Timeline Memory Blobs)`,
    `================================================================================`,
    `- WHAT IT IS: 10 chronological memory blobs dividing the entire video transcript into approximately equal line segments from beginning to end (0% to 100% of duration).`,
    `- HOW TO USE IT: Use this to maintain a general temporal understanding of the meeting (chronological flow, progression of agenda items, who spoke when, and how discussions evolved over time). Additionally, you MUST use this temporal context to add further context to the Citations (Context Type 3) when evaluating them and figuring out how to use them—identifying what phase of the hearing a cited excerpt comes from (e.g. opening remarks, agency testimony, council cross-examination, public testimony, or final vote), what dialogue led up to it, and how each citation fits into the broader timeline and narrative of the event.`,
    ``,
    `================================================================================`,
    `CONTEXT TYPE 2: STATIC GENERAL SUMMARY CONTEXT (Whole-Video Executive Summary)`,
    `================================================================================`,
    `- WHAT IT IS: An overarching high-level synthesis of the entire hearing/meeting.`,
    `- HOW TO USE IT: Use this for high-level grounding, broad contextual questions, understanding overall committee scope, key presiding officials, main agenda items, and the big-picture takeaways of the entire event.`,
    ``,
    `================================================================================`,
    `CONTEXT TYPE 3: CITATIONS (Fetched Verbatim Transcript Excerpts via Fanout Search)`,
    `================================================================================`,
    `- WHAT IT IS: Precise verbatim timestamped transcript lines and neighboring context fetched specifically for the user's question via query fanout search. THIS IS THE LAST TYPE OF MEMORY IN YOUR PROMPT.`,
    `- HOW TO USE IT: THIS IS YOUR PRIMARY SOURCE FOR VERBATIM EVIDENCE. Whenever you assert specific facts, statistics, dollar figures, direct quotes, or detailed claims, you MUST ground them in these citations and reference their exact timestamps like [HH:MM:SS] or [HH:MM:SS-HH:MM:SS]. When evaluating citations and figuring out how to use them, cross-reference them with the STATIC TEMPORAL CONTEXT (Context Type 1) to understand their chronological placement and surrounding context.`,
    ``,
    `--------------------------------------------------------------------------------`,
    `RULES & OUTPUT FORMAT:`,
    `- Ground all specific claims, statistics, and statements in the CITATIONS (Context Type 3).`,
    `- Use STATIC TEMPORAL CONTEXT (Context Type 1) to maintain a general temporal understanding of the meeting, but also to add further context on Citations (Context Type 3) when evaluating them and determining how to use them.`,
    `- Use STATIC GENERAL SUMMARY CONTEXT (Context Type 2) for big-picture framing or broad questions.`,
    `- Output MUST be structured in clean GitHub-flavored Markdown.`,
    `- Use "###" headers for sections, "-" bullet points or numbered lists, and **bold** for key names, organizations, metrics, and policy terms.`,
    `- Use "> " blockquotes for direct quotes, followed immediately by their exact timestamp citation.`,
    `- Cite timestamps in square brackets like [00:12:34] or [00:12:34-00:13:02]. Never wrap them in backticks or markdown links.`,
    `- Every specific assertion must cite its timestamp from Context Type 3.`,
    ``,
    `================================================================================`,
    `CONTEXT TYPE 1: STATIC TEMPORAL CONTEXT (10 TIMELINE MEMORY BLOBS)`,
    `================================================================================`,
    temporalContext || "(Short video — timeline represented in full transcript lines below.)",
    ``,
    `================================================================================`,
    `CONTEXT TYPE 2: STATIC GENERAL SUMMARY CONTEXT (WHOLE-VIDEO SUMMARY BLOB)`,
    `================================================================================`,
    generalContext || "(Short video — general summary represented in full transcript lines below.)",
    ``,
    `================================================================================`,
    `CONTEXT TYPE 3: CITATIONS (FETCHED VIA FANOUT QUERIES — PRIMARY VERBATIM EVIDENCE)`,
    `================================================================================`,
    citationsText
  ].join("\n");

  const conversationMessages = [
    ...history.slice(-6).map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: question }
  ];

  try {
    const answer = await callLLM({
      systemPrompt,
      messages: conversationMessages,
      temperature: 0.2,
      maxTokens: 4096,
      provider: llmConfig.provider,
      apiKey: llmConfig.apiKey,
      model: llmConfig.model || process.env.GEMINI_MODEL || "gemini-3.8-flash"
    });

    if (answer) {
      return {
        answer,
        fanoutTerms,
        temporalBlobCount: temporalBlobs.length,
        hasGeneralSummary: Boolean(generalSummary),
        summaryBlobCount: temporalBlobs.length,
        windows,
        retrievalLatencyMs
      };
    }
  } catch (err) {
    console.error("[Vi Backend] LLM generation error:", err.message);
    throw err;
  }

  // Fallback if no LLM key configured
  return {
    answer: `General Context:\n${generalContext.slice(0, 800)}\n\nSupporting Evidence Lines:\n${supportingEvidence.slice(0, 1200)}`,
    fanoutTerms,
    temporalBlobCount: temporalBlobs.length,
    hasGeneralSummary: Boolean(generalSummary),
    summaryBlobCount: temporalBlobs.length,
    windows,
    retrievalLatencyMs
  };
}

loadCache();

function sendJson(res, status, payload) {
  if (!res || res.writableEnded || res.destroyed) return;
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Private-Network": "true"
  });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 10 * 1024 * 1024) reject(new Error("Payload too large"));
    });
    req.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    return sendJson(res, 200, { ok: true });
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || `localhost:${PORT}`}`);
  const pathname = parsedUrl.pathname;
  console.log(`[Vi Backend] ${req.method} ${pathname}`);

  try {
    if (req.method === "GET" && (pathname === "/" || pathname === "/api/health" || pathname === "/healthz")) {
      return sendJson(res, 200, {
        ok: true,
        service: "vi-backend",
        status: "online",
        uptimeSec: Math.floor(process.uptime()),
        cachedVideos: videoStore.size
      });
    }

    // 1. Download Transcription endpoint
    if (req.method === "POST" && pathname === "/api/transcribe") {
      const body = await readJsonBody(req);
      const entry = await ensureVideoTranscribedAndIndexed(body, { indexIfLarge: false });
      const safeName =
        (entry.meta.title || "video")
          .replace(/[^a-zA-Z0-9_-]+/g, "_")
          .replace(/^_|_$/g, "")
          .slice(0, 80) + "_transcription.txt";

      return sendJson(res, 200, {
        ok: true,
        videoId: entry.meta.videoId,
        title: entry.meta.title,
        filename: safeName,
        lineCount: entry.meta.lineCount,
        transcriptText: entry.transcriptText
      });
    }

    // 2. Initialize "Ask Vi" endpoint (scrapes transcript & builds Term->Line[] index + summary blobs if large)
    if (
      req.method === "POST" &&
      (pathname === "/api/vi/init" || pathname === "/api/videos/ingest")
    ) {
      const body = await readJsonBody(req);
      const entry = await ensureVideoTranscribedAndIndexed(body, { indexIfLarge: true });
      return sendJson(res, 200, {
        ok: true,
        video: entry.meta
      });
    }

    // 3. "Ask Vi" Chat endpoint (LLM fanout terms -> Inverted Index lines + neighbors + Summary Blobs -> LLM answer)
    if (req.method === "POST" && (pathname === "/api/vi/chat" || pathname === "/api/chat")) {
      const body = await readJsonBody(req);
      const { videoId, message, history = [], llmConfig = {} } = body;

      const sourceKey = videoId || body.url || body.mp4Url || body.pageUrl;
      let entry = sourceKey ? videoStore.get(sourceKey) : null;

      if (!entry && (body.url || body.mp4Url || body.pageUrl || videoId)) {
        entry = await ensureVideoTranscribedAndIndexed(body, { indexIfLarge: true });
      }

      if (
        !entry ||
        !entry.lineIndex ||
        !Array.isArray(entry.temporalBlobs) ||
        entry.temporalBlobs.length !== 10 ||
        !entry.generalSummary
      ) {
        if (entry) {
          entry = await ensureVideoTranscribedAndIndexed(
            { url: entry.meta.mp4Url, pageUrl: entry.meta.pageUrl, videoId: entry.meta.videoId },
            { indexIfLarge: true }
          );
        } else {
          return sendJson(res, 404, {
            ok: false,
            error: "Video transcription not initialized yet. Click Ask Vi first."
          });
        }
      }

      const result = await answerWithVi({
        entry,
        question: String(message || ""),
        history,
        llmConfig
      });

      return sendJson(res, 200, {
        ok: true,
        videoId: entry.meta.videoId,
        answer: result.answer,
        fanoutTerms: result.fanoutTerms,
        temporalBlobCount: result.temporalBlobCount || (entry.temporalBlobs ? entry.temporalBlobs.length : 0),
        hasGeneralSummary: Boolean(result.hasGeneralSummary || entry.generalSummary),
        citationCount: result.windows ? result.windows.length : 0,
        summaryBlobCount: result.summaryBlobCount,
        windows: result.windows,
        retrievalLatencyMs: result.retrievalLatencyMs
      });
    }

    return sendJson(res, 404, { ok: false, error: `Not found: ${pathname}` });
  } catch (err) {
    console.error("[Vi Backend Error]", err.message);
    return sendJson(res, 400, { ok: false, error: err.message || String(err) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`🚀 Vi Production Backend listening on http://${HOST}:${PORT}`);
});

function gracefulShutdown(signal) {
  console.log(`[Vi Backend] Received ${signal}, saving cache and shutting down...`);
  saveCache();
  server.close(() => {
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

