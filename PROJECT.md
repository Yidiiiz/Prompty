# Prompt Tree — Project Specification & Update History

**Current version:** 0.12.0 (2026-07-23) · Chrome MV3 · personal use only

A Chrome extension that augments **claude.ai** with power-user tools built on
the site's real conversation structure, observed from its own network traffic
(never scraped from the DOM). This document is the living snapshot of what
the extension does **today** and how it got here. Companion docs:
[README.md](README.md) (install/use/troubleshoot),
[CHANGELOG.md](CHANGELOG.md) (full release notes),
[docs/architecture.md](docs/architecture.md) (module map),
[docs/recon-report.md](docs/recon-report.md) (API/DOM ground truth),
[docs/test-checklist.md](docs/test-checklist.md) (manual test matrix).

---

## 1. Feature specifications (as of 0.12.0)

### 1.1 Branch compose

Write an alternative ("branch") of any earlier user message using the full
main composer instead of the site's small inline edit box.

- Entry: a **Branch from here** button injected beside the native edit
  control in each user message's hover toolbar.
- Activating it ghosts the target message, hides every row after it in the
  chat, **truncates the Prompt history panel to the same point**, and shows a
  "Branching from: …" header bar above the composer with a Cancel button.
- The next normal send leaves the browser with its `parent_message_uuid`
  rewritten to the target's parent — identical to what a native edit does.
  Attachments and all other payload fields pass through untouched; no
  keystroke simulation.
- On a failed send the mode re-arms and the native error stays visible; on
  success the mode exits and the native `‹ k/n ›` arrows show the siblings.

### 1.2 Prompt history panel

A borderless, shadow-recessed rail embedded at the chat's left edge
(rounded top-right corner, inset shadows, 16px below the scroll-area top).

- **Structure**: prompts and responses render as pairs — the response nests
  under its prompt with a rounded-L indicator, dimmer and darker. Messages
  with branches become section headers (fork glyph + own branch number
  chip); beneath them the **other** branches are listed with their real
  numbers — first two visible, the rest behind a caret. Chats without
  branches render as a flat list.
- **Modes** (purely space-driven, never conversation-length-driven):
  full (280px) → icon strip (36px; one dot per pair, fork glyphs at branch
  points) → hidden. The chevron collapse state persists.
- **Current-message tracking** (live rects every tick, nothing persisted):
  - parked at the very **top** of the scroll with the true first message
    mounted → the first message is current;
  - parked at the very **bottom** with the true last message fully on
    screen → the last message is current ("caught up");
  - otherwise → the message at the **top edge of the viewport** (+80px
    margin), monotonic in scroll position; zero-height rows (virtualizer
    placeholders, hidden rows) never count.
  - The panel auto-centers the highlighted entry, pausing while the user
    scrolls the panel themselves and resuming on the next change. No hover
    detection. Entries near the ends clamp against the scroll limits.
- **Click-to-jump**: a cancellable frame-driven glide. Every animation frame
  the DOM map is rebuilt and the remaining on-screen gap to the target is
  re-measured from live rects; the scroll moves **by** a fraction of that
  gap (min 40px, 18% easing, capped at half a viewport per frame so
  virtualized regions mount on the way through). No absolute scroll target
  is ever computed. Instant scroll-behavior is forced for the glide's
  duration, and once the target hovers within ~64px for several frames it
  snaps and stops (virtualizers keep nudging layout). Any genuine user
  input — wheel, touch, scroll keys, pressing the scrollbar — or a newer
  click/navigation cancels the glide immediately. Arrival pulses the
  message box (full bubble for prompts, reply text only for responses).
- **Branch switching**: clicking a branch option drives the site's own
  `‹ Previous / Next version ›` buttons step by step with event-driven
  waits (no reload); if arrows are missing or a step stalls it falls back
  to the confirmed API path (leaf PUT + one reload).
- **Chrome**: entries dissolve into a 28px fade at the scroll edges; the
  scrollbar is always visible but quiet (5px, dark, darker on hover); a
  drawer at the bottom lists unanchored and soft-deleted notes.

### 1.3 Notes (highlight-anchored margin Q&A)

- Select text in an assistant reply → a ✎ button appears in the right
  margin (placed next to, never over, the native selection popover) → a
  margin composer opens; **Enter sends, Shift+Enter is a newline, Esc
  cancels**. The composer transforms into the streaming card in place. An
  **empty** composer is ephemeral: a pointer-down outside the gutter (starting
  a branch, a reply, or clicking back into the chat) closes it, but only while
  it holds no typed text — a written draft stays open and autosaved.
