/**
 * shared/markdown.ts — a deliberately small, safe markdown renderer for note
 * cards, the fullscreen note modal, and the reply-quote popover. All input is
 * HTML-escaped first, then a limited grammar is applied: fenced/inline code,
 * headers, bold/italic, ==highlight==, ~~strike~~, links (http/https only),
 * unordered/ordered lists, tables, blockquotes, math ($…$ / $$…$$),
 * paragraphs.
 *
 * It mirrors the constructs the main chat renders (the reason a quoted table
 * or highlight must not collapse to plain text). Failure behavior: on any
 * surprise the worst case is escaped plain text, never raw HTML injection.
 */
import { escapeHtml } from "./util";

/**
 * LaTeX command → Unicode. We do NOT typeset math (that needs a full engine);
 * we render it legibly: Greek letters, operators and relations become their
 * Unicode glyphs, sub/superscripts become <sub>/<sup>, fractions and roots get
 * a light structural wrapper. Sorted longest-first at use so `\varepsilon`
 * wins over `\epsilon`, `\cdots` over `\cdot`, `\int` over `\in`, etc.
 */
const MATH_SYMBOLS: Record<string, string> = {
  "\\alpha": "α", "\\beta": "β", "\\gamma": "γ", "\\delta": "δ",
  "\\varepsilon": "ε", "\\epsilon": "ε", "\\zeta": "ζ", "\\eta": "η",
  "\\theta": "θ", "\\vartheta": "ϑ", "\\iota": "ι", "\\kappa": "κ",
  "\\lambda": "λ", "\\mu": "μ", "\\nu": "ν", "\\xi": "ξ", "\\pi": "π",
  "\\rho": "ρ", "\\sigma": "σ", "\\tau": "τ", "\\upsilon": "υ",
  "\\varphi": "φ", "\\phi": "φ", "\\chi": "χ", "\\psi": "ψ", "\\omega": "ω",
  "\\Gamma": "Γ", "\\Delta": "Δ", "\\Theta": "Θ", "\\Lambda": "Λ",
  "\\Xi": "Ξ", "\\Pi": "Π", "\\Sigma": "Σ", "\\Phi": "Φ", "\\Psi": "Ψ",
  "\\Omega": "Ω",
  "\\approx": "≈", "\\times": "×", "\\cdots": "⋯", "\\cdot": "·",
  "\\div": "÷", "\\pm": "±", "\\mp": "∓", "\\leq": "≤", "\\le": "≤",
  "\\geq": "≥", "\\ge": "≥", "\\neq": "≠", "\\ne": "≠", "\\equiv": "≡",
  "\\ll": "≪", "\\gg": "≫", "\\sim": "∼", "\\simeq": "≃", "\\propto": "∝",
  "\\infty": "∞", "\\partial": "∂", "\\nabla": "∇", "\\sum": "∑",
  "\\prod": "∏", "\\int": "∫", "\\notin": "∉", "\\in": "∈",
  "\\subseteq": "⊆", "\\subset": "⊂", "\\supseteq": "⊇", "\\supset": "⊃",
  "\\cup": "∪", "\\cap": "∩", "\\emptyset": "∅", "\\forall": "∀",
  "\\exists": "∃", "\\Rightarrow": "⇒", "\\Leftrightarrow": "⇔",
  "\\rightarrow": "→", "\\leftarrow": "←", "\\to": "→", "\\mapsto": "↦",
  "\\langle": "⟨", "\\rangle": "⟩", "\\ldots": "…", "\\dots": "…",
  "\\ast": "∗", "\\star": "⋆", "\\bullet": "•",
  "\\wedge": "∧", "\\vee": "∨", "\\neg": "¬", "\\oplus": "⊕",
  "\\otimes": "⊗", "\\prime": "′", "\\circ": "∘", "\\deg": "°",
};

