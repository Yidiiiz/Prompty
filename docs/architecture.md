# Prompt Tree — Architecture

## Module map

```
src/
├─ manifest.json          MV3; two content scripts (MAIN + ISOLATED world), popup
├─ page/                  MAIN world, document_start — network truth
│  ├─ index.ts            entry: installs patches, handles content-script commands
│  ├─ fetch-patch.ts      window.fetch interception, parent_message_uuid rewrite,
│  │                      SSE teeing, org/model/send-template capture
│  ├─ sse.ts              completion SSE parser (text_delta / stop_reason / message_stop)
│  ├─ api.ts              extension-originated requests (tree refetch, leaf PUT,
│  │                      note side-branch send) via the saved original fetch
│  ├─ history-patch.ts    pushState/replaceState/popstate → url-changed events
│  └─ bridge.ts           postMessage sender/receiver (page side)
├─ content/               ISOLATED world, document_idle — model + UI
│  ├─ index.ts            entry: ConversationTree registry, navigation, feature
│  │                      lifecycle, always-on note-row hiding
│  ├─ bridge.ts           postMessage sender/receiver (content side)
│  ├─ ctx.ts              typed event bus contract + Feature interface
│  ├─ observer.ts         THE single rAF-batched MutationObserver
│  ├─ dom-map.ts          DOM rows ⇄ active-path uuids (order/sender alignment)
│  ├─ branch-switch.ts    BranchSwitchAdapter (native arrow stepping;
│  │                      leaf PUT + reload fallback)
│  ├─ composer.ts         composer read/write/dock/file-reattach helpers
│  ├─ styles.ts           pt-* classes applied to native rows (ghost/hide/pulse)
│  ├─ toast.ts            one-per-id degradation toasts (shadow DOM)
│  └─ features/
│     ├─ branch-compose.ts   F1: hover button, ghost/hide, header bar, override arm
│     ├─ tree-panel.ts       F2: path list, sibling badges/stubs, compact mode
│     ├─ note-cards.ts       F3+F4 shared: gutter, cards, composer, submit flow,
│     │                      streaming, modal, unanchored drawer feed
│     ├─ notes.ts            F3 entry: selection → note button → anchor build
│     ├─ comments.ts         F4 entry: hover → "+" button → caret/ratio anchor
│     ├─ anchoring.ts        text indexing, quote/prefix/suffix/offset resolution
│     └─ drafts.ts           F5: capture (composer + note composer + files),
│                            restore banner, mode re-entry, lazy expiry
├─ shared/                world-agnostic building blocks
│  ├─ messages.ts         bridge protocol types + envelope + sentinel uuid
│  ├─ tree.ts             ConversationTree (flat array → tree; active path;
│  │                      local send application; note-subtree marking)
│  ├─ note-protocol.ts    !@#%NOTE!@ wire format build/parse/recognize
│  ├─ selectors.ts        THE selector registry + validateSelectors()
│  ├─ tokens.ts           design-token CSS var helpers + validateTokens()
│  ├─ storage.ts          chrome.storage records (settings/notes/drafts/panel)
│  │                      + IndexedDB draft attachments
│  ├─ summary.ts          swappable Summarizer (v1: markdown-strip + truncate)
│  ├─ markdown.ts         small safe renderer for note cards/modal
│  ├─ uuid.ts             UUIDv7 (matches claude.ai's client-generated ids)
│  └─ util.ts             debounce, rafThrottle, EventBus, escapeHtml, clamp
└─ popup/                 settings popup (per-feature toggles, live via
                          chrome.storage.onChanged)
```

## Data flow

```
            claude.ai app (React)
                 │  fetch()
                 ▼
┌ MAIN world ────────────────────────────────────────────┐
│ fetch-patch: classify request                          │
│   tree GET ──────────────► clone → JSON                │
│   completion POST ───────► (rewrite parent if armed)   │
│   │                        tee response → SSE parser   │
│   leaf PUT / retry ──────► observe                     │
│ api.ts: note sends / leaf PUT / tree refetch           │
│          (original fetch — never re-intercepted)       │
└────────────┬───────────────────────────────────────────┘
             │ window.postMessage (origin-checked, namespaced)
             ▼
┌ ISOLATED world ────────────────────────────────────────┐
│ content/index: ConversationTree registry (per conv)    │
│   conversation-loaded → rebuild tree                   │
│   send-observed/stream-* → local model application     │
│   leaf-switched → active path update                   │
│         │ typed EventBus ("tree-updated", …)           │
│         ▼                                              │
│ features (read model + DomMap, write UI)               │
│   DomMap: rows ⇄ uuids, rebuilt on the single          │
│   rAF-batched MutationObserver tick                    │
└────────────────────────────────────────────────────────┘
             │ commands (set-parent-override, send-side-branch,
             │           switch-leaf, request-tree)
             ▲ back up to the page script
```

Principles: the DOM is never a data source (only a render target + geometry);
the network is never touched by the app-facing patch beyond the single
documented rewrite; extension-originated traffic always uses the saved original
fetch.

## Storage schema (chrome.storage.local unless noted)

| Key | Value |
|---|---|
| `pt.settings` | `{ branchCompose, treePanel, notes, comments, draftAutosave: boolean }` |
| `pt.panel.collapsed` | `boolean` |
| `pt.notes.{convUuid}` | `NoteRecord[]`: `{ noteId, kind: "note"\|"comment", conversationUuid, anchorMessageUuid, noteBranchRootUuid, quote?, prefix?(20), suffix?(20), charOffset?, anchorText?(40), offsetRatio?, createdAt }` — anchoring metadata only; note content lives in Claude's own tree |
| `pt.draft.{convUuid}` | `DraftRecord`: `{ conversationUuid, text, mode: normal\|branch\|note\|comment, branchTargetUuid?, branchParentUuid?, anchor?, hasAttachments?, attachmentsSkipped?, savedAt }` |
| IndexedDB `prompt-tree-drafts` / store `draftFiles` | key = convUuid → `{ name, type, blob }[]` (≤ 5 MB total) |

## Key decisions & deviations (details in docs/recon-report.md)

1. **MAIN-world content script instead of a `<script>`-tag injection** — the
   manifest's `world: "MAIN"` (Chrome 111+) achieves the same page-context
   patching at document_start with fewer moving parts and no CSP exposure.
2. **Branch switching = native arrow stepping (v0.2.0, user-directed), leaf
   PUT + reload as fallback**, both isolated behind `BranchSwitchAdapter`.
   Driving the app's own version arrows makes the app perform its PUT +
   refetch (observed by the fetch patch), re-rendering in place with no
   reload; the API path remains for when the arrows are unavailable, since
   the SPA exposes no external re-render hook.
3. **Note content is not duplicated locally** — cards render the question/reply
   from the note's own (hidden, in-thread as of 0.5.0) messages in the
   conversation tree (server-persistent, cross-device); storage holds anchors
   only. Live streams overlay until the post-send tree refetch lands. The
   page script reparents the app's next send past the hidden pair
   (`set-thread-tail`), so no branches are ever created.
4. **Design tokens via CSS var inheritance into shadow roots** — no JS token
   reads or theme observers needed; bundled HSL fallbacks keep the UI legible
   if tokens vanish.
5. **XMLHttpRequest is not patched** — all captured claude.ai traffic uses
   fetch; if tree loads stop being observed the extension toasts its
   unavailability instead of guessing.
