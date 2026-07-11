/**
 * shared/tree.ts — the ConversationTree model: the extension's single source
 * of truth for a conversation's structure, built exclusively from claude.ai's
 * own network traffic (never the DOM).
 *
 * Key facts encoded here (from reconnaissance):
 *  - The tree-load response has a FLAT `chat_messages` array covering ALL
 *    branches; structure comes from `parent_message_uuid` links.
 *  - Root messages parent to the sentinel uuid; we model a virtual root.
 *  - `index` is global creation order, NOT branch position — the active path
 *    is derived by walking parents up from `current_leaf_message_uuid`.
 *  - Message text lives in `content[].text` blocks (`type === "text"`); the
 *    top-level `text` field is empty.
 *  - Note/comment messages are recognized by the NOTE_MARKER prefix; a note
 *    is the marked human message plus its direct assistant reply only —
 *    the thread continues normally beneath it.
 *
 * Failure behavior: unparseable conversation JSON yields an empty tree and a
 * console warning; features render nothing rather than wrong data.
 */
import { ROOT_SENTINEL_UUID } from "./messages";
import { isNoteText } from "./note-protocol";

export interface TreeNode {
  uuid: string;
  parentUuid: string;
  sender: "human" | "assistant";
  text: string;
  /** Global creation order from the API; used only for sibling ordering/latest-leaf picks. */
  index: number;
  createdAt: string | null;
  children: string[];
  /** True if this node is inside a note/comment side branch. */
  isNote: boolean;
  /** True while the assistant reply is still streaming (locally-applied sends). */
  pending: boolean;
}

interface RawMessage {
  uuid?: unknown;
  parent_message_uuid?: unknown;
  sender?: unknown;
  index?: unknown;
  created_at?: unknown;
  text?: unknown;
  content?: unknown;
}

/** Concatenate the text blocks of a raw message's content array. */
export function extractText(raw: RawMessage): string {
  if (Array.isArray(raw.content)) {
    const parts: string[] = [];
    for (const block of raw.content) {
      if (block && typeof block === "object" && (block as { type?: unknown }).type === "text") {
        const t = (block as { text?: unknown }).text;
        if (typeof t === "string") parts.push(t);
      }
    }
    if (parts.length) return parts.join("\n");
  }
  return typeof raw.text === "string" ? raw.text : "";
}

export class ConversationTree {
  readonly conversationUuid: string;
  /** Model id from the conversation object (used for side-branch sends). */
  model: string | null = null;
  nodes = new Map<string, TreeNode>();
  activeLeafUuid: string | null = null;

  constructor(conversationUuid: string) {
    this.conversationUuid = conversationUuid;
  }

  static fromConversation(json: unknown): ConversationTree | null {
    if (typeof json !== "object" || json === null) return null;
    const conv = json as {
      uuid?: unknown;
      model?: unknown;
      current_leaf_message_uuid?: unknown;
      chat_messages?: unknown;
    };
    if (typeof conv.uuid !== "string" || !Array.isArray(conv.chat_messages)) {
      console.warn("[prompt-tree] unexpected conversation shape; ignoring");
      return null;
    }
    const tree = new ConversationTree(conv.uuid);
    tree.model = typeof conv.model === "string" ? conv.model : null;
    for (const raw of conv.chat_messages as RawMessage[]) {
      if (typeof raw?.uuid !== "string") continue;
      tree.nodes.set(raw.uuid, {
        uuid: raw.uuid,
        parentUuid:
          typeof raw.parent_message_uuid === "string" ? raw.parent_message_uuid : ROOT_SENTINEL_UUID,
        sender: raw.sender === "assistant" ? "assistant" : "human",
        text: extractText(raw),
        index: typeof raw.index === "number" ? raw.index : 0,
        createdAt: typeof raw.created_at === "string" ? raw.created_at : null,
        children: [],
        isNote: false,
        pending: false,
      });
    }
    tree.rebuildLinks();
    tree.activeLeafUuid =
      typeof conv.current_leaf_message_uuid === "string" ? conv.current_leaf_message_uuid : null;
    return tree;
  }

