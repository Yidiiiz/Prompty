/**
 * shared/markdown.ts — a deliberately small, safe markdown renderer for note
 * cards, the fullscreen note modal, and the reply-quote popover. All input is
 * HTML-escaped first, then a limited grammar is applied: fenced/inline code,
 * headers, bold/italic, ==highlight==, ~~strike~~, links (http/https only),
 * unordered/ordered lists, tables, blockquotes, paragraphs.
 *
 * It mirrors the constructs the main chat renders (the reason a quoted table
 * or highlight must not collapse to plain text). Failure behavior: on any
 * surprise the worst case is escaped plain text, never raw HTML injection.
 */
import { escapeHtml } from "./util";

function inline(md: string): string {
  let s = md;
  // inline code first so its contents are not further transformed
  s = s.replace(/`([^`\n]+)`/g, (_, code: string) => `<code>${code}</code>`);
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/==([^=\n]+)==/g, "<mark>$1</mark>");
  s = s.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>");
  s = s.replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>");
  // links: [label](http…) — escaped input means url contains no quotes/brackets
  s = s.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
  );
  return s;
}

/** A `| a | b |` line split into trimmed cell strings (outer pipes dropped). */
function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

/** True for a markdown table alignment row: `| --- | :--: |`. */
function isTableDivider(line: string): boolean {
  return /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(line);
}

export function renderMarkdown(md: string): string {
  const escaped = escapeHtml(md.replace(/\r\n/g, "\n"));
  const lines = escaped.split("\n");
  const out: string[] = [];
  let i = 0;
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${inline(para.join("<br>"))}</p>`);
      para = [];
    }
  };
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (/^```/.test(line)) {
      flushPara();
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i] ?? "")) {
        code.push(lines[i] ?? "");
        i++;
      }
      i++; // closing fence
      out.push(`<pre><code>${code.join("\n")}</code></pre>`);
      continue;
    }
    // table: a pipe row immediately followed by an alignment divider row
    if (/\|/.test(line) && isTableDivider(lines[i + 1] ?? "")) {
      flushPara();
      const headers = tableCells(line);
      i += 2; // header + divider consumed
      const rows: string[][] = [];
      while (i < lines.length && /\|/.test(lines[i] ?? "") && (lines[i] ?? "").trim() !== "") {
        rows.push(tableCells(lines[i] ?? ""));
        i++;
      }
      const head = headers.map((c) => `<th>${inline(c)}</th>`).join("");
      const body = rows
        .map((cells) => `<tr>${headers.map((_, ci) => `<td>${inline(cells[ci] ?? "")}</td>`).join("")}</tr>`)
        .join("");
      out.push(`<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`);
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      flushPara();
      const quote: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i] ?? "")) {
        quote.push((lines[i] ?? "").replace(/^\s*>\s?/, ""));
        i++;
      }
      out.push(`<blockquote>${inline(quote.join("<br>"))}</blockquote>`);
      continue;
    }
    const header = /^(#{1,6})\s+(.*)$/.exec(line);
    if (header) {
      flushPara();
      const level = Math.min(header[1]!.length + 2, 6); // demote: notes never need h1/h2
      out.push(`<h${level}>${inline(header[2] ?? "")}</h${level}>`);
      i++;
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      flushPara();
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i] ?? "")) {
        items.push(`<li>${inline((lines[i] ?? "").replace(/^\s*[-*+]\s+/, ""))}</li>`);
        i++;
      }
      out.push(`<ul>${items.join("")}</ul>`);
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      flushPara();
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i] ?? "")) {
        items.push(`<li>${inline((lines[i] ?? "").replace(/^\s*\d+\.\s+/, ""))}</li>`);
        i++;
      }
      out.push(`<ol>${items.join("")}</ol>`);
      continue;
    }
    if (line.trim() === "") {
      flushPara();
      i++;
      continue;
    }
    para.push(line);
    i++;
  }
  flushPara();
  return out.join("");
}
