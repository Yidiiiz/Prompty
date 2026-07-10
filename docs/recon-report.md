# Reconnaissance Report — claude.ai internal API & DOM (July 2026 captures)

All code in this repository keys off this report. Source of truth: the verified,
redacted live captures in Appendix A of the build prompt
(`claude-extension-build-prompt.md`). Where live behavior diverges from this
report, live behavior wins; update this report and the selector registry
(`src/shared/selectors.ts`) together.

## 1. Endpoint map (confirmed live)

All under `https://claude.ai/api/organizations/{org}` unless noted. Auth is
same-origin cookies attached automatically to in-page fetches; the extension
never reads, stores, or transmits session tokens.

| Purpose | Method | Path |
|---|---|---|
| Load conversation tree | GET | `/chat_conversations/{conv}?tree=True&rendering_mode=messages&render_all_tools=true&consistency=strong` |
| Switch branch (set active leaf) | PUT | `/chat_conversations/{conv}/current_leaf_message_uuid` |
| Send / edit / branch-compose | POST | `/chat_conversations/{conv}/completion` |
| Retry (assistant-side branch) | POST | `/chat_conversations/{conv}/retry_completion` |
| Upload file (binary) | POST | `/conversations/{conv}/wiggle/upload-file` |
| Auto-title (fires after first send) | POST | `/chat_conversations/{conv}/title` — ignored |

## 2. Conversation tree load — response shape

- `chat_messages` is a **flat array of every message across ALL branches**;
  structure is rebuilt from `parent_message_uuid` links.
- Root messages parent to the sentinel `00000000-0000-4000-8000-000000000000`.
  The model uses a virtual root; branching the first message of a chat means
  sending with the sentinel as parent.
- `index` is **global creation order, not branch position**. The active path is
  derived by walking parent links from top-level `current_leaf_message_uuid` up
  to the sentinel. Branches are never sorted by `index` for path purposes
  (creation order is used only for sibling display ordering and latest-leaf
  selection).
- **Message text lives in `content[].text` where `content[].type === "text"`**;
  the top-level `text` field is empty. All summarization, note anchoring, and
  `!@#%NOTE!@` marker detection read concatenated content text blocks
  (`extractText` in `src/shared/tree.ts`).
- The response includes `model` (used as the fallback model for
  extension-originated side-branch sends).

## 3. Send payload (completion POST)

- `parent_message_uuid` is a **top-level field** of the payload. Branch-compose
  rewrites exactly this one field and passes everything else through verbatim.
- **Native edit is byte-for-byte the same request** with `prompt` = the edited
  text and `parent_message_uuid` = the edited message's parent. Branch-compose
  is therefore behaviorally identical to a native edit from the server's
  perspective.
- `turn_message_uuids { human_message_uuid, assistant_message_uuid }` are
  **client-generated (UUIDv7-format) and adopted verbatim by the server** —
  confirmed against the resulting tree. The extension therefore knows a note
  branch's message uuids at send time and writes anchoring metadata immediately
  (`note-send-started` event). Extension-generated uuids use the same v7 format
  (`src/shared/uuid.ts`).
- First send of a new chat embeds `create_conversation_params { name, model, … }`
  — there is no separate conversation-create request; `parent_message_uuid` is
  absent (implicit sentinel root). The extension initializes new-conversation
  models from this request.
- Attachments use **two distinct arrays**, both preserved verbatim by
  branch-compose and draft restore:
  - `files[]` — `file_uuid` strings returned by `wiggle/upload-file` (binary
    uploads: images, PDFs);
  - `attachments[]` — text files inline as
    `{ file_name, file_type, file_size, extracted_content, origin: "user_upload", kind: "file" }`
    (extracted client-side, not uploaded).
- Other observed fields (`timezone`, `locale`, `model`, `effort`,
  `thinking_mode`, `tools[]`, `sync_sources[]`, `rendering_mode`) are passed
  through untouched. For extension-originated note sends, the last observed app
  send for the conversation is cloned as a payload template (maximum shape
  fidelity); a minimal payload from confirmed-required fields is the fallback.

## 4. Retry (assistant-side branching)

`POST …/retry_completion` with `prompt: ""` and `parent_message_uuid` = the
HUMAN message whose reply is regenerated. Sibling assistant messages under one
human message are retries. The captured retry payload shows **no
`turn_message_uuids`**, so the new assistant uuid is unknown at send time; the
extension resyncs with a tree refetch when the retry stream completes.

## 5. Branch switching

`PUT …/current_leaf_message_uuid` with `{"current_leaf_message_uuid": "<leaf>"}`
returns 200 echoing the body. **One request jumps to any leaf** (sibling 1 → 3
directly); the app then refetches the tree to re-render. The recon directive is
explicit: do **not** simulate arrow clicks.