  /** Recompute children arrays and note flags from parent links. */
  rebuildLinks(): void {
    for (const node of this.nodes.values()) node.children = [];
    for (const node of this.nodes.values()) {
      const parent = this.nodes.get(node.parentUuid);
      if (parent) parent.children.push(node.uuid);
    }
    // stable child ordering by creation index
    for (const node of this.nodes.values()) {
      node.children.sort((a, b) => (this.nodes.get(a)?.index ?? 0) - (this.nodes.get(b)?.index ?? 0));
    }
    // A note is exactly one hidden PAIR on the thread: the marker-prefixed
    // human message and its direct assistant reply. Descendants beyond the
    // reply are normal messages (the conversation continues under a note),
    // so there is NO subtree propagation.
    for (const node of this.nodes.values()) {
      node.isNote = node.sender === "human" && isNoteText(node.text);
    }
    for (const node of this.nodes.values()) {
      if (node.sender === "assistant") {
        const parent = this.nodes.get(node.parentUuid);
        node.isNote = !!parent?.isNote;
      }
    }
  }

  /** Root-level messages (children of the virtual sentinel root). */
  rootMessages(): TreeNode[] {
    return [...this.nodes.values()]
      .filter((n) => n.parentUuid === ROOT_SENTINEL_UUID)
      .sort((a, b) => a.index - b.index);
  }

  /** Active root-to-leaf path derived by walking parents up from the leaf. */
  activePath(): TreeNode[] {
    const path: TreeNode[] = [];
    let uuid = this.activeLeafUuid;
    const seen = new Set<string>();
    while (uuid && uuid !== ROOT_SENTINEL_UUID && !seen.has(uuid)) {
      seen.add(uuid);
      const node = this.nodes.get(uuid);
      if (!node) break;
      path.push(node);
      uuid = node.parentUuid;
    }
    return path.reverse();
  }

  /** Active path with note side-branch messages filtered out (for UI). */
  visiblePath(): TreeNode[] {
    return this.activePath().filter((n) => !n.isNote);
  }

  /**
   * Siblings of a message (children of its parent, creation order), excluding
   * note branches. Returns [uuid] itself if it has no parent record.
   */
  siblingsOf(uuid: string): TreeNode[] {
    const node = this.nodes.get(uuid);
    if (!node) return [];
    const siblingUuids =
      node.parentUuid === ROOT_SENTINEL_UUID
        ? this.rootMessages().map((n) => n.uuid)
        : this.nodes.get(node.parentUuid)?.children ?? [uuid];
    return siblingUuids
      .map((u) => this.nodes.get(u))
      .filter((n): n is TreeNode => !!n && !n.isNote);
  }

  /**
   * Deepest descendant of `uuid` following the latest-created child at each
   * step, skipping note branches — the leaf to activate when jumping to a
   * sibling branch.
   */
  latestLeafUnder(uuid: string): string {
    let current = uuid;
    for (;;) {
      const node = this.nodes.get(current);
      if (!node) return current;
      const children = node.children
        .map((u) => this.nodes.get(u))
        .filter((n): n is TreeNode => !!n && !n.isNote);
      if (!children.length) return current;
      children.sort((a, b) => b.index - a.index);
      current = children[0]!.uuid;
    }
  }

  private nextIndex(): number {
    let max = -1;
    for (const n of this.nodes.values()) if (n.index > max) max = n.index;
    return max + 1;
  }

  /**
   * Apply an observed outgoing send locally (human + pending assistant nodes)
   * so the model stays fresh without refetching the tree.
   */
  applySend(args: {
    humanUuid: string;
    assistantUuid: string;
    parentUuid: string;
    prompt: string;
  }): void {
    const base = this.nextIndex();
    if (!this.nodes.has(args.humanUuid)) {
      this.nodes.set(args.humanUuid, {
        uuid: args.humanUuid,
        parentUuid: args.parentUuid,
        sender: "human",
        text: args.prompt,
        index: base,
        createdAt: new Date().toISOString(),
        children: [],
        isNote: false,
        pending: false,
      });
    }
    if (!this.nodes.has(args.assistantUuid)) {
      this.nodes.set(args.assistantUuid, {
        uuid: args.assistantUuid,
        parentUuid: args.humanUuid,
        sender: "assistant",
        text: "",
        index: base + 1,
        createdAt: new Date().toISOString(),
        children: [],
        isNote: false,
        pending: true,
      });
    }
    this.rebuildLinks();
    this.activeLeafUuid = args.assistantUuid;
  }

  /** Update streaming assistant text for a locally-applied send. */
  applyAssistantText(assistantUuid: string, text: string, done: boolean): void {
    const node = this.nodes.get(assistantUuid);
    if (!node) return;
    node.text = text;
    if (done) node.pending = false;
  }

  setLeaf(uuid: string): void {
    if (this.nodes.has(uuid)) this.activeLeafUuid = uuid;
  }
}
