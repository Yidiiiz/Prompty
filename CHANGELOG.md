# Changelog

All notable changes to Prompt Tree are documented here.

## 0.2.0 — 2026-07-10

Feedback release: no-reload branch switching, a redesigned panel, interaction
fixes for notes/comments, and a full UI polish pass.

### Branch switching

- **Switching branches no longer reloads the page.** The panel now drives the
  site's own `‹ Previous / Next version ›` buttons (`NativeArrowsAdapter` in
  `src/content/branch-switch.ts`), waiting on the observed network events
  between steps, so the chat and the panel update in place. Direct jumps
  (branch 1 → 3) step through intermediates automatically.
- The previous mechanism (leaf `PUT` + page reload) is retained only as the
  fallback when the arrows can't be found or a step times out.

### Prompt History panel (formerly "Prompt Tree" panel)

- Renamed the heading to **Prompt History**.
- The panel now spans the **full page height** below the site header and is
  wider (280px).
- **New branch UI**: messages with siblings show an always-visible numbered
  branch list directly beneath the entry — first two branches inline at
  reduced opacity (the current one full-opacity with an accent tick), the
  rest behind a `▸ N more` caret. Clicking a branch switches to it; the old
  `2/3` badge is now a passive count chip.
- **Modernized node design**: a single continuous rail with sender-distinct
  dots (filled accent for prompts, ring for responses), full-width hover rows,
  refined typography, thin styled scrollbar, and consistent motion.
- **Click-highlight fixed**: the pulse now lasts 0.6s (was 1.4s), is softer,
  and highlights **only the message text**, not the empty control space
  beneath it.

### Notes & comments

- **Comment button is now reachable**: it no longer disappears while the
  pointer travels from the text to the margin — the hover logic keeps it
  visible across the corridor between the message and the gutter, and the
  button gained a larger invisible hit area.
- **Note composer no longer jumps the scroll position**: it is positioned at
  its anchor before insertion and focused without scrolling.
- **Typing in a note/comment composer stays there**: keyboard and input events
  are stopped at the extension's UI boundary so the site's global handlers can
  no longer steal keystrokes into the main chat box.
- Streaming replies show an animated "thinking…" indicator.

### UI polish (all surfaces)

- One shared design language (`UI` constants in `src/shared/tokens.ts`):
  consistent 8/12/16px radii, layered soft shadows, 150ms motion, visible
  focus rings, hover/active states — applied to the panel, note/comment cards,
  margin buttons, the fullscreen note modal (backdrop blur + entrance
  animation), toasts, the branching header bar, the draft-restore banner, and
  the settings popup.
- **Layering fixed**: all extension UI now sits **below** the site's own
  overlays (settings dialog, menus) and above the chat content — z-indexes 20
  (in-chat gutter), 30 (panel/bars), 40 (toasts/modal), all under the site's
  overlay layer at 50.

### Docs

- README, recon report (§5), architecture doc, and the manual test checklist
  updated for the new branch-switching mechanism and fixes.

## 0.1.0 — 2026-07-10

Initial build:

- Network-truth architecture: MAIN-world fetch interception (tree loads,
  completion sends, SSE streams, leaf switches), ConversationTree model,
  postMessage bridge to the isolated-world content script.
- Feature 1 — Branch compose from the main composer via
  `parent_message_uuid` rewrite.
- Feature 2 — Conversation panel with branch navigation.
- Feature 3 — Notes: highlight-anchored margin Q&A sent as context-safe side
  branches with quote/prefix/suffix/offset re-anchoring.
- Feature 4 — Comments: position-anchored margin Q&A (anchorText +
  offsetRatio).
- Feature 5 — Draft autosave with mode re-entry and attachment persistence.
- Selector registry, design-token styling, single rAF-batched observer,
  per-feature degradation, settings popup, docs and manual test checklist.
