# Build Prompt: "Prompt Tree" — a Claude.ai Power-User Browser Extension

## Role and Objective

You are building a Chrome browser extension (Manifest V3) called **Prompt Tree** that augments claude.ai with four features: branch-composing from the main input box, a conversation-tree history panel, inline notes, and Google-Docs-style comments — plus draft autosaving. This is a personal-use tool. Code quality matters more than feature count: if a feature cannot be built reliably, implement a degraded-but-honest version and document the limitation.

Before writing any code, read this entire prompt. Then produce the architecture plan described in "Deliverables" before implementation.

---

## Critical Architectural Foundation (read first — everything depends on this)

### How claude.ai conversations actually work

Claude.ai stores each conversation as a **tree of messages**. Every message has a `uuid` and a `parent_message_uuid`. "Branches" are sibling messages sharing a parent; the native UI's `< 2/3 >` arrows switch which leaf path is rendered. The rendered chat is always one root-to-leaf path; the model's context for the next message is exactly that path.

### Required strategy: API interception, not DOM scraping

The extension MUST build its understanding of the conversation from claude.ai's own network traffic, not from parsing the DOM:

1. **Inject a page-context script** (via a content script injecting a `<script>` tag, since content scripts run in an isolated world) that monkey-patches `window.fetch` (and `XMLHttpRequest` if needed) to observe:
   - Conversation-load responses (these contain the full message tree: uuids, parent uuids, text, sender, timestamps).
   - Outgoing completion/send requests (these contain `parent_message_uuid`, the prompt text, and attachments).
   - Streaming completion responses (to capture assistant replies as they finish).
2. Relay observed data to the content script via `window.postMessage` with a namespaced message type and origin check.
3. Maintain a single in-memory **ConversationTree** model per conversation uuid: `{ uuid, parentUuid, sender, text, index, children[] }` plus the currently active leaf path.
4. **Sending to a specific branch** works by intercepting the outgoing send request and rewriting its `parent_message_uuid` before it leaves — this is how branch-compose mode and notes are implemented. Never fake a send by simulating keystrokes into hidden UI.
5. **Navigating to a specific branch** (e.g., jumping from sibling 1 of 3 directly to sibling 3) should be done the same way the native UI does it. Inspect what claude.ai does when the branch arrows are clicked (it either refetches the tree with a different leaf or updates local state); replicate the minimal necessary action. If no clean API path exists, fall back to programmatically clicking the native arrow buttons the required number of times, but treat this as a last resort and isolate it behind an adapter so it can be replaced.

### Resilience requirements (claude.ai updates frequently)