/** Render a `\frac{a}{b}` (innermost first) as a light stacked fraction. */
function renderFractions(s: string): string {
  const re = /\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/;
  let prev: string;
  do {
    prev = s;
    s = s.replace(re, (_, a: string, b: string) => `<span class="mfrac"><span class="mnum">${a}</span><span class="mden">${b}</span></span>`);
  } while (s !== prev);
  return s;
}

function mathToHtml(tex: string): string {
  let s = tex;
  s = s.replace(/\\left|\\right/g, "");
  // structural text wrappers collapse to their contents
  s = s.replace(/\\(?:text|mathrm|mathbf|mathit|mathsf|mathcal|operatorname)\s*\{([^{}]*)\}/g, "$1");
  // Braced sub/superscripts FIRST: this dissolves their braces, so a following
  // \frac{V_{rare}}{N} no longer has nested braces to trip up its `[^{}]` match.
  s = s.replace(/\^\{([^{}]*)\}/g, (_, x: string) => `<sup>${x}</sup>`);
  s = s.replace(/_\{([^{}]*)\}/g, (_, x: string) => `<sub>${x}</sub>`);
  for (const cmd of Object.keys(MATH_SYMBOLS).sort((a, b) => b.length - a.length)) {
    if (s.includes(cmd)) s = s.split(cmd).join(MATH_SYMBOLS[cmd]!);
  }
  s = s.replace(/\\sqrt\s*\{([^{}]*)\}/g, (_, x: string) => `√(${x})`);
  s = s.replace(/\\sqrt\s+(\\?\w)/g, (_, x: string) => `√${x}`);
  s = renderFractions(s);
  // remaining single-token sub/superscripts
  s = s.replace(/\^(\\?\w)/g, (_, x: string) => `<sup>${x}</sup>`);
  s = s.replace(/_(\\?\w)/g, (_, x: string) => `<sub>${x}</sub>`);
  // spacing commands, then any surviving unknown command keeps its name
  s = s.replace(/\\[,;!:> ]/g, " ");
  s = s.replace(/\\([A-Za-z]+)/g, "$1");
  s = s.replace(/[{}]/g, "");
  return `<span class="math">${s}</span>`;
}

// A NUL byte cannot occur in HTML-escaped markdown, so it is a collision-
// proof placeholder delimiter for stashed code/math spans.
const NUL = String.fromCharCode(0);

function inline(md: string): string {
  // Protect code and math from further transforms via placeholders.
  const tokens: string[] = [];
  const stash = (html: string): string => NUL + (tokens.push(html) - 1) + NUL;
  let s = md;
  s = s.replace(/`([^`\n]+)`/g, (_, code: string) => stash(`<code>${code}</code>`));
  // inline math $…$ — non-space adjacent, not currency ($5, $10)
  s = s.replace(/(?<!\d)\$(?=\S)([^$\n]*?\S)\$(?!\d)/g, (_, tex: string) => stash(mathToHtml(tex)));
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
  s = s.replace(new RegExp(NUL + "(\\d+)" + NUL, "g"), (_, n: string) => tokens[Number(n)] ?? "");
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
    // block math: $$…$$ on one line, or a $$ fence spanning several lines
    const oneLineMath = /^\s*\$\$(.+?)\$\$\s*$/.exec(line);
    if (oneLineMath) {
      flushPara();
      out.push(`<div class="mathblock">${mathToHtml(oneLineMath[1]!.trim())}</div>`);
      i++;
      continue;
    }
    if (/^\s*\$\$\s*$/.test(line)) {
      flushPara();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*\$\$\s*$/.test(lines[i] ?? "")) {
        body.push(lines[i] ?? "");
        i++;
      }
      i++; // closing fence
      out.push(`<div class="mathblock">${mathToHtml(body.join(" ").trim())}</div>`);
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
    // blockquote — note the `>` has already been HTML-escaped to `&gt;`
    if (/^\s*&gt;\s?/.test(line)) {
      flushPara();
      const quote: string[] = [];
      while (i < lines.length && /^\s*&gt;\s?/.test(lines[i] ?? "")) {
        quote.push((lines[i] ?? "").replace(/^\s*&gt;\s?/, ""));
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
