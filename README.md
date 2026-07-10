# Prompt Tree

A personal-use Chrome extension (Manifest V3) that augments **claude.ai** with
power-user tools built on its real conversation structure:

- **Branch compose** — write an alternative ("branch") of any of your earlier
  messages using the full main composer (attachments, long text, paste) instead
  of the small inline edit box. The target message ghosts, everything below it
  hides, and your next send becomes a sibling of it.
- **Prompt History panel** — a collapsible, full-height overlay on the left
  edge of the chat showing the active conversation path. Messages with
  branches list them right beneath the entry (numbered, first two visible,
  caret for the rest); click any branch to jump straight to it — no page
  reload — or click an entry to scroll to that message.
- **Notes** — highlight text in an assistant reply and ask a small margin
  question about it. The Q&A is sent as a *side branch* of the conversation
  tree, so it is **never part of the main thread's context**, yet it persists
  in the conversation itself across reloads and devices.
- **Comments** — the same margin Q&A anchored to a position in the reply
  (Google-Docs-style "+" on hover) instead of a highlight.
- **Draft autosave** — composer drafts (including branch/note/comment drafts
  and attachments up to 5 MB) survive reloads; a slim banner offers
  Restore/Clear for drafts younger than 2 hours.

Each feature has an on/off switch in the extension popup.

> ## Legal / stability disclaimer — read this
>
> This extension observes and replays claude.ai's **undocumented internal
> API**. It may break at any time, and its use is **at your own risk with
> respect to Anthropic's Terms of Service**. It is built for **personal use
> only — do not publish it to the Chrome Web Store** or distribute it.
> It stores nothing outside your browser and never reads, stores, or transmits
> session tokens (authentication is your browser's own same-origin cookies).

## Install

Prerequisites: Node.js 18+, Chrome 111+.

```sh
npm install
npm run check        # typecheck + build (or: npm run build)
```

Then:

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select this repo's `dist/` folder.
4. Open or reload a claude.ai tab.

After changing source, run `npm run build` and press the ↻ reload icon on the
extension card, then reload the claude.ai tab.

## Using it

- **Branch compose**: hover one of your messages → click **Branch from here**
  in its toolbar. A header bar appears above the composer ("Branching from: …")
  with a Cancel button. Type and send normally; the send becomes a branch.
  Native `‹ 2/3 ›` arrows and the panel now show the siblings.
- **Prompt History panel**: spans the page height beside the chat; the chevron
  collapses it to an edge tab (state persists). It auto-compacts to a dot
  strip on narrow windows (<1100px) or short chats (<4 messages). Messages
  with branches show a numbered branch list underneath — the first two plus a
  `▸ N more` caret; click a branch to switch to it in place (the extension
  drives the native `‹ ›` version arrows for you, stepping directly from any
  branch to any other).
- **Notes**: select text in an assistant reply → click the ✎ button in the
  right margin (next to, never over, the native selection popover) → type the
  question in the margin composer (⌘/Ctrl-Enter sends). The answer streams into
  the card. ⤢ expands to a full markdown modal; 🗑 removes the note's local
  anchor (the side branch stays in the conversation tree, orphaned and
  harmless).
- **Comments**: hover a reply with nothing selected → click the **+** in the
  margin.
- **Drafts**: just type; everything is saved automatically per conversation.
  On return, use **Restore** (re-enters branch/note/comment mode when the
  target still exists) or **Clear**.

## Troubleshooting — "a claude.ai update broke X"

The extension is built to degrade per feature, not to break claude.ai. When
something disappears or misbehaves:

1. **Check the console** (DevTools → Console, filter `[prompt-tree]`).
   - `selector validation failures (…)` — claude.ai renamed a DOM hook. Every
     selector lives in `src/shared/selectors.ts` with a description; find the
     new equivalent in DevTools (prefer `data-testid` / `aria-label` /
     landmarks, never hashed class names), update that one file, rebuild.
   - `design tokens missing` — cosmetic only; the UI falls back to bundled
     colors. Update `TOKEN_FALLBACKS` names in `src/shared/tokens.ts` if the
     token families were renamed.
   - `unexpected conversation shape` — the tree endpoint changed. Compare a
     live response against `docs/recon-report.md` §2 and adjust
     `src/shared/tree.ts` (`fromConversation` / `extractText`).
2. **A "Prompt Tree: … unavailable" toast appeared once** — that feature
   disabled itself for this page load; the rest keeps working. The toast text
   names the broken dependency.
3. **Branch compose sends to the wrong place / normally** — verify the
   completion payload still has a top-level `parent_message_uuid`
   (DevTools → Network → `completion`). If the field moved, update
   `handleCompletion` in `src/page/fetch-patch.ts`.
4. **Notes stopped answering** — check the Network tab for the extension's own
   `completion` POST. A 4xx usually means the payload template drifted; compare
   with a native send and adjust `buildSideBranchPayload` in `src/page/api.ts`.
5. **Branch switch does nothing** — check that the native version arrows still
   carry `aria-label="Previous version"` / `"Next version"` (the primary
   mechanism drives them), and that the `current_leaf_message_uuid` PUT still
   returns 200 (the fallback; recon report §5). The whole mechanism is
   isolated in `src/content/branch-switch.ts`.
6. **Nothing works at all** — claude.ai may have moved off `window.fetch`
   (e.g. XHR or a worker). Confirm in the Network tab; interception lives in
   `src/page/fetch-patch.ts`.

When you find a changed shape, update `docs/recon-report.md` alongside the code
so the next breakage is diagnosable.

## Known limitations (deliberate, documented honesty)

- **Branch jumps step through intermediate branches.** Switching drives the
  app's own version arrows, so jumping 1 → 3 briefly renders branch 2 on the
  way. If the arrows can't be found (site update, message unmounted), the
  extension falls back to the API path (leaf PUT) plus a one-time page reload
  — both mechanisms are isolated in `BranchSwitchAdapter`.
- **Native branch counters include note branches.** A message with one note
  shows `‹ 1/2 ›` in claude.ai's own UI; the extension can't hide native
  counters. The Prompt Tree panel excludes note branches from its own badges.
- **Retry streams update the panel when they finish**, not token-by-token (the
  retry request carries no pre-generated uuids; the model resyncs on
  completion).
- **Draft attachment capture is additive**: files removed from the composer
  after being seen may still be offered on restore, and reattachment uses a
  synthetic drop that claude.ai may ignore after an update (you get a notice
  and can re-add manually). Attachments over 5 MB total are not saved (banner
  says so).
- **Deleting a note deletes only the local anchor.** The side branch remains in
  the conversation tree (visible via native arrows if you go looking).

## Development

```sh
npm run typecheck   # tsc --noEmit (strict)
npm run build       # esbuild → dist/
npm run check       # both
```

- `docs/recon-report.md` — the API/DOM ground truth all code keys off.
- `docs/architecture.md` — module map, data flow, storage schema, decisions.
- `docs/test-checklist.md` — the manual test matrix; run it after any change.
- Every module's header comment states its responsibility and its
  failure/degradation behavior.