- **One selector registry module** (`selectors.ts`/`.js`): every DOM selector used anywhere in the extension lives here, with a comment describing what it targets and a runtime `validateSelectors()` check that logs which selectors failed. No selectors inline anywhere else.
- Prefer stable hooks: `data-testid` attributes, ARIA roles/labels, structural landmarks (`main`, the composer's `contenteditable`), and element behavior — over class names. **Never use minified/hashed class names** for element targeting.
- All DOM augmentation runs through a **single throttled MutationObserver** (batch mutations, process at most once per animation frame). No `setInterval` polling. No forced synchronous layout in loops (batch reads, then writes).
- Every feature must degrade gracefully: if its DOM hooks or API shapes break, it disables itself, shows a small non-blocking "Prompt Tree: [feature] unavailable after a claude.ai update" toast once, and never breaks native claude.ai behavior.
- SPA navigation: detect conversation changes via URL changes (History API patching in the page script) and re-initialize per conversation.

### Styling

Do NOT reuse claude.ai class names for styling. At startup, read the CSS custom properties (design tokens) from the document root / body computed styles — background, surface, text, muted-text, border, and accent colors, plus the font family — and drive ALL extension UI from those tokens (with sensible fallbacks if a token is missing). The result must look native: minimal, warm, rounded corners, subtle borders, matching light/dark theme automatically because tokens are read live. Namespace every extension class/id with `pt-` and render UI inside Shadow DOM wherever feasible to prevent style bleed in either direction.

### Legal/stability note (include in README)

This extension observes and replays claude.ai's undocumented internal API. It may break at any time and its use is at the user's own risk with respect to Anthropic's Terms of Service. Personal use only; do not publish to the Chrome Web Store.

---

## Feature 1: Branch-Compose Mode

Lets the user write a branch (an edit/alternative of an existing user message) using the **main composer** at the bottom instead of the small inline edit box, keeping full native composer capabilities (attachments, long text, paste, etc.).

Behavior:

1. Entry: a small "Branch from here" button the extension adds to each user message's hover toolbar (adjacent to native edit/copy controls).
2. On activation:
   - The targeted message gets `opacity: ~0.45` (ghosted) with a subtle left accent border.
   - All messages **below** it in the current path are hidden (`display: none` via a `pt-branch-hidden` class — never removed from DOM).
   - A **branching header bar** appears docked directly above the main composer: label "Branching from: ‹first ~8 words of the target message…›" and a **Cancel** button. Style with the design tokens; keep it one line tall.
3. While active, the user types in the native composer as normal. On send, the intercepted outgoing request's `parent_message_uuid` is rewritten to the **parent of the ghosted message** (making the new message a sibling/branch of it). Attachments and all other request fields pass through untouched.
4. After a successful send: exit branch mode, un-ghost, un-hide (claude.ai will re-render onto the new branch anyway; reconcile with whatever it renders).
5. Cancel: restore all hidden/ghosted messages, remove the header, composer returns to normal. Also exit cleanly on conversation navigation.
6. Toggle: the mode is per-activation (entered via the button, exited via Cancel/send). A global on/off switch for the whole feature lives in the extension's settings popup.

Edge cases: user activates branch mode then scrolls — ghost/hide states must persist; user activates on a message that already has siblings — new message becomes an additional sibling; send fails — stay in branch mode, show the native error, don't lose the draft.

---

## Feature 2: Prompt Tree Panel (chat history + branch navigation)

A collapsible panel titled **"Prompt Tree"** overlaid on the **left edge of the chat scroll area** (not inside it — `position: fixed`/absolute relative to the chat container so it does not scroll with messages). It must not cover claude.ai's own sidebar; when the native sidebar is open, the panel sits flush against it.

Contents:

1. One entry per message in the **currently active path**: a dot/line indicator (user vs assistant visually distinct), plus a **local summary** — first ~6 words of the message, ellipsized. No API calls for summaries in v1; pure text truncation (strip markdown syntax first). Design the summary function as a swappable module so an LLM-generated summary could replace it later.
2. **Click an entry** → smooth-scroll the chat so that message's top aligns near the top of the viewport, with a brief highlight pulse on the message.
3. **Branch indicators**: any message with siblings shows a small `2/3`-style badge and expandable stubs for the other siblings (their first ~4 words). **Clicking a sibling switches the conversation to that branch** using the branch-navigation adapter from the architecture section — this must support jumping directly from any sibling to any other (1 → 3), not just adjacent steps. After switching, the panel re-renders from the new active path.
4. Panel updates live as messages stream in (driven by the ConversationTree model, not DOM diffing).
5. **Hide/show**: a chevron collapses the panel to a thin edge tab. State persists per browser via `chrome.storage.local`.
6. **Compact mode**: when the viewport is narrow (< ~1100px) or the chat is short (< 4 messages), the panel auto-collapses to a **minimal vertical node strip**: just dots and branch-fork glyphs, tooltips on hover, same click behavior. Keep this deliberately simple in v1 — it is a fallback, not a feature showcase.

Visuals: modern, minimal, token-driven. Thin connector lines between nodes; forks drawn where branches exist. No heavy graph library — hand-rolled flex/SVG is fine and preferred.

---

## Feature 3: Notes (branch-powered inline annotations)

Lets the user highlight text in an assistant message and attach a small Q&A note — a clarification or quick definition — **without polluting the main thread's context**.

### Context-safety mechanism (this is the core design)

A note is sent as a **side branch**: a new user message whose `parent_message_uuid` is the annotated message's uuid, created while the main thread's active leaf is elsewhere (or restored afterward). Because future main-thread messages descend from the main leaf — not the note — the note's prompt and response are **never in the main thread's context**. The note conversation persists inside Claude's own tree (so it survives reloads and syncs across devices at the data level), while the extension stores anchoring metadata locally.

### Note prompt format

Every note message the extension sends is wrapped with a machine-readable header the extension uses to recognize and hide note messages, plus instructions to the model:

```
!@#%NOTE!@
{"anchorUuid":"<message-uuid>","quote":"<exact highlighted text, truncated to 300 chars>","charOffset":<n>}
---
You are answering a small inline margin note attached to the quoted text above, from a longer conversation. Answer concisely — a short paragraph at most, no headers, no lists unless essential. Do not reference this header or the note mechanism. Ignore the JSON metadata line entirely.
---
<user's actual note question>
```

The extension must **hide from view** (in chat and in the Prompt Tree panel) any message whose text begins with `!@#%NOTE!@`, and hide its assistant reply, rendering both only inside the note UI.

### UX flow

1. User selects text inside an assistant message → the extension shows a small **note button** in the right margin of the chat column, vertically aligned with the **first line of the selection** (compute via `Range.getClientRects()[0]`). It should appear adjacent to where claude.ai's native selection popover appears, without overlapping it.
2. Clicking it opens a compact note composer **inline in the right margin at that vertical position** — the note prompt is typed here, **never in the main composer**, and never appears in the chat.
3. On submit: send the note as a side branch (per mechanism above), stream the response **into the note card**, then ensure the main thread's active leaf is restored so the next normal message continues the main conversation.
4. The note card shows: the quoted text (small, muted), the user's question, the response, a fullscreen/expand button (modal with full markdown rendering), and a delete button (removes local metadata + hides the card; the branch remains in Claude's tree, orphaned and harmless).
5. Multiple notes per message must work. Note cards live **inside the same scroll container as the chat** (they scroll with their message), positioned in a right-margin gutter column. If two notes' positions collide vertically, stack them with minimal offset (Google-Docs-style push-down) and draw a subtle connector line to the anchor line.

