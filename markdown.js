/**
 * markdown.js — Lightweight, robust, and secure Markdown-to-HTML parser for Vi.
 * Supports:
 *   - Headers (#, ##, ###, ####)
 *   - Unordered & Ordered lists (nested support)
 *   - Tables (| Col 1 | Col 2 |)
 *   - Blockquotes (> Quote)
 *   - Fenced code blocks (```lang ... ```)
 *   - Inline bold (**), italics (*), strikethrough (~~), inline code (`)
 *   - Interactive Timestamp Badges ([HH:MM:SS]) with click-to-seek support
 *   - Safe HTML escaping to prevent XSS
 */

(() => {
  function escapeHtml(str) {
    if (!str) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function parseTimestampToSeconds(ts) {
    if (!ts) return 0;
    const clean = ts.split(/[-–—]/)[0].trim();
    const parts = clean.split(":").map(Number);
    if (parts.some((n) => Number.isNaN(n))) return 0;
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return parts[0] || 0;
  }

  function parseInline(text) {
    if (!text) return "";

    // 1. Inline code: `code`
    let out = text.replace(/`([^`]+)`/g, (m, code) => `<code>${code}</code>`);

    // 2. Bold + Italic: ***text***
    out = out.replace(/\*\*\*([^*]+)\*\*\*/g, "<strong><em>$1</em></strong>");

    // 3. Bold: **text** or __text__
    out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    out = out.replace(/__([^_]+)__/g, "<strong>$1</strong>");

    // 4. Italic: *text* or _text_
    out = out.replace(/\*([^*]+)\*/g, "<em>$1</em>");
    out = out.replace(/\b_([^_]+)_\b/g, "<em>$1</em>");

    // 5. Strikethrough: ~~text~~
    out = out.replace(/~~([^~]+)~~/g, "<del>$1</del>");

    // 6. Links: [label](url)
    out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (m, label, url) => {
      return `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    });

    // 7. Interactive Video Timestamp Badges: [HH:MM:SS], [HH:MM:SS-HH:MM:SS], or comma-separated groups
    const TS = "\\d{1,2}:\\d{2}(?::\\d{2})?";
    const TS_RANGE = `${TS}(?:\\s*[-–—]\\s*${TS})?`;
    const citationRe = new RegExp(`\\[(${TS_RANGE}(?:\\s*[,;]\\s*${TS_RANGE})*)\\]`, "g");
    out = out.replace(citationRe, (m, group) => {
      return group
        .split(/\s*[,;]\s*/)
        .filter(Boolean)
        .map((ts) => {
          const sec = parseTimestampToSeconds(ts);
          return `<button type="button" class="vi-ts-badge" data-seconds="${sec}" data-timestamp="${ts}" title="Jump to ${ts}"><span class="vi-ts-icon">⏱</span>${ts}</button>`;
        })
        .join("");
    });

    return out;
  }

  function renderMarkdown(md) {
    if (!md) return "";

    // Normalize newlines and escape raw HTML
    const rawLines = String(md).replace(/\r\n/g, "\n").split("\n");
    const escapedLines = rawLines.map(escapeHtml);

    const htmlTokens = [];
    let i = 0;

    while (i < escapedLines.length) {
      const line = escapedLines[i];
      const trimmed = line.trim();

      // Empty line
      if (!trimmed) {
        i++;
        continue;
      }

      // 1. Fenced Code Block: ```lang
      if (trimmed.startsWith("```")) {
        const lang = trimmed.slice(3).trim();
        const codeLines = [];
        i++;
        while (i < escapedLines.length && !escapedLines[i].trim().startsWith("```")) {
          codeLines.push(escapedLines[i]);
          i++;
        }
        i++; // skip closing ```
        htmlTokens.push(
          `<pre class="vi-code-block"><code class="${lang ? `language-${lang}` : ""}">${codeLines.join("\n")}</code></pre>`
        );
        continue;
      }

      // 2. Horizontal Rule: --- or ***
      if (/^(\-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
        htmlTokens.push(`<hr class="vi-hr" />`);
        i++;
        continue;
      }

      // 3. Headings: #, ##, ###, ####, #####, ######
      const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
      if (headingMatch) {
        const level = headingMatch[1].length;
        const text = parseInline(headingMatch[2]);
        htmlTokens.push(`<h${level} class="vi-h${level}">${text}</h${level}>`);
        i++;
        continue;
      }

      // 4. Blockquotes: > Quote
      if (trimmed.startsWith("&gt;") || trimmed.startsWith(">")) {
        const quoteLines = [];
        while (i < escapedLines.length) {
          const l = escapedLines[i].trim();
          if (l.startsWith("&gt;")) {
            quoteLines.push(l.replace(/^&gt;\s?/, ""));
            i++;
          } else if (l.startsWith(">")) {
            quoteLines.push(l.replace(/^>\s?/, ""));
            i++;
          } else if (l === "") {
            break;
          } else {
            // Continued quote line
            quoteLines.push(l);
            i++;
          }
        }
        const innerText = quoteLines.map((l) => parseInline(l)).join("<br/>");
        htmlTokens.push(`<blockquote class="vi-blockquote">${innerText}</blockquote>`);
        continue;
      }

      // 5. GFM Tables: | Col 1 | Col 2 |
      if (trimmed.startsWith("|") && trimmed.endsWith("|") && i + 1 < escapedLines.length && /^[|\s-:]+$/.test(escapedLines[i + 1].trim())) {
        const headerCells = trimmed
          .slice(1, -1)
          .split("|")
          .map((c) => parseInline(c.trim()));
        i += 2; // skip header and separator row

        const rows = [];
        while (i < escapedLines.length && escapedLines[i].trim().startsWith("|")) {
          const cells = escapedLines[i]
            .trim()
            .slice(1, -1)
            .split("|")
            .map((c) => parseInline(c.trim()));
          rows.push(cells);
          i++;
        }

        const thead = `<thead><tr>${headerCells.map((h) => `<th>${h}</th>`).join("")}</tr></thead>`;
        const tbody = `<tbody>${rows
          .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`)
          .join("")}</tbody>`;

        htmlTokens.push(`<div class="vi-table-wrap"><table class="vi-table">${thead}${tbody}</table></div>`);
        continue;
      }

      // 6. Lists: Unordered (- or *) or Ordered (1.) with one level of nested sub-lists
      const isUnordered = /^[\*\-\+]\s+/.test(trimmed);
      const isOrdered = /^\d+\.\s+/.test(trimmed);

      if (isUnordered || isOrdered) {
        const tag = isOrdered ? "ol" : "ul";
        const startNum = isOrdered ? parseInt(trimmed, 10) || 1 : 1;
        const baseIndent = line.length - line.trimStart().length;
        const items = []; // { html, subTag, subItems[] }

        const topRe = isOrdered ? /^\d+\.\s+(.*)$/ : /^[\*\-\+]\s+(.*)$/;

        while (i < escapedLines.length) {
          const l = escapedLines[i];
          const t = l.trim();

          if (!t) {
            // Allow blank lines inside a list if the list continues afterwards
            let j = i + 1;
            while (j < escapedLines.length && !escapedLines[j].trim()) j++;
            if (j < escapedLines.length) {
              const nl = escapedLines[j];
              const nIndent = nl.length - nl.trimStart().length;
              const nt = nl.trim();
              if ((nIndent <= baseIndent && topRe.test(nt)) || (nIndent > baseIndent && items.length > 0)) {
                i = j;
                continue;
              }
            }
            break;
          }

          const indent = l.length - l.trimStart().length;
          const topMatch = t.match(topRe);

          if (indent <= baseIndent && topMatch) {
            items.push({ html: parseInline(topMatch[1]), subTag: null, subItems: [] });
            i++;
            continue;
          }

          if (indent > baseIndent && items.length > 0) {
            const last = items[items.length - 1];
            const subU = t.match(/^[\*\-\+]\s+(.*)$/);
            const subO = t.match(/^\d+\.\s+(.*)$/);
            if (subU || subO) {
              last.subTag = last.subTag || (subO ? "ol" : "ul");
              last.subItems.push(parseInline((subU || subO)[1]));
            } else if (last.subItems.length > 0) {
              last.subItems[last.subItems.length - 1] += "<br/>" + parseInline(t);
            } else {
              last.html += "<br/>" + parseInline(t);
            }
            i++;
            continue;
          }

          break;
        }

        const itemsHtml = items
          .map((it) => {
            const sub = it.subItems.length
              ? `<${it.subTag} class="vi-list vi-${it.subTag}">${it.subItems.map((s) => `<li>${s}</li>`).join("")}</${it.subTag}>`
              : "";
            return `<li>${it.html}${sub}</li>`;
          })
          .join("");

        const startAttr = isOrdered && startNum !== 1 ? ` start="${startNum}"` : "";
        htmlTokens.push(`<${tag} class="vi-list vi-${tag}"${startAttr}>${itemsHtml}</${tag}>`);
        continue;
      }

      // 7. Regular Paragraph
      const paraLines = [];
      while (i < escapedLines.length && escapedLines[i].trim() !== "") {
        const nextTrimmed = escapedLines[i].trim();
        if (
          nextTrimmed.startsWith("```") ||
          nextTrimmed.match(/^#{1,6}\s+/) ||
          nextTrimmed.startsWith("&gt;") ||
          nextTrimmed.startsWith(">") ||
          /^[\*\-\+]\s+/.test(nextTrimmed) ||
          /^\d+\.\s+/.test(nextTrimmed) ||
          (nextTrimmed.startsWith("|") && nextTrimmed.endsWith("|"))
        ) {
          break;
        }
        paraLines.push(nextTrimmed);
        i++;
      }

      if (paraLines.length > 0) {
        const paraText = paraLines.map((l) => parseInline(l)).join("<br/>");
        htmlTokens.push(`<p class="vi-p">${paraText}</p>`);
      }
    }

    return htmlTokens.join("\n");
  }

  // Export to window/global scope or Node.js module
  if (typeof window !== "undefined") {
    window.ViMarkdown = {
      render: renderMarkdown,
      parseTimestampToSeconds
    };
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      renderMarkdown,
      parseTimestampToSeconds
    };
  }
})();
