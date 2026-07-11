# Changelog

All notable changes to Prompt Tree are documented here.

## 0.5.0 — 2026-07-10

### Notes & comments are now in-thread (no more branches)

- A note/comment is sent as a **hidden message on the current branch**,
  parented to the real thread tail — it creates **no branch**: no native
  `‹ 1/2 ›` arrows appear, nothing shows up in the Prompt history tree, and
  the next prompt you send continues **underneath** the note (the extension
  transparently reparents the app's next send past the hidden pair).
- The note pair stays hidden from the chat (including after reloads) and
  from the panel; its content still renders only in the margin card.
- **Trade-off (user-approved)**: the note Q&A is now part of the model's
  context for subsequent replies. Each note's built-in instructions tell the
  model to treat it as a small side question.
- Notes created before 0.5.0 remain side branches in the conversation data;
  their cards still work, but their old branches stay visible to the native
  arrows.

### Note deletion

- Deleting a note is now a **soft delete**: remaining cards shift up
  immediately, and the note appears under **"Deleted notes"** in the panel's
  drawer, where one click restores it.

### Composer-top bars

- The draft-restore notice and the branching header are now inserted into
  the **site's own alert band** above the prompt box (the placement native
  notices use), fixing the half-overlapped banner. They match the native
  band's shape (20px top rounding, hairline inset ring) and heal themselves
  if the app re-renders the composer area. A fixed-position fallback remains
  if the band disappears.

### Prompt history panel

- **Embedded left rail**: the panel now sits flush against the left edge
  with square corners and inset shadows, reading as recessed beneath the
  chat instead of floating over it; same treatment for the minimized strip.
- **Branch-less chats render flat**: pairs before the first branch point
  (or in chats with no branches at all) lose the indent and guide line — a
  clean simple list.
- Custom 4px scrollbar at low opacity.

### Styling

- **Shadows reworked** to the site's own recipe (captured live): one tight
  low-alpha drop shadow plus a half-pixel token-driven ring that hugs each
  element exactly — no more oversized halos.
- Note/comment composer textarea and Cancel button borders softened to 40%
  opacity.

## 0.4.0 — 2026-07-10

### Draft autosave

- The restore notice is now **integrated with the chat**, styled like the
  site's own inline notices: attached flush to the top of the prompt box,
  matching its exact width, rounded top corners only, muted tint, and
  link-style **Restore** / **Clear** actions instead of buttons.

### Notes & comments

- Submitting a note/comment no longer makes the composer disappear — it
  **transforms into the pending card in the same frame**, at the same
  position, which then streams the reply as before.

### Prompt history panel

- **Branching off the first message no longer hides the tree.** The panel's
  full/strip/hidden modes are now purely space-driven; the old "fewer than 4
  messages → collapse" rule (which kicked in whenever a new branch started a
  short active path) is removed.

## 0.3.0 — 2026-07-10

Third feedback release: the Prompt history panel rebuilt from the ground up,
notes/comments moved clear of the prompt box, borderless shadow-elevated
styling everywhere, and a set of interaction fixes.

### Prompt history panel — redesigned from scratch

- **New structure**: prompts and their responses are paired — the response
  nests under its prompt with a rounded-L indicator, dimmer text, and a
  darker background. Messages with branches become section headers (fork
  glyph + `k/n` count) with their numbered branch options directly beneath;
  ordinary pairs hang off a guide line that ends at the last item (no more
  full-height rail).
- The current branch option uses the extension's signature quote-chip style:
  accent left bar, darker background, dark highlighted text.
- Heading is now sentence case ("Prompt history").
- **Minimized state shows icons again**: collapsing yields a slim strip with
  one dot per prompt/response pair and fork glyphs at branch points —
  tooltips and click-to-scroll included. Glyphs are muted, not bright accent.
- **Responsive fit**: the panel measures the real margin next to the chat and
  steps full panel → icon strip → hidden as space runs out.

### Notes & comments

- Cards moved further right and now actively clear the prompt box: if the
  composer is wider than the chat column, the gutter shifts right of it, so
  scrolling cards never cross the input. When the margin can't fit the
  gutter at all, it disappears instead of overlapping.
- The old "squeeze over the chat" behavior (the cause of cards covering the
  prompt box) is removed.

### Click highlights

- Clicking a prompt in the panel now pulses its **entire bubble**; clicking a
  response pulses **only the reply text block** — never the empty space
  reserved for controls beneath it.

### Floating bars

- The "Branching from…" header and the "autosaved message" banner now float
  just above the prompt box instead of being inserted inside it, styled with
  the quote-chip left bar (branching = accent, draft = secondary accent);
  they stack when both are visible.

### All UI

- Borders removed across panel, cards, margin buttons, modal, toasts, and
  bars — elevation comes from layered shadows (with a faint edge ring for
  light mode).
- Palette dimmed for an organization tool that stays out of the way: muted
  glyphs and buttons, accent reserved for the current branch, the primary
  action button, and hovers.
- Toasts/warnings now appear at the **top** of the page, below the site
  header.

### Fixes

- Removed the stale `main` landmark selector that produced a false
  "page hooks not found (mainLandmark)" warning after a site update.

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