### Anchoring (robust, not index-based)

Store per note in `chrome.storage.local`, keyed by conversation uuid:
```
{ noteId, conversationUuid, anchorMessageUuid, noteBranchRootUuid,
  quote, prefix (20 chars before), suffix (20 chars after),
  charOffset, createdAt }
```
Re-anchor on render: find `quote` within the anchor message's text (use prefix/suffix to disambiguate duplicates, charOffset as final tiebreaker). If the anchor text can't be found (message edited away), show the note in the gutter at the top of that message flagged "anchor moved". If the anchor message uuid no longer exists in the tree, list the note in a small "unanchored notes" drawer at the panel's bottom rather than deleting it.

---

## Feature 4: Comments (position-based, no highlight)

Identical to Notes in composer UI, sending mechanism (`!@#%NOTE!@` header with `"kind":"comment"` in the metadata JSON), card rendering, and storage — with these differences:

1. Trigger: when the mouse hovers over an assistant message and **no text is selected**, show a Google-Docs-style **"+ comment" icon** in the right margin, tracking the mouse's vertical position (throttled to animation frames).
2. Clicking opens the comment composer at that vertical position.
3. **Anchoring**: no quote. Instead resolve the mouse's Y position to the nearest text node inside the message (`document.caretRangeFromPoint` / `caretPositionFromPoint`), and store `{ anchorMessageUuid, anchorText: <that node's first 40 chars>, offsetRatio: <position within message, 0–1> }`. Re-anchor by finding `anchorText`, falling back to `offsetRatio` of the message's rendered height — this keeps the comment's position correct under any zoom/scaling/reflow. Never store raw pixel coordinates.
4. In the note prompt sent to Claude, include the surrounding ~200 chars of message text as context in place of a quote.

---

## Feature 5: Draft Autosave

Claude.ai loses the composer draft on reload. Fix that:

1. **Capture**: on every composer input (debounced ~500ms), save the draft to `chrome.storage.local`, keyed by conversation uuid, including:
   - `text`
   - `mode`: `normal` | `branch` | `note` | `comment`
   - If `branch`: the ghosted message's uuid and its parent uuid.
   - If `note`/`comment`: the full anchor object (quote/prefix/suffix/offset or anchorText/offsetRatio) and anchor message uuid.
   - Attachments: serialize files ≤ **5 MB total** into IndexedDB (name, MIME type, Blob); over the cap, save text only and note "attachments not saved" in the restore banner.
   - `savedAt` timestamp.
2. **Restore**: on conversation load, if a draft exists and is < **2 hours** old, show a slim banner above the composer: *autosaved message* (italic heading) with the draft's first line, and two buttons — **Restore** (re-enters the saved mode: re-activates branch mode on the saved target, or reopens the note/comment composer at the re-resolved anchor, and refills text + reattaches files) and **Clear**.
3. A draft left untouched in the composer keeps refreshing its `savedAt` (still autosaving), so it never expires while "live". Expired drafts are purged lazily on load. Successful send clears the draft immediately.
4. If restoring a branch/note draft whose target uuid no longer exists, restore as a normal draft with a note explaining why.

---

## Non-Functional Requirements

- **Performance budget**: no user-perceptible input latency in the composer; observer callbacks < 4ms typical; zero polling timers; all margin-position math batched (read phase → write phase). Extension idle CPU must be ~0 when the tab is inactive.
- Works across: page reload, conversation switch (SPA nav), opening old conversations (tree rebuilt from the conversation-load response), new conversations (initialize on first message), streaming responses.
- Plain **TypeScript compiled with esbuild** (or vanilla JS if you can keep it equally organized) — no framework, no runtime dependencies beyond what's essential. Straightforward code beats clever code; no shortcuts like brittle timeouts (`setTimeout`-and-hope) in place of real event/observer handling.
- Clear module layout: `page-inject/` (fetch patching, tree events), `content/` (features, each in its own module), `shared/` (ConversationTree model, storage, selectors, tokens), `popup/` (settings: per-feature toggles).
- Every module gets a header comment explaining its responsibility and its failure/degradation behavior.

## Provided Inputs (ground truth — use these, do not guess)

**Appendix A at the end of this document contains verified, redacted live captures** of every endpoint, payload, the SSE stream format, the selection-popup DOM, and the design-token system — this is the authoritative reference; consult it whenever a shape is in question. In addition, these raw source files may be attached alongside this prompt (the appendix is derived from them):

1. A saved DOM snapshot of a conversation page containing at least one branched message (shows the composer, message containers, hover toolbars, branch pagination arrows, and native selection popover).
2. The JSON response of the conversation-load request (the full message tree: uuids, parent uuids, senders, text).
3. The request body of an outgoing message send (shows where `parent_message_uuid`, prompt text, and attachment references live).
4. The site's `:root`/body CSS custom properties (design tokens).

### Confirmed endpoint patterns (from live reconnaissance)

- **Conversation tree load** — `GET https://claude.ai/api/organizations/{org_uuid}/chat_conversations/{conversation_uuid}?tree=True&rendering_mode=messages&render_all_tools=true&consistency=strong` → returns the conversation object including a `chat_messages` array and a top-level `current_leaf_message_uuid` identifying the active branch path. Confirmed shape details:
  - The array is **flat and contains every message across ALL branches**, each with `uuid`, `parent_message_uuid`, `sender` (`human`/`assistant`), `index`, timestamps, `attachments[]`, `files[]`. One fetch rebuilds the whole tree.
  - **Root-level messages have the sentinel parent `00000000-0000-4000-8000-000000000000`.** Model the tree with a virtual root node; branching the first message of a chat means sending with this sentinel as the parent uuid.
  - **`index` is global creation order, NOT position within a branch.** Derive the active path by walking parent links from `current_leaf_message_uuid` up to the sentinel. Never sort a branch by `index`.
  - **Message text lives in the `content` array (`content[].type === "text"` blocks), not the top-level `text` field**, which is empty. All summarization, note anchoring, and marker detection (`!@#%NOTE!@`) must read concatenated `content` text blocks.
