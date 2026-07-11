# Manual Test Checklist

Run against a real claude.ai session with the extension loaded from `dist/`.
Prepare one throwaway conversation with ≥6 messages and at least one branched
message (edit a message once via the native inline editor to create siblings).

Conventions: ☐ = check; **bold** items are the edge cases named in the build
prompt. After any code change, run at minimum the section of the feature you
touched plus "Cross-cutting".

## 0. Install & boot

- ☐ `npm run check` passes; `dist/` loads as unpacked with no manifest errors.
- ☐ Open claude.ai: no console errors from `[prompt-tree]` (warnings about
  optional selectors are OK on pages without a conversation); in particular
  no "page hooks not found (mainLandmark)" warning.
- ☐ Any extension toast appears **top-center below the site header**, not at
  the bottom.
- ☐ Popup opens; all five toggles reflect stored state; toggling updates the
  live tab without reload.
- ☐ Extension UI matches the site theme; switch claude.ai light ↔ dark: all
  extension surfaces (panel, cards, banner, toasts) follow instantly.

## 1. Branch compose

- ☐ Hovering a user message shows **Branch from here** beside the native
  edit/copy controls (and on other user messages, not just the last).
- ☐ Activating: target message ghosts (~0.45 opacity + left accent border);
  **all messages below it hide**; a one-line header bar sits directly above
  the composer: `Branching from: “…first words…”` + Cancel.
- ☐ **Scroll far up and back down while active: ghost/hide states persist.**
- ☐ Composer stays fully functional in the mode (typing, paste, attach a file).
- ☐ Send: message posts as a **sibling of the ghosted message** — native
  `‹ N/M ›` arrows appear on it; the new branch renders; mode exits (no ghost,
  no hidden rows, no header).
- ☐ Attachment sent in branch mode arrives intact on the new branch.
- ☐ **Activating on a message that already has siblings adds one more sibling**
  (counter increments).
- ☐ Branching the **first message of the chat** works (sentinel-root parent).
- ☐ Cancel: everything restores; a normal send afterwards goes to the normal
  leaf (no stale rewrite).
- ☐ **Failed send** (toggle DevTools → Network → Offline before sending): the
  native error shows, branch mode stays active, the draft text is still in the
  composer; going online and re-sending branches correctly.
- ☐ Navigating to another conversation while active exits the mode cleanly.
- ☐ Popup toggle off: buttons disappear, active mode cancels.

## 2. Prompt history panel

- ☐ Panel appears over the left margin of the chat, spanning the full
  viewport height below the site header (280px wide, titled "Prompt history"
  in sentence case); it does not cover the native sidebar and does not
  scroll with messages.
- ☐ Opening the site's **settings dialog / account menu covers the panel**
  (and every other extension surface) — extension UI never sits on top of
  site overlays.
- ☐ **Paired structure**: each prompt is a row; its response nests beneath it
  with a rounded-L indicator, smaller/dimmer text, and a darker background.
- ☐ **Branch points are section headers**: fork glyph + summary + `k/n`
  count; their numbered branch options render directly beneath (first two at
  reduced opacity; the **current one in the quote-chip style** — accent left
  bar, darker background, dark text); `▸ N more` expands, `▾ show less`
  collapses.
- ☐ Ordinary pairs hang off a guide line that **ends at the last item** — no
  line continues past the final message.
- ☐ Clicking a prompt row smooth-scrolls to it and pulses (~0.6s) the **whole
  prompt bubble**; clicking a response row pulses **only the reply text
  block**, never the control space beneath it.
- ☐ **Virtualized jump**: in a chat long enough that early messages unload,
  clicking an early panel entry hops upward until the message mounts, then
  aligns and pulses it.
- ☐ **Tracking**: scrolling the chat highlights the in-view pair in the panel
  (chip tint; accent dot in the strip) and keeps it centered; manually
  scrolling the panel pauses centering until the chat moves or an entry is
  clicked.