- The Q&A is sent as a **hidden message pair on the current branch** —
  parented to the real thread tail, creating **no branch**: no native
  version arrows, no panel entry, and the conversation continues underneath
  it. The prompt carries a `!@#%NOTE!@` marker plus a metadata JSON line
  (anchor uuid, quote, char offset) and instruction fences; the pair
  persists server-side and re-renders from conversation data after reloads
  (rows are hidden by model mapping plus a marker-based safety net).
- **Context trade-off (user-approved)**: the note Q&A is visible to the
  model in later turns; the built-in instructions tell it to treat the note
  as a side question.
- Anchoring: quote + 20-char prefix/suffix + char offset; re-anchored
  against rendered text every tick. Matching is **whitespace-insensitive**
  (`shared/text-match.ts` — a dense projection mapped back to source offsets):
  a selection's `toString()` inserts newlines at block boundaries that the
  rendered text nodes lack, so an exact match of a multi-line quote always
  failed and dropped the card to the message top. An edited-away quote pins
  the card to the message top flagged "anchor moved"; a missing anchor message
  routes the note to the panel's **Unanchored notes** drawer.
- Card/modal rendering covers tables, `==highlight==`, `~~strike~~`, and
  blockquotes in addition to bold/italic/code/lists, so a quoted or answered
  table is not flattened to plain text.
- **Continue**: an ask box opens **inside the card** (Ask / Cancel / Esc;
  Enter sends) and the follow-up extends the same thread in place — under
  the hood another hidden pair whose metadata carries
  `"continues": <first pair's uuid>`. Threads longer than the root + 2
  collapse behind a `▾ N more` toggle (`▴ hide` when open; auto-expanded
  while actively continuing). ⤢ opens a fullscreen markdown modal of the
  whole thread.
- Deletion is **soft**: the card disappears instantly and the note is
  restorable from the panel's **Deleted notes** drawer; the hidden messages
  remain in the conversation data either way.

### 1.4 Comments (position-anchored margin Q&A)

Same card/thread/persistence machinery as notes, but anchored to a position
instead of a highlight:

- Hovering an assistant reply (with nothing selected) shows a **+** button
  in the margin that **snaps to the hovered text line** (caret-rect based),
  fades in/out (~150ms) and glides between lines; its keep-alive hover zone
  is a narrow band around the button plus a small corridor to the right of
  the text.
- Anchor = first 40 chars of the text node under the pointer plus an
  offsetRatio (0–1within the message) as fallback under reflow/zoom.

### 1.5 Reply references

When a message is quoted with claude.ai's own reply action, the quote enters
the composer as a markdown blockquote, so the sent user message begins with
`>`-prefixed lines. Prompt Tree recognises such a message **from the model**
(never DOM scraping): a visible human message whose leading blockquote is
found — dense/markdown-insensitive matched — in an earlier message on the path.

- The quoted passage in the reply gets an accent **reference bar** (overlaid
  in a gutter host, the only clickable UI) and a subtle background via the CSS
  Custom Highlight API — **no mutation of the site's message DOM**.
- **Hovering** the bar opens a popover that renders the quoted passage in its
  original formatting (the source message's markdown — tables, emphasis,
  code), not the flattened plain-text blockquote.
- **Clicking** the bar glides to the source message (relative-delta scrolling,
  cancellable by any genuine input) and highlights the exact quoted span for
  ~2.5s (`::highlight(pt-reply-source)`).
- A reply whose source can't be located shows nothing — the site's own
  blockquote is left untouched (this is also the false-positive guard).
- If claude.ai changes its quote-reply wire format, `parseQuoteReply`
  (`src/content/features/replies.ts`) is the single place to adjust.

### 1.6 Hidden-note thread integrity (shared mechanics)

The app doesn't know the hidden pairs exist, so the page script maintains a
per-conversation **thread-tail map**: every visible message with a hidden
note chain under it → that chain's deepest tail (follow-ups included),
recomputed on every structural tree change. The fetch patch applies it to:

- **Sends** — an app send parented to the visible tail is rewritten to the
  real tail, so the conversation continues *under* the notes instead of
  branching around them.
- **Branch switches** — the app PUTs the branch's last *visible* message as
  the conversation leaf; a leaf that still has (note) children is rejected
  by the server ("Current leaf message has unexpected children"), so the
  PUT body is rewritten to the true leaf.

### 1.7 Draft autosave

- Captures (debounced ~500ms): main-composer text; branch mode (target +
  parent uuids); note/comment composer text with the full anchor;
  attachments seen entering the composer (≤5 MB total, IndexedDB;
  larger sets are flagged "attachments not saved").