- **Branch switching** — `PUT .../chat_conversations/{conversation_uuid}/current_leaf_message_uuid` with JSON body `{"current_leaf_message_uuid": "<target-leaf-uuid>"}` (confirmed live; returns 200 with the same shape echoed back). Sets the active leaf directly, so jumping to ANY sibling branch (e.g., 1 → 3) is one request — do not simulate arrow clicks. The app refetches the tree endpoint afterward to re-render; mirror that sequence. Authentication is automatic (extension code runs in-page, cookies attach to same-origin fetches); never handle or store session tokens.

- **Sending / conversation creation** — `POST .../chat_conversations/{conversation_uuid}/completion` (confirmed live): the payload includes `prompt` (message text), `attachments: []`, `files: []`, `tools[]`, `timezone`, `locale`, `model`, `rendering_mode`, and:
  - `create_conversation_params { name, model, ... }` — on the FIRST message of a new chat, conversation creation is embedded in the send; there is no separate create request. The extension initializes new conversations from this request.
  - `turn_message_uuids { human_message_uuid, assistant_message_uuid }` — **the client pre-generates both message uuids** and the server adopts them verbatim (confirmed against the resulting tree). The extension therefore knows a note branch's message uuids at send time, before the response streams — write anchoring metadata immediately from these.
  - **`parent_message_uuid` is a top-level field of the send payload** (confirmed live), alongside `prompt`. The branch-compose rewrite is exactly: change this one field, pass everything else through.
  - **Native edit uses the identical mechanism** (confirmed live): an edit is a normal completion send whose `parent_message_uuid` is the edited message's parent. Branch-compose is therefore behaviorally identical to native edit — expect the server to treat it exactly the same.
  - **Retry** (assistant-side branching) — `POST .../chat_conversations/{conversation_uuid}/retry_completion` with **`prompt: ""`** and `parent_message_uuid` set to the human message whose reply is regenerated (confirmed live). Tree logic: sibling assistant messages under one human message are retries.
  - **File upload** — `POST .../conversations/{conversation_uuid}/wiggle/upload-file` → response includes `file_uuid` (confirmed live). Attachments use TWO distinct payload fields (both confirmed live): **`files[]`** carries the `file_uuid` string(s) returned by upload-file (binary uploads — images, PDFs); **`attachments[]`** carries text files inline as objects `{ file_name, file_type, file_size, extracted_content (full text), origin: "user_upload", kind: "file" }` — text is extracted client-side and embedded, not uploaded. Branch-compose and draft-restore must preserve BOTH arrays verbatim when rewriting a send.
  - The parent-message field does not appear on a new-chat first send (implicit sentinel root).

