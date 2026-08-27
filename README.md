# Prompty

A personal-use Chrome extension (Manifest V3) that adds power-user tools to
claude.ai, built on the site's own conversation-tree structure.

Every feature can be switched on or off independently from the extension popup.

## Features

**Branch compose** — Write an alternative version of any earlier message using
the full composer, with attachments and paste support, instead of the small
inline edit box. The target message is ghosted, everything below it is hidden,
and your next send becomes a sibling of it.

**Prompt history panel** — A full-height overlay in the chat's left margin.
Prompts and responses are listed as pairs; messages with branches become
section headers with their numbered options beneath. Click a row to scroll to
that message, or a branch to switch to it without a page reload. The panel
collapses to an icon strip, and steps down to the strip or hides itself when
the window is too narrow.

**Notes** — Highlight text in an assistant reply and ask a question about it in
the margin. The exchange is sent as a hidden message on the current branch, so
no branch is created and no version arrows appear. It persists across reloads
and devices, and is rendered only in the margin.

**Comments** — The same margin exchange, anchored to a position in the reply
rather than to a highlight.

**Reply references** — When you quote a message with the site's reply action,
the quoted passage in your message gains an accent bar. Hover it to preview the
quote in its original formatting; click it to jump to the source message with
the exact span highlighted.

**Draft autosave** — Composer drafts, including branch, note, and comment
drafts and attachments up to 5 MB, survive reloads. A banner offers Restore or
Clear for drafts less than two hours old.

## Disclaimer

Prompty observes and replays claude.ai's undocumented internal API. It may
break at any time, and its use is at your own risk with respect to Anthropic's
Terms of Service. It is built for personal use only — do not publish it to the
Chrome Web Store or otherwise distribute it.

All data stays in your browser. The extension never reads, stores, or transmits
session tokens; requests authenticate through your browser's own same-origin
cookies.

## Installation

Requires Node.js 18+ and Chrome 111+.

```sh
npm install
npm run check        # typecheck and build
```

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this repository's `dist/` folder.
4. Open or reload a claude.ai tab.

After changing source, run `npm run build`, reload the extension from its card,
then reload the claude.ai tab.

## Usage

**Branch compose** — Hover one of your messages and click **Branch from here**
in its toolbar. A header bar appears above the composer with a Cancel button.
Type and send as normal; the send becomes a branch, and both the native
`‹ 2/3 ›` arrows and the panel will show the siblings.

**Prompt history panel** — The chevron collapses the panel to an icon strip,
one dot per prompt/response pair with fork glyphs at branch points. Collapse
state persists. Branch-point headers show the first two numbered options plus a
`▸ N more` caret; clicking one switches branches in place. Clicking a prompt
row highlights its whole bubble, a response row just the reply text. The panel
follows the chat, keeping the pair in view centered, and pauses while you
scroll the panel yourself. Clicking an entry in a long conversation loads and
jumps to the message even if it has not been rendered yet.

**Notes** — Select text in an assistant reply and click the ✎ button in the
right margin, then type your question in the margin composer. Ctrl-Enter or
Cmd-Enter sends, and the answer streams into the card. **Continue** asks a
follow-up in the same card, ⤢ expands to a full markdown modal, and 🗑
soft-deletes the note. Deleted notes can be restored at any time from the
"Deleted notes" section at the bottom of the panel.

**Comments** — Hover a reply with nothing selected and click the **+** in the
margin.

**Reply references** — Quote a message with the site's own reply action and
send. Hover the accent bar beside the quote to preview it formatted, or click
it to jump to the original.

**Drafts** — Drafts save automatically per conversation. On return, **Restore**
re-enters branch, note, or comment mode when the target still exists, and
**Clear** discards the draft.

## Troubleshooting

The extension degrades one feature at a time rather than breaking the page. If
something stops working, open DevTools → Console and filter for
`[prompt-tree]`.

| Symptom | Cause | Fix |
| --- | --- | --- |
| `selector validation failures` | A DOM hook was renamed upstream | Find the new equivalent in DevTools, preferring `data-testid`, `aria-label`, or landmarks over hashed class names, then update `src/shared/selectors.ts` |
| `design tokens missing` | Token families were renamed; cosmetic only, bundled colors are used | Update `TOKEN_FALLBACKS` in `src/shared/tokens.ts` |
| `unexpected conversation shape` | The tree endpoint changed | Compare a live response against `docs/recon-report.md` §2, then adjust `fromConversation` / `extractText` in `src/shared/tree.ts` |
| A `Prompty: … unavailable` toast | That one feature disabled itself for this page load | The toast names the broken dependency; the rest keeps working |
| Branch compose sends normally | The completion payload no longer carries a top-level `parent_message_uuid` | Check DevTools → Network → `completion`, then update `handleCompletion` in `src/page/fetch-patch.ts` |
| Notes stop answering | The payload template drifted, usually a 4xx on the extension's own `completion` POST | Compare against a native send and adjust `buildSideBranchPayload` in `src/page/api.ts` |
| Branch switching does nothing | The native version arrows lost their `aria-label`, or the `current_leaf_message_uuid` PUT no longer returns 200 | Both mechanisms are isolated in `src/content/branch-switch.ts`; see recon report §5 |
| Nothing works at all | The site may have moved off `window.fetch` | Confirm in the Network tab; interception lives in `src/page/fetch-patch.ts` |

When you find a changed shape, update `docs/recon-report.md` alongside the code
so the next breakage stays diagnosable.

## Known limitations

- **Branch jumps step through intermediate branches.** Switching drives the
  site's own version arrows, so jumping from 1 to 3 briefly renders branch 2.
  If the arrows cannot be found, the extension falls back to the API path plus
  a one-time page reload. Both mechanisms live in `BranchSwitchAdapter`.
- **Notes are part of the model's context.** In-thread notes (0.5.0 and later)
  create no branches and no native counters, but their content is visible to
  the model in later turns; each note instructs the model to treat it as a side
  question. Notes made before 0.5.0 remain side branches and still appear in
  the native `‹ 1/2 ›` counters.
- **Retry streams update the panel on completion**, not token by token, because
  the retry request carries no pre-generated uuids.
- **Draft attachment capture is additive.** Files removed from the composer
  after being seen may still be offered on restore, and reattachment uses a
  synthetic drop that the site may ignore after an update. Attachments over
  5 MB in total are not saved.
- **Deleting a note hides it; the messages remain.** Deletion is a soft delete,
  restorable from the panel, and the hidden note pair stays in the conversation
  data either way.

## Development

```sh
npm run typecheck   # tsc --noEmit (strict)
npm run build       # esbuild → dist/
npm run check       # both
```

| Document | Contents |
| --- | --- |
| `PROJECT.md` | Current feature specs, architecture summary, and condensed update history |
| `docs/recon-report.md` | The API and DOM ground truth all code keys off |
| `docs/architecture.md` | Module map, data flow, storage schema, and decisions |
| `docs/test-checklist.md` | The manual test matrix; run it after any change |

Every module's header comment states its responsibility and its degradation
behavior.