- Restore: on conversation load, a draft younger than 2 hours shows a slim
  banner overlaid on the site's alert-band position above the prompt box
  (width scales with the prompt box; stacks with the branching header). The
  band is used for placement only when it actually has width — it now renders
  as a zero-width placeholder even when empty, which had left the banner (and
  the branching header) permanently invisible; the composer dock is the
  fallback.
  **Restore** re-enters the saved mode — reactivating branch mode or
  reopening the note/comment composer at the re-resolved anchor — refills
  the text, reattaches files (synthetic drop; honest notice on failure).
  **Clear** discards the stored draft *and* empties the composer when its
  content matches the draft (the site restores its own copy of the text
  across reloads, which otherwise made Clear look inert).
- Only **trusted** (real-keyboard) input dismisses the offer or drives
  autosave — the site's editor fires synthetic input events while restoring
  its own draft on load, which previously dismissed the banner instantly.
- Lifecycle: a live draft keeps refreshing its timestamp while in use; a
  successful send clears it; expired drafts purge lazily.

### 1.8 Settings popup

Per-feature on/off switches (branch compose, panel, notes, comments, reply
references, drafts), applied live via `chrome.storage` change events.
Disabling a feature removes all of its UI immediately.

---

## 2. Architecture summary

Two content scripts, one bridge:

- **MAIN world** (`src/page/`, document_start): patches `window.fetch`
  before the app boots. Observes tree loads
  (`GET …/chat_conversations/{id}?tree=True`), completion sends (POST,
  including the branch parent rewrite and thread-tail remaps), retries,
  leaf PUTs (with note-tail rewrite), and tees SSE streams. Also issues
  extension-originated requests (side-branch sends, leaf switches, tree
  refetches) using the pre-patch fetch binding and the captured send
  template/org/model. History API patched for SPA navigation events.
- **ISOLATED world** (`src/content/`, document_idle): owns the
  `ConversationTree` model (built exclusively from network truth), the DOM
  map, all UI features, and settings. Communicates with the page script via
  `window.postMessage` with origin checks and an envelope key. Anchor, quote,
  and reply-source lookups all go through `shared/text-match.ts` (dense,
  whitespace/markdown-insensitive projections that map back to source offsets).
- **DOM ↔ model mapping** (`src/content/dom-map.ts`): rows are identified by
  the user-message testid / assistant action-bar markers; kept in DOM order
  unless the measurable rows are genuinely out of visual order (virtualizer
  recycling); note rows map by marker text; the remaining rows align to the
  active path by sender sequence **anchored by prompt-text matching** —
  long chats mount only a window of rows, and the window's offset in the
  path is found by best-score text matching (ties resolve toward the
  bottom), never assumed to be zero. The scroll container is the nearest
  overflow-y auto/scroll ancestor with clientHeight ≥ 200.
- **One observer**: a single rAF-batched MutationObserver plus resize and a
  capture-phase document scroll listener drive every feature's tick.
  Always-on hygiene hides rendered note pairs by model mapping and by
  marker text independently.
- **Positions are always live**: every geometry decision (tracking pins,
  glide targeting, card anchoring) is measured from fresh client rects in a
  single coordinate space each frame; nothing about scroll position or the
  current message is stored, and no absolute scroll targets are computed.
- **Styling**: site design tokens via `hsl(var(--token, fallback))`, shared
  UI constants (site-recipe shadows, 150ms motion), shadow DOM per surface,
  z-layering under the site's own overlays (gutter 20 / panel & bars 30 /
  toasts & modal 40 / site 50).
- **Storage**: `chrome.storage.local` — settings, panel collapsed state,
  `pt.notes.{conversation}` (anchoring metadata + soft-delete + follow-up
  uuids; note *content* lives in the conversation itself), and
  `pt.draft.{conversation}`; IndexedDB for draft attachments.
- **Failure behavior**: every module degrades per feature with a one-time
  toast, never breaking the site; selector/token/shape validation reports
  what broke and where to fix it (see README troubleshooting).

Build: strict TypeScript, esbuild → `dist/` (`npm run check` = typecheck +
build), programmatic PNG icons, no runtime dependencies.

---

## 3. Update history

Full details in [CHANGELOG.md](CHANGELOG.md); this is the arc.