- ☐ **Numbering**: on branch 2 of 3, the chip reads `2` and the list beneath
  shows only branches `1` and `3` (their real numbers).
- ☐ The panel top leaves the chat title visible (~44px headroom).
- ☐ **Clicking a branch option switches WITHOUT a page reload**: the chat
  re-renders in place (native arrows are driven for you) and the panel
  follows. **Direct jump 1 → 3** works (steps through 2 transiently).
- ☐ Panel updates live while an assistant reply streams, without jank.
- ☐ **Minimized = icon strip**: the chevron collapses the panel to a slim
  strip showing a muted dot per pair and `⑂` at branch points, with tooltips
  and the same click-to-scroll; state persists across reload.
- ☐ **Responsive fit**: shrink the window — the panel steps full → strip →
  hidden as the margin next to the chat runs out, and returns when widened.
- ☐ **Branching off the FIRST message keeps the panel**: activate "Branch
  from here" on message 1, send — the new 2-message branch still shows the
  full panel (with the branch point); a brand-new 1-turn chat also gets the
  full panel when space allows.
- ☐ Note/comment side branches never appear as panel rows, options, or
  counts.

## 3. Notes

- ☐ Selecting text in an assistant reply shows the ✎ button in the right
  margin aligned with the selection's **first line**; it does not overlap the
  native selection popover (try selections near the right edge).
- ☐ Selecting text in a **user** message shows nothing.
- ☐ Clicking the ✎ button does **not** change the page's scroll position; the
  composer opens at the selection's line.
- ☐ Composer opens in the margin at that position; **every keystroke stays in
  the note textarea — nothing appears in the main composer**; Esc cancels;
  ⌘/Ctrl-Enter submits.
- ☐ On submit the **composer transforms into the pending card in place** (no
  disappear/flash), then the answer **streams into it**; the main chat shows
  no new messages; the note question/answer never appear in the chat.
- ☐ **In-thread, no branches**: after a note, NO native `‹ 1/2 ›` arrows
  appear anywhere and the Prompt history panel shows no new branch; in
  DevTools, the note's own send has `parent_message_uuid` = the previous
  thread tail.
- ☐ **Continuation**: send a normal prompt after a note — it continues the
  conversation (DevTools: its `parent_message_uuid` equals the note reply's
  uuid, rewritten by the extension); a second note chains under the first.
- ☐ The card shows quote (muted), question, response; ⤢ opens the fullscreen
  modal with markdown rendering; Esc/✕/backdrop closes it.
- ☐ **Continue**: the card's Continue action reopens the margin composer;
  submitting appends the new Q&A inside the same card (divider between
  pairs) and streams live; the modal shows the whole thread; reload → the
  full thread re-renders; the next normal prompt still continues the
  conversation (parent = the newest follow-up reply).
- ☐ **Multiple notes on one message** work; **two notes near the same line
  stack with push-down** and connector lines point at their anchor lines.
- ☐ Cards scroll with the chat (they live in the message scroll area) and
  **never cross the prompt box** while scrolling — the gutter sits fully
  right of it.
- ☐ Narrow the window until the right margin is too small for cards: the
  gutter (cards, buttons, composer) **disappears instead of overlapping**,
  and returns when the window widens.
- ☐ Reload the page: notes re-anchor to their quotes and re-render with
  content pulled from the conversation tree.
- ☐ **Anchor moved**: edit the annotated assistant text away… not possible
  natively — instead simulate by noting a quote, then switching to a sibling
  branch of that assistant message where the quote differs: the note pins to
  the message top flagged "anchor moved" (when the anchor message is on the
  rendered path) or moves to the **unanchored notes drawer** at the panel's
  bottom (when the message uuid left the tree entirely).
- ☐ Delete (🗑): the card disappears and **remaining cards shift up
  immediately**; the note appears under **"Deleted notes"** in the panel
  drawer; clicking it restores the card; reload → soft-deleted state
  persists.
- ☐ Reload after creating notes: the hidden note pair does not appear in the
  chat or the panel; the card still renders its content from the tree.