### Confirmed streaming (SSE) response format

The completion response is Server-Sent Events: `event:` / `data:` line pairs. Assistant text arrives as `content_block_delta` events whose `delta.type === "text_delta"` — concatenate their `delta.text` in order. Thinking arrives as separate `thinking_delta` / `thinking_summary_delta` deltas (typically index 0) which the extension ignores for note/comment reply capture. A block ends with `content_block_stop`; the turn ends with `message_delta` (carrying `stop_reason`) then `message_stop`. A `message_limit` event carries rate-limit state. To render a note reply live, parse `text_delta`s from the intercepted response stream; to simply capture the final reply, wait for `message_stop` then read the message (uuid already known from the send's pre-generated `turn_message_uuids`) — or refetch the tree.

### Confirmed styling architecture

The design tokens are defined in claude.ai's CSS under `[data-theme=claude][data-mode=light]` and `[data-theme=claude][data-mode=dark]` selectors on token families `--bg-*`, `--text-*`, `--accent-*`, `--border-*`, `--danger-*`, `--oncolor-*`, `--always-*`, plus font tokens (`--font-anthropic-sans`, `--font-anthropic-serif`, `--font-anthropic-mono`). **Color token values are raw HSL triplets** consumed as `hsl(var(--bg-100))` — extension CSS must wrap tokens in `hsl()` (and `hsl(var(--x) / 0.5)` for alpha), never use the raw value directly. Read values at runtime via `getComputedStyle` so theme switches are picked up; observe the `data-mode` attribute for live light/dark changes.

Confirmed stable DOM hooks (present in the provided snapshot): `data-testid="user-message"`, `data-testid="chat-input"` (composer), `data-testid="action-bar-edit"` / `"action-bar-retry"` / `"action-bar-copy"`, `data-testid="file-upload"`, branch pagination buttons with `aria-label="Previous version"` and `aria-label="Next version"` beside a visible `N / M` counter, and the text-selection popup container `div[data-selection-tooltip="true"]` (position: fixed, transform-centered on the selection, z-index 50, pointer-events: auto — the extension's note button renders adjacent to it, never overlapping, repositioned on the same selection events). Prefer these over any class-based selectors.

These captures are the authoritative source for endpoint paths, payload shapes, DOM hooks, and styling tokens. Derive all selectors and API interactions from them. If something needed is missing from the captures, do not invent it — ask for a specific additional capture and provide the exact DevTools steps or snippet to obtain it. Expect these shapes to drift over time; that is what the selector registry and degradation rules exist for.

## Deliverables (in order)

1. **Reconnaissance report**: analyze the provided captures and document the exact endpoint paths and payload shapes for conversation load, send, and branch switching, plus the stable DOM hooks found. Flag anything the captures don't answer (e.g., what request fires when a branch arrow is clicked) and request that capture before coding against it. All subsequent code keys off this report.
2. **Architecture doc** (~1 page): module map, data flow diagram (page script → content script → features), storage schema.
3. Full extension source with manifest, build script, and README (install steps, the ToS/stability disclaimer, troubleshooting section for "a claude.ai update broke X").
4. A manual test checklist covering every edge case named in this prompt.

If any part of this prompt conflicts with what reconnaissance reveals about claude.ai's current implementation, the reconnaissance wins — adapt the design, document the deviation, and preserve the user-facing behavior as specified.

---

# Appendix A — Verified Reference Captures

The following are real, redacted captures from a live claude.ai session (July 2026), confirming every endpoint and payload shape referenced above. `{org}` replaces the organization uuid and `{conv}` replaces a conversation uuid throughout. These are the ground truth; when in doubt, match these shapes exactly. (claude.ai changes over time — if live behavior diverges, prefer live behavior and document the deviation.)

## A.1 — Conversation tree load

```
GET https://claude.ai/api/organizations/{org}/chat_conversations/{conv}?tree=True&rendering_mode=messages&render_all_tools=true&consistency=strong
```

Response (abridged — real conversations repeat the message object per node across all branches):

```json
{
  "uuid": "{conv}",
  "name": "Main branch greeting response",
  "model": "claude-opus-4-8",
  "current_leaf_message_uuid": "019f3e6a-40f5-7781-9f0a-192a6d48d4db",
  "chat_messages": [
    {
      "uuid": "019f3e54-bcd7-790e-8728-9143e4799a2c",
      "text": "",
      "content": [
        { "type": "text", "text": "main branch respond \"hi\"", "citations": [] }
      ],
      "sender": "human",
      "index": 0,
      "attachments": [],
      "files": [],
      "parent_message_uuid": "00000000-0000-4000-8000-000000000000"
    },
    {
      "uuid": "019f3e54-bcd7-7b52-b5c6-c08c663367f5",
      "content": [ { "type": "text", "text": "hi", "citations": [] } ],
      "sender": "assistant",
      "index": 1,
      "stop_reason": "end_turn",
      "parent_message_uuid": "019f3e54-bcd7-790e-8728-9143e4799a2c"
    }
    /* ...more messages; siblings share a parent_message_uuid; root messages
       use the sentinel parent 00000000-0000-4000-8000-000000000000 */
  ]
}
```

Key facts confirmed by this capture:
- Flat array of ALL messages across ALL branches; rebuild the tree from `parent_message_uuid` links.
- Root messages parent to the sentinel `00000000-0000-4000-8000-000000000000`.
- `index` is global creation order, NOT branch position — derive the active path by walking parents up from `current_leaf_message_uuid`.
- Real text is in `content[].text` where `type === "text"`; the top-level `text` field is empty.

## A.2 — Branch switching (jump to any sibling)

```
PUT https://claude.ai/api/organizations/{org}/chat_conversations/{conv}/current_leaf_message_uuid
Content-Type: application/json

{"current_leaf_message_uuid": "019f3e55-e059-7cad-8c76-7fab17011aa6"}
```

Returns `200` echoing the same body. The app then refetches A.1 to re-render. This one request moves the active path to any leaf — no arrow-click simulation.

## A.3 — Send a message (also used for edit)

```
POST https://claude.ai/api/organizations/{org}/chat_conversations/{conv}/completion
```

```json
{
  "prompt": "hi",
  "parent_message_uuid": "019f3f4c-ba14-79cd-bbb7-6926ba65fb53",
  "timezone": "America/New_York",
  "locale": "en-US",
  "model": "claude-opus-4-8",
  "effort": "low",
  "thinking_mode": "auto",
  "tools": [ /* large array of tool/widget definitions — pass through untouched */ ],
  "turn_message_uuids": {
    "human_message_uuid": "019f3f53-8769-71b0-8160-c86835378b38",
    "assistant_message_uuid": "019f3f53-8769-75de-b0ed-6b9ca8c59b6c"
  },
  "attachments": [],
  "files": [],
  "sync_sources": [],
  "rendering_mode": "messages"
}
```

- **`parent_message_uuid`** is the only field branch-compose rewrites (set it to the parent of the message being branched from). Everything else passes through verbatim.
- **`turn_message_uuids`** are client-generated; the server adopts them. The extension knows a message's uuid before the reply streams.
- A **native edit** is byte-for-byte the same request with `prompt` = the edited text and `parent_message_uuid` = the edited message's parent (confirmed: an edit of "hi" → "hello" produced this exact shape).

## A.4 — New conversation (first message)

Same `completion` endpoint, but the first send of a new chat additionally carries:

```json
{
  "prompt": "hi",
  "attachments": [],
  "files": [],
  "create_conversation_params": {
    "name": "",
    "model": "claude-opus-4-8",
    "include_conversation_preferences": true,
    "paprika_mode": null,
    "compass_mode": null,
    "enabled_imagine": true,
    "is_temporary": false,
    "tool_search_mode": "auto"
  },
  "turn_message_uuids": {
    "human_message_uuid": "019f3f4c-ba14-71fc-bff1-1de23c398328",
    "assistant_message_uuid": "019f3f4c-ba14-79cd-bbb7-6926ba65fb53"
  }
}
```

No separate "create conversation" request exists — creation is embedded here. (A `.../title` request fires afterward to name the chat; the extension can ignore it.) The resulting first human message parents to the sentinel root.

## A.5 — Retry (regenerate an assistant reply → assistant-side branch)

```
POST https://claude.ai/api/organizations/{org}/chat_conversations/{conv}/retry_completion
```

```json
{
  "prompt": "",
  "parent_message_uuid": "019f3f5d-9fa5-75bc-ac32-2bf3f8d9e4cb",
  "model": "claude-opus-4-8",
  "tools": [ /* ... */ ]
}
```

Empty `prompt`; `parent_message_uuid` is the HUMAN message whose reply is being regenerated. Result: a new assistant sibling under that human message.

## A.6 — File upload

```
POST https://claude.ai/api/organizations/{org}/conversations/{conv}/wiggle/upload-file
```

Response:

```json
{
  "success": true,
  "file_uuid": "6c67c8ba-f803-4855-b287-3a36d0dbfeeb",
  "file_name": "newchat.txt",
  "file_kind": "blob",
  "size_bytes": 2574
}
```

Then, in the `completion` send:
- **Binary files (images, PDFs):** the returned `file_uuid` string goes in the `files: []` array.
- **Text files:** sent inline in `attachments: []` as an object with `file_name`, `file_type`, `file_size`, `extracted_content` (the full extracted text), `origin: "user_upload"`, `kind: "file"` — no upload step; text is extracted client-side and embedded.

Branch-compose and draft-restore must preserve BOTH arrays verbatim.

## A.7 — Streaming (SSE) completion response

`Content-Type: text/event-stream`. Line pairs `event: <name>` / `data: <json>`:

```
event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"..."}}

event: content_block_start
data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":"","citations":[]}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"1\n2\n3..."}}

event: content_block_stop
data: {"type":"content_block_stop","index":1}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}

event: message_limit
data: {"type":"message_limit","message_limit":{ /* rate-limit windows */ }}

event: message_stop
data: {"type":"message_stop"}
```

Parsing rules: concatenate `delta.text` from `content_block_delta` where `delta.type === "text_delta"` to build the assistant reply. Ignore `thinking_delta` / `thinking_summary_delta` (index 0) for note/comment capture. The turn is complete at `message_stop`. To capture a note's final reply, either accumulate `text_delta`s or wait for `message_stop` and read the message by its pre-known uuid (from A.3's `turn_message_uuids`).

## A.8 — Text-selection popup (note anchor target)

```html
<div data-selection-tooltip="true"
     style="position: fixed; top: 0; left: 0; z-index: 50; pointer-events: auto;
            transform: translate(363px, 318px) translateX(-50%);">
  <div class="flex ... rounded-lg ...">
    <button ...>Reply<svg>...</svg></button>
  </div>
</div>
```

Stable hook: `div[data-selection-tooltip="true"]`. It is fixed-positioned, transform-centered above the selection, `z-index: 50`, `pointer-events: auto`. The note button must render adjacent (offset right), at ≥ z-index 50, without overlapping (overlap steals clicks), repositioned on the same selection events.

## A.9 — Design tokens

Defined in claude.ai's stylesheet under:
- `[data-theme=claude][data-mode=light]` — light theme values
- `[data-theme=claude][data-mode=dark]` — dark theme values

Token families: `--bg-*`, `--text-*`, `--accent-*` (incl. `--accent-brand`, `--accent-pro-*`), `--border-*`, `--danger-*`, `--oncolor-*`, `--always-*` (e.g. `--always-white`, `--always-black`). Fonts: `--font-anthropic-sans`, `--font-anthropic-serif`, `--font-anthropic-mono`, and the Tailwind-style `--text-xs..--text-6xl` sizing scale.

**Color tokens are raw HSL triplets**, consumed as `hsl(var(--bg-100))` and `hsl(var(--x) / 0.5)` for alpha. Never use a token's raw value directly. Read live via `getComputedStyle(document.documentElement)` and re-read when the `data-mode` attribute changes so the extension follows theme switches automatically.

## A.10 — Full confirmed endpoint map

| Purpose | Method | Path (under `/api/organizations/{org}`) |
|---|---|---|
| Load tree | GET | `/chat_conversations/{conv}?tree=True&rendering_mode=messages&render_all_tools=true&consistency=strong` |
| Switch branch | PUT | `/chat_conversations/{conv}/current_leaf_message_uuid` |
| Send / edit / branch | POST | `/chat_conversations/{conv}/completion` |
| Retry (assistant branch) | POST | `/chat_conversations/{conv}/retry_completion` |
| Upload file | POST | `/conversations/{conv}/wiggle/upload-file` |
| (auto) set title | POST | `/chat_conversations/{conv}/title` — ignore |

Authentication is via same-origin cookies attached automatically to in-page fetches; the extension never reads, stores, or transmits session tokens.
