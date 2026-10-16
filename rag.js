// rag.js — Simple Term -> Line Inverted Index with Neighbor Line Expansion
// 1. Parses captions into timestamped lines: [{ lineIndex, startSec, timestamp, text, formatted }]
// 2. Builds a simple inverted index: Map<term, number[]> mapping each word to the line numbers it appears on
// 3. Given fanout query terms from the LLM, looks up matching lines, expands +/- neighborWindow lines
//    around the best hits, merges overlapping ranges, and returns raw timestamped lines for the LLM.

(() => {
  const STOPWORDS = new Set([
    "a", "about", "above", "after", "again", "against", "all", "am", "an", "and", "any", "are",
    "as", "at", "be", "because", "been", "before", "being", "below", "between", "both", "but",
    "by", "can", "could", "did", "do", "does", "doing", "down", "during", "each", "few", "for",
    "from", "further", "had", "has", "have", "having", "he", "her", "here", "hers", "herself",
    "him", "himself", "his", "how", "i", "if", "in", "into", "is", "it", "its", "itself", "just",
    "me", "more", "most", "my", "myself", "no", "nor", "not", "of", "off", "on", "once", "only",
    "or", "other", "ought", "our", "ours", "ourselves", "out", "over", "own", "same", "she",
    "should", "so", "some", "such", "than", "that", "the", "their", "theirs", "them", "themselves",
    "then", "there", "these", "they", "this", "those", "through", "to", "too", "under", "until",
    "up", "very", "was", "we", "were", "what", "when", "where", "which", "while", "who", "whom",
    "why", "with", "would", "you", "your", "yours", "yourself", "yourselves", "uh", "um"
  ]);

  function parseTimestampToSeconds(ts) {
    if (typeof ts === "number") return ts;
    if (!ts || typeof ts !== "string") return 0;
    const clean = ts.trim().replace(",", ".");
    const parts = clean.split(":").map(Number);
    if (parts.some((n) => Number.isNaN(n))) return 0;
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return parts[0] || 0;
  }

  function formatSeconds(sec, forceHours = true) {
    const total = Math.max(0, Math.floor(Number(sec) || 0));
    const hrs = Math.floor(total / 3600);
    const mins = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    if (hrs > 0 || forceHours) {
      return `${String(hrs).padStart(2, "0")}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
    }
    return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }

  /**
   * Normalize a word/term for the inverted index.
   */
  function normalizeTerm(word) {
    if (!word) return "";
    const w = word.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (w.length <= 1 || STOPWORDS.has(w)) return "";
    // Basic plural/suffix normalization so "shelters" and "shelter" map to the same term key
    if (w.length > 4) {
      if (w.endsWith("ies")) return w.slice(0, -3) + "y";
      if (w.endsWith("ing")) return w.slice(0, -3);
      if (w.endsWith("ed")) return w.slice(0, -2);
      if (w.endsWith("es")) return w.slice(0, -2);
      if (w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
    }
    return w;
  }

  function extractTerms(text) {
    if (!text) return [];
    const words = String(text)
      .toLowerCase()
      .replace(/['’]/g, "")
      .split(/[^a-z0-9]+/);
    const terms = [];
    for (const w of words) {
      const norm = normalizeTerm(w);
      if (norm) terms.push(norm);
    }
    return terms;
  }

  /**
   * Parse WebVTT or SRT caption text into deduplicated timestamped lines:
   * [{ lineIndex, startSec, endSec, timestamp, text, formatted }]
   */
  function parseCaptionTextToLines(rawText) {
    if (!rawText || typeof rawText !== "string") return [];
    const rawLines = rawText.split(/\r?\n/);
    const cues = [];

    let currentStart = null;
    let currentEnd = null;
    let buffer = [];
    let lastLineText = "";

    const flushCue = () => {
      if (currentStart === null || buffer.length === 0) {
        buffer = [];
        return;
      }
      const joined = buffer.join(" ").replace(/\s+/g, " ").trim();
      if (joined && joined !== lastLineText) {
        cues.push({
          startSec: currentStart,
          endSec: currentEnd !== null ? currentEnd : currentStart + 3,
          text: joined
        });
        lastLineText = joined;
      }
      buffer = [];
    };

    for (let i = 0; i < rawLines.length; i++) {
      const line = rawLines[i].trim();
      if (
        !line ||
        line === "WEBVTT" ||
        line.startsWith("X-TIMESTAMP-MAP") ||
        line.startsWith("NOTE") ||
        line.startsWith("STYLE") ||
        /^\d+$/.test(line)
      ) {
        if (!line) flushCue();
        continue;
      }

      if (line.includes("-->")) {
        flushCue();
        const parts = line.split("-->");
        currentStart = parseTimestampToSeconds(parts[0].trim());
        currentEnd = parseTimestampToSeconds((parts[1] || "").trim().split(/\s+/)[0]);
        continue;
      }

      const cleanLine = line
        .replace(/<[^>]+>/g, " ")
        .replace(/^>+\s*/, "")
        .replace(/\s+/g, " ")
        .trim();

      if (cleanLine && cleanLine !== lastLineText) {
        buffer.push(cleanLine);
      }
    }
    flushCue();

    // Normalize ALL-CAPS broadcast captions to readable case
    const sample = cues.slice(0, 30).map((c) => c.text).join(" ");
    const upperRatio =
      sample.length > 0
        ? (sample.match(/[A-Z]/g) || []).length / Math.max(1, (sample.match(/[A-Za-z]/g) || []).length)
        : 0;

    const acronyms = new Set([
      "NYC", "NYPD", "DYCD", "ACS", "DHS", "HRA", "DOE", "OMB", "HUD", "LGBTQ", "RHY", "FY", "CEO", "US", "USA"
    ]);

    return cues.map((cue, idx) => {
      let text = cue.text;
      if (upperRatio > 0.85) {
        text = text.toLowerCase().replace(/\b([a-z]+)\b/g, (w) => {
          const up = w.toUpperCase();
          return acronyms.has(up) ? up : w;
        });
      }
      const timestamp = formatSeconds(cue.startSec, true);
      return {
        lineIndex: idx,
        startSec: cue.startSec,
        endSec: cue.endSec,
        timestamp,
        text,
        formatted: `[${timestamp}] ${text}`
      };
    });
  }

  /**
   * LineInvertedIndex:
   * Maps each normalized term -> array of line numbers [lineIndex_1, lineIndex_2, ...]
   */
  class LineInvertedIndex {
    constructor(lines = [], metadata = {}) {
      this.lines = lines;
      this.metadata = metadata;
      // term -> number[] (sorted list of line indices where term appears)
      this.termToLines = Object.create(null);
      this._build();
    }

    _build() {
      for (let i = 0; i < this.lines.length; i++) {
        const uniqueTerms = new Set(extractTerms(this.lines[i].text));
        for (const term of uniqueTerms) {
          if (!this.termToLines[term]) {
            this.termToLines[term] = [];
          }
          this.termToLines[term].push(i);
        }
      }
    }

    /**
     * Execute fast fanout queries against the inverted index for a list of search terms/phrases,
     * score matching lines, expand +/- neighborRadius lines around each top hit,
     * merge overlapping line windows, and return raw timestamped lines ready for the LLM.
     */
    fanoutQuery(fanoutTerms = [], options = {}) {
      const startMs = performance.now();
      const neighborRadius = options.neighborRadius ?? 8; // +/- 8 lines around each hit
      const maxWindows = options.maxWindows ?? 10;        // up to 10 contiguous line windows
      const totalLines = this.lines.length;

      if (totalLines === 0) {
        return {
          rawContext: "",
          windows: [],
          termHits: {},
          latencyMs: 0
        };
      }

      // Normalize all fanout query terms
      const queryTerms = new Set();
      for (const raw of fanoutTerms) {
        for (const t of extractTerms(raw)) {
          queryTerms.add(t);
        }
      }

      const lineScores = new Float64Array(totalLines);
      const termHits = {};

      // 1. Fanout lookup in the inverted index: term -> list of line indices
      for (const term of queryTerms) {
        const hitLineIndices = this.termToLines[term] || [];
        termHits[term] = hitLineIndices.length;
        if (hitLineIndices.length === 0) continue;

        // Rarer terms get higher weight (IDF-style weight)
        const weight = Math.log(1 + totalLines / hitLineIndices.length);
        for (let k = 0; k < hitLineIndices.length; k++) {
          const lineIdx = hitLineIndices[k];
          lineScores[lineIdx] += weight;
          // Also give a small proximity boost to immediate +/- 2 neighbor lines
          // so clusters of query terms across adjacent lines score highest!
          for (let offset = -2; offset <= 2; offset++) {
            if (offset === 0) continue;
            const adj = lineIdx + offset;
            if (adj >= 0 && adj < totalLines) {
              lineScores[adj] += weight * 0.35;
            }
          }
        }
      }

      // 2. Rank lines by fanout hit score
      const scoredIndices = [];
      for (let i = 0; i < totalLines; i++) {
        if (lineScores[i] > 0) {
          scoredIndices.push(i);
        }
      }
      scoredIndices.sort((a, b) => lineScores[b] - lineScores[a]);

      // 3. Pick top non-overlapping seed lines and expand +/- neighborRadius lines around each
      const selectedRanges = [];
      const coveredCenters = new Set();

      for (const centerIdx of scoredIndices) {
        if (selectedRanges.length >= maxWindows) break;
        if (coveredCenters.has(centerIdx)) continue;

        const startLine = Math.max(0, centerIdx - neighborRadius);
        const endLine = Math.min(totalLines - 1, centerIdx + neighborRadius);

        for (let c = startLine; c <= endLine; c++) {
          coveredCenters.add(c);
        }

        selectedRanges.push({
          startLine,
          endLine,
          peakScore: Number(lineScores[centerIdx].toFixed(2))
        });
      }

      // Fallback if no lexical terms matched (e.g. "summarize the video"):
      // sample evenly spaced windows across the transcript
      if (selectedRanges.length === 0) {
        const samples = Math.min(maxWindows, Math.ceil(totalLines / (neighborRadius * 2 + 1)));
        for (let s = 0; s < samples; s++) {
          const centerIdx = Math.min(
            totalLines - 1,
            Math.floor(((s + 0.5) / samples) * totalLines)
          );
          selectedRanges.push({
            startLine: Math.max(0, centerIdx - neighborRadius),
            endLine: Math.min(totalLines - 1, centerIdx + neighborRadius),
            peakScore: 0
          });
        }
      }

      // 4. Sort ranges chronologically by line number and merge overlapping/adjacent windows
      selectedRanges.sort((a, b) => a.startLine - b.startLine);
      const mergedWindows = [];
      for (const r of selectedRanges) {
        const prev = mergedWindows[mergedWindows.length - 1];
        if (prev && r.startLine <= prev.endLine + 2) {
          prev.endLine = Math.max(prev.endLine, r.endLine);
          prev.peakScore = Math.max(prev.peakScore, r.peakScore);
        } else {
          mergedWindows.push({ ...r });
        }
      }

      // 5. Build raw timestamped line blocks for the LLM
      const windows = mergedWindows.map((w, idx) => {
        const slice = this.lines.slice(w.startLine, w.endLine + 1);
        return {
          windowId: idx + 1,
          startLine: w.startLine,
          endLine: w.endLine,
          startTimestamp: slice[0]?.timestamp || "00:00:00",
          endTimestamp: slice[slice.length - 1]?.timestamp || "00:00:00",
          peakScore: w.peakScore,
          lines: slice.map((l) => l.formatted)
        };
      });

      const rawContext = windows
        .map(
          (w) =>
            `--- Transcript Lines ${w.startLine + 1} to ${w.endLine + 1} (${w.startTimestamp} - ${w.endTimestamp}) ---\n` +
            w.lines.join("\n")
        )
        .join("\n\n");

      const latencyMs = Number((performance.now() - startMs).toFixed(2));
      return {
        rawContext,
        windows,
        termHits,
        latencyMs
      };
    }
  }

  const api = {
    parseTimestampToSeconds,
    formatSeconds,
    normalizeTerm,
    extractTerms,
    parseCaptionTextToLines,
    // Keep alias for compatibility
    parseCaptionTextToCues: parseCaptionTextToLines,
    LineInvertedIndex
  };

  if (typeof self !== "undefined") self.VideoRAGEngine = api;
  if (typeof window !== "undefined") window.VideoRAGEngine = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