**Flagged gap → documented deviation:** the captures confirm the PUT + refetch
sequence, but the SPA offers no external hook to make its own React state
re-render from a fetch it did not initiate. The extension mirrors the confirmed
sequence (PUT, model refetch) and then reloads the page to render the switched
branch. This is isolated in the `BranchSwitchAdapter`
(`src/content/branch-switch.ts`) so a soft re-render can replace it if one is
found. A capture of any app-internal event/cache invalidation triggered by the
native arrows (React Query cache key, custom event) would enable removing the
reload — see §8.

## 6. Streaming (SSE) format

`event:`/`data:` line pairs. Rules encoded in `src/page/sse.ts`:

- Assistant text = concatenated `content_block_delta` events with
  `delta.type === "text_delta"`.
- `thinking_delta` / `thinking_summary_delta` (typically index 0) are ignored
  for note/comment reply capture.
- `content_block_stop` ends a block; `message_delta` carries `stop_reason`;
  `message_stop` ends the turn. `message_limit` carries rate-limit state
  (observed, not consumed in v1).
- To capture a note's final reply the extension accumulates `text_delta`s and
  also refetches the tree after `message_stop` (the message uuid is already
  known from the pre-generated `turn_message_uuids`).

## 7. Stable DOM hooks (from the provided snapshot)

All in the selector registry (`src/shared/selectors.ts`); nothing else in the
codebase contains a selector.

| Hook | Selector | Used for |
|---|---|---|
| User message body | `[data-testid="user-message"]` | row mapping, branch button placement |
| Composer | `[data-testid="chat-input"]` | drafts, branch header dock, text restore |
| Edit control | `[data-testid="action-bar-edit"]` | hover-toolbar anchor for "Branch from here" |
| Retry control | `[data-testid="action-bar-retry"]` | assistant-row classification |
| Copy control | `[data-testid="action-bar-copy"]` | assistant-row classification |
| File input | `[data-testid="file-upload"]` | draft attachment capture |
| Branch arrows | `button[aria-label="Previous version"]` / `"Next version"` | registered for diagnostics; not clicked (see §5) |
| Selection popover | `div[data-selection-tooltip="true"]` | note-button placement (adjacent, never overlapping; the popover is fixed, transform-centered, z-index 50, pointer-events auto) |
| Landmark | `main` | structural fallback |

`validateSelectors()` runs at startup and logs/toasts required-selector
failures.

## 8. Gaps the captures do not answer (do not guess — capture before coding against)

1. **Assistant message container** has no dedicated `data-testid` in the
   snapshot. Current heuristic: a message-list row containing an
   action-bar copy/retry control but no `user-message` node
   (`src/content/dom-map.ts`). *Requested capture:* in DevTools, right-click an
   assistant reply → Inspect → copy the outerHTML of the row element and its
   two ancestors; if any carries a `data-testid`, promote it to the registry.
2. **Native arrow click traffic** — assumed to be the §5 PUT + tree refetch (the
   captures confirm those requests exist and that the app refetches). *Requested
   capture:* DevTools → Network, click a `‹ 2/3 ›` arrow once, and save the
   request list (names + methods) plus whether any state event fires without a
   reload. Needed only to improve the reload-based re-render, not for
   correctness.
3. **Hover-toolbar mount point** — the snapshot shows action-bar buttons inside
   the message row; if they are actually portaled elsewhere on some layouts,
   the "Branch from here" button will not appear (feature degrades with a
   toast). *Requested capture:* outerHTML of a user message row while hovered.
4. **`message_start` SSE event** — the stream capture starts at
   `content_block_delta`, so no uuid is read from the stream; not needed (uuids
   are pre-generated), noted for completeness.
5. **Composer draft persistence keys** — claude.ai loses drafts on reload
   (confirmed by the prompt); no localStorage key was captured that could be
   reused, so drafts live entirely in extension storage.

## 9. Design tokens (styling architecture)

Defined under `[data-theme=claude][data-mode=light|dark]`. Families: `--bg-*`,
`--text-*`, `--accent-*`, `--border-*`, `--danger-*`, `--oncolor-*`,
`--always-*`; fonts `--font-anthropic-sans/serif/mono`; a `--text-xs…6xl`
scale. **Color token values are raw HSL triplets** consumed as
`hsl(var(--bg-100))` (and `hsl(var(--x) / 0.5)` for alpha) — never used raw.

Implementation note (improvement over the prompt's suggested JS read): CSS
custom properties inherit across shadow boundaries, so all extension CSS
references tokens as `hsl(var(--token, <bundled fallback>))` directly. Theme
switches (`data-mode` flips) are applied by the CSS engine live with no
observers or JS re-reads. `validateTokens()` still reads computed styles once
at startup purely to log a redesign early (`src/shared/tokens.ts`).
