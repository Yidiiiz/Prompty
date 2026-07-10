/**
 * shared/markdown.ts — a deliberately small, safe markdown renderer for note
 * cards and the fullscreen note modal. All input is HTML-escaped first, then a
 * limited grammar is applied: fenced/inline code, headers, bold/italic,
 * links (http/https only), unordered/ordered lists, paragraphs.
 *
 * Not a general markdown engine by design — notes are "a short paragraph at
 * most" per the note prompt. Failure behavior: on any surprise the worst case
 * is escaped plain text, never raw HTML injection.
 */
import { escapeHtml } from "./util";

function inline(md: string): string {
  let s = md;
  // inline code first so its contents are not further transformed
  s = s.replace(/`([^`\n]+)`/g, (_, code: string) => `<code>${code}</code>`);
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>");
  s = s.replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>");
  // links: [label](http…) — escaped input means url contains no quotes/brackets
  s = s.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
  );
  return s;
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