| Version | Date | Theme |
|---|---|---|
| 0.1.0 | 2026-07-10 | Initial build: fetch-interception architecture, tree model, all five features, selector/token registries, per-feature degradation. |
| 0.2.0 | 2026-07-10 | No-reload branch switching via the native version arrows; panel redesign (full height, numbered branch lists); note/comment interaction fixes (reachable + button, no scroll jumps, keystroke isolation); shared design language; z-layering under site overlays. |
| 0.3.0 | 2026-07-10 | Panel rebuilt from scratch (pairs, section headers, guide line, strip mode); gutter clears the prompt box; borderless dimmed shadow-elevated UI; floating composer bars; toasts to the top. |
| 0.4.0 | 2026-07-10 | Restore notice integrated like native notices; composer→card transform on note submit; panel no longer collapses on short branches (purely space-driven modes). |
| 0.5.0 | 2026-07-10 | **Notes became in-thread hidden messages** (no branches; user-approved context trade-off) with transparent send reparenting; soft delete + restore drawer; embedded panel; site-recipe shadows. |
| 0.6.0 | 2026-07-11 | Continue (follow-up threads in cards); restore banner as fixed overlay (React-owned band unreliable); reload-hiding of note pairs hardened; panel tracks/centers the current message; real branch numbers. |
| 0.7.0 | 2026-07-11 | Scroll-driven tracking (capture-phase listener); short-branch scroll-container fix; composer bars centered/narrower; stale restore offer dismisses itself; deferred selector validation. |
| 0.8.0 | 2026-07-11 | Continuation marking (`continues` metadata), collapsed threads; top-right rounding; monotonic tracking; single-glide jumps; width-scaled composer bars. |
| 0.8.1–0.8.4 | 2026-07-16 | The **live-positions series**: user-cancellable frame-driven glide; text-anchored window alignment for virtualized long chats (the root cause of wrong highlights/jumps); best-score anchoring; relative-step scrolling with no absolute targets; conditional visual-order sorting. |
| 0.9.0 | 2026-07-16 | Panel edge fades + quiet scrollbar; branch-mode flicker fix (zero-rect rows had scrambled the map); Clear also empties the composer; snapping/fading + button with tighter hitbox; in-card Continue box. |
| 0.10.0 | 2026-07-16 | Branch mode truncates the panel; jitter-free glide (instant scroll-behavior + settle snap); top-of-viewport tracking; **leaf-PUT note remap** (fixes "Current leaf message has unexpected children" on branch switches); Enter-to-send; caret directions. |
| 0.11.0 | 2026-07-16 | Honest bottom pin (only when parked at the bottom); zero-height rows excluded from tracking; draft banner survives reload (trusted-input guard). Hover highlight added. |
| 0.11.1 | 2026-07-16 | Hover highlight removed (scroll-only tracking); first-message pin at scroll 0; edge centering reverted to clamping. |
| 0.12.0 | 2026-07-23 | Whitespace-insensitive note/comment anchoring (multi-line quotes no longer drop to the message top); empty composer auto-closes on switching; tables/highlight/strike/blockquote in cards; **reply references** (formatted hover popover + click-to-source highlight for quote-replies); draft banner visible again (zero-width alert-band fallback). |

### Hard-won invariants (why the code looks the way it does)

1. **Model from the network, never the DOM.** The DOM is only ever matched
   *against* the model; identity comes from order + text anchoring.
2. **Every position is measured live, in one coordinate space.** Client
   rects both sides, fresh every frame; virtualization invalidates anything
   cached, absolute, or mixed-coordinate.
3. **Move relative to where the scroll actually is** — never *to* a
   computed coordinate.
4. **Programmatic scrolling must be cancellable by any genuine user input**
   and must never fight the site's own smooth scrolling.
5. **Hidden rows measure 0×0 at the viewport origin** — every geometric
   consumer must exclude or special-case them.
6. **The app doesn't know about hidden note pairs** — every request that
   references a thread's end (send parent, leaf PUT) must be remapped
   through the thread-tail map.
7. **The site fires synthetic editor events** — only trusted input counts
   as the user typing.
8. **React owns its subtrees** — extension UI overlays aligned to site
   rects; nothing is inserted into React-managed containers. Styling text
   *inside* those subtrees (reply references, the source-jump highlight) uses
   the CSS Custom Highlight API, which decorates arbitrary ranges with no DOM
   mutation at all.
9. **Rendered text and its source rarely match character-for-character** — a
   selection's `toString()` adds block-boundary newlines the DOM lacks, and a
   message's markdown carries syntax the reader never sees. Every quote/anchor
   lookup matches on a **dense projection** (ignored whitespace, optionally
   markdown syntax) mapped back to source offsets (`shared/text-match.ts`);
   exact `indexOf` silently mis-anchored multi-line quotes to the message top.