## 4. Comments

- ☐ Hovering an assistant reply with **no selection** shows the "+" button in
  the right margin, tracking the pointer vertically without jitter (rAF
  throttle).
- ☐ **Moving the pointer straight from the text to the "+" button keeps it
  visible and clickable** — it does not hide while crossing the gap between
  the message and the margin.
- ☐ With a selection active, the "+" does not appear (notes flow wins).
- ☐ Clicking opens the composer at that height; submit streams into a card
  identical to a note card but labeled Comment (no quote).
- ☐ Reload → the comment re-anchors near the same content (anchorText), and
  after zooming the page (Ctrl+/-) or resizing, positions stay sensible
  (offsetRatio fallback; never raw pixels).
- ☐ The sent prompt (DevTools → Network) contains the `!@#%NOTE!@` header with
  `"kind":"comment"` and ~200 chars of surrounding context.

## 5. Draft autosave

- ☐ Type in the composer, wait ~1s, reload: banner above the composer shows
  *autosaved message* (italic) + first line + **Restore** / **Clear**.
- ☐ Restore refills the composer text exactly (multi-line preserved).
- ☐ Clear removes the draft; reload shows no banner.
- ☐ Attach a small file + text, reload, Restore: text refills and the file
  reattaches (or an honest "couldn't reattach" notice appears).
- ☐ Attach >5 MB total, type, reload: banner shows "(attachments not saved)";
  Restore refills text only.
- ☐ The restore notice renders **inside the site's alert band** above the
  prompt box (exactly where native notices appear — fully visible, rounded
  top, hairline ring), with link-style Restore/Clear; with branch mode also
  active, both bars stack in the band without overlap; both heal after the
  app re-renders the composer area (e.g. window resize).
- ☐ **Branch draft**: enter branch mode, type, reload, Restore → branch mode
  re-activates on the same target (ghost/hide/header) with text refilled;
  send branches correctly.
- ☐ **Branch draft with dead target**: make a branch draft, switch to the
  sibling branch (so the target leaves the rendered path but stays in the
  tree) — Restore still re-activates if the uuid exists; to test the missing
  case, use a draft from a deleted conversation → restores as normal text
  with an explanatory notice.
- ☐ **Note draft**: open a note composer, type, reload, Restore → the note
  composer reopens at the re-resolved anchor with the text; submitting works.
- ☐ Successful send clears the draft (reload right after sending: no banner).
- ☐ Draft older than 2h (edit `savedAt` via DevTools → Application →
  extension storage, or wait): no banner, record purged on load.
- ☐ A restored-but-untouched draft still shows a banner after another reload
  (savedAt refreshed while live).

## 6. Cross-cutting / non-functional

- ☐ **Page reload** mid-conversation: tree rebuilds from the load response;
  panel, notes, drafts all come back.
- ☐ **SPA conversation switch** (click another chat in the sidebar): features
  re-initialize; no state bleed (branch mode, notes, panel path all reset).
- ☐ **Old conversation** (open one from last week with branches): tree and
  panel correct on first render.
- ☐ **New conversation**: send the first message from /new — model initializes
  from the send (panel appears once ≥1 turn exists); notes work after the
  first reply.
- ☐ **Streaming**: while a long reply streams, typing in the composer stays
  latency-free; panel updates; CPU settles to ~0 after message_stop
  (Performance monitor).
- ☐ Background tab for 5 minutes: Task Manager shows ~0 CPU for the tab
  (no polling timers exist).
- ☐ Retry (native regenerate): panel shows the new assistant sibling after the
  stream finishes; tree stays consistent.
- ☐ Native features unharmed with the extension on: editing inline, retry,
  arrows, file upload, selection popover "Reply".
- ☐ All five popup toggles off: page is visually indistinguishable from stock
  claude.ai; network traffic shows no extension-originated requests.
- ☐ Non-conversation pages (/new, /recents, settings): no panel, no errors.
