/**
 * content/branch-switch.ts — the branch-navigation adapter.
 *
 * PRIMARY (NativeArrowsAdapter, v0.2.0, user-directed): drive the app's own
 * `‹ Previous / Next version ›` buttons the required number of steps. Each
 * click makes claude.ai itself PUT the new leaf and refetch the tree — both
 * observed by the fetch patch — so the chat re-renders in place with NO page
 * reload, and the panel follows the model. Jumping 1 → 3 is two steps; the
 * loop re-locates the row and re-reads the model between steps (the app
 * re-renders after every click), with event-driven waits, never blind delays.
 *
 * Sibling positions are computed in NATIVE order — all children of the parent
 * by creation index, INCLUDING note side branches — because the native
 * `N / M` counter counts those too.
 *
 * FALLBACK (LeafPutAdapter): if arrows are missing (row unmounted, hooks
 * renamed) or a step times out, fall back to the confirmed API mechanism —
 * PUT …/current_leaf_message_uuid — followed by a page reload, since the SPA
 * offers no external hook to re-render its own state from a fetch it did not
 * initiate. If that fails too, a one-time toast reports it.
 *
 * Failure behavior: every step is guarded and bounded; a partial arrow walk
 * that stalls falls through to the PUT (which jumps directly to the final
 * target, so no intermediate state is left behind).
 */
import { ROOT_SENTINEL_UUID } from "../shared/messages";
import { sel } from "../shared/selectors";
import { waitUntil } from "../shared/util";
import type { ConversationTree, TreeNode } from "../shared/tree";
import { toastOnce } from "./toast";
import { waitForBusEvent, type Ctx } from "./ctx";

export interface BranchSwitchAdapter {
  /** Switch the conversation to the branch containing `siblingUuid`. */
  switchToBranch(tree: ConversationTree, siblingUuid: string): Promise<void>;
}

/**
 * Siblings of `uuid` in native display order: all children of the parent
 * (note branches included — the native counter counts them), creation order.
 */
function nativeSiblings(tree: ConversationTree, uuid: string): TreeNode[] {
  const node = tree.nodes.get(uuid);
  if (!node) return [];
  if (node.parentUuid === ROOT_SENTINEL_UUID) return tree.rootMessages();
  const parent = tree.nodes.get(node.parentUuid);
  if (!parent) return [node];
  return parent.children
    .map((u) => tree.nodes.get(u))
    .filter((n): n is TreeNode => !!n)
    .sort((a, b) => a.index - b.index);
}

export class NativeArrowsAdapter implements BranchSwitchAdapter {
  private fallback: LeafPutAdapter;

  constructor(private ctx: Ctx) {
    this.fallback = new LeafPutAdapter(ctx);
  }

  async switchToBranch(tree: ConversationTree, siblingUuid: string): Promise<void> {
    const target = tree.nodes.get(siblingUuid);
    if (!target) return;
    const conversationUuid = tree.conversationUuid;
    const parentUuid = target.parentUuid;

    const positionOf = (t: ConversationTree): { k: number; j: number; onPath: TreeNode } | null => {
      const onPath = t.activePath().find((n) => n.parentUuid === parentUuid);
      if (!onPath) return null;
      const siblings = nativeSiblings(t, siblingUuid).map((n) => n.uuid);
      const k = siblings.indexOf(onPath.uuid);
      const j = siblings.indexOf(siblingUuid);
      return k >= 0 && j >= 0 ? { k, j, onPath } : null;
    };

    let pos = positionOf(tree);
    if (!pos) {
      await this.fallback.switchToBranch(tree, siblingUuid);
      return;
    }
    if (pos.k === pos.j) return; // already on the target branch

    const maxSteps = nativeSiblings(tree, siblingUuid).length;
    for (let step = 0; step < maxSteps && pos && pos.k !== pos.j; step++) {
      const row = this.ctx.domMap.rowByUuid(pos.onPath.uuid);
      const arrow = row?.el.querySelector<HTMLButtonElement>(
        pos.j > pos.k ? sel("branchNext") : sel("branchPrev")
      );
      if (!arrow || arrow.disabled) {
        await this.fallback.switchToBranch(this.ctx.getTree(conversationUuid) ?? tree, siblingUuid);
        return;
      }
      arrow.click();

      // The click makes the app PUT the leaf and refetch the tree; both are
      // observed and land as a model update.
      const updated = await waitForBusEvent(
        this.ctx.bus,
        "tree-updated",
        (p) => p.conversationUuid === conversationUuid,
        6000
      );
      if (!updated) {
        await this.fallback.switchToBranch(this.ctx.getTree(conversationUuid) ?? tree, siblingUuid);
        return;
      }

      // Wait for the re-render to be mapped before the next step needs it.
      const fresh = this.ctx.getTree(conversationUuid);
      const next = fresh ? positionOf(fresh) : null;
      if (!next) {
        await this.fallback.switchToBranch(fresh ?? tree, siblingUuid);
        return;
      }
      await waitUntil(() => !!this.ctx.domMap.rowByUuid(next.onPath.uuid), 2000);
      pos = next;
    }

    if (pos && pos.k !== pos.j) {
      // Stepping stalled without an error; jump the rest via the API path.
      await this.fallback.switchToBranch(this.ctx.getTree(conversationUuid) ?? tree, siblingUuid);
    }
  }
}

/**
 * Last-resort adapter: the confirmed leaf PUT (jumps to any sibling in one
 * request) plus a reload to re-render, because the app's React state cannot
 * be updated from outside.
 */
export class LeafPutAdapter implements BranchSwitchAdapter {
  constructor(private ctx: Ctx) {}

  async switchToBranch(tree: ConversationTree, siblingUuid: string): Promise<void> {
    const conversationUuid = tree.conversationUuid;
    const leafUuid = tree.latestLeafUnder(siblingUuid);
    if (!leafUuid || leafUuid === tree.activeLeafUuid) return;

    // refetchTree: false — the reload below refetches everything anyway.
    this.ctx.sendToPage({ type: "switch-leaf", conversationUuid, leafUuid, refetchTree: false });

    const switched = await waitForBusEvent(
      this.ctx.bus,
      "leaf-switched",
      (p) => p.conversationUuid === conversationUuid && p.leafUuid === leafUuid,
      8000
    );
    if (switched) {
      location.reload();
    } else {
      toastOnce(
        "branch-switch-failed",
        "Prompt Tree: branch switch failed — claude.ai may have changed its API. Use the native ‹ › arrows."
      );
    }
  }
}
