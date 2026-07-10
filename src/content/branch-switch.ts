/**
 * content/branch-switch.ts — the branch-navigation adapter.
 *
 * Reconnaissance confirmed the native mechanism: PUT
 * …/current_leaf_message_uuid with the target leaf (one request jumps to ANY
 * sibling, 1 → 3 included), after which the app refetches the tree. The
 * recon notes explicitly rule out simulating arrow clicks, so this adapter
 * does the PUT and then — because the SPA offers no external hook to make its
 * own React state re-render from a fetch it did not initiate — reloads the
 * page, which renders the switched branch from the (now updated) server
 * state.
 *
 * DOCUMENTED DEVIATION: the build prompt hoped for a soft in-app re-render;
 * none exists that doesn't fake user input. The reload is the honest,
 * reliable version, and it is isolated here so a better mechanism can replace
 * it without touching feature code.
 *
 * Failure behavior: if the PUT fails or times out, nothing is reloaded and a
 * one-time toast reports that branch switching is unavailable.
 */
import type { ConversationTree } from "../shared/tree";
import { toastOnce } from "./toast";
import { waitForBusEvent, type Ctx } from "./ctx";

export interface BranchSwitchAdapter {
  /** Switch the conversation to the branch containing `siblingUuid`. */
  switchToBranch(tree: ConversationTree, siblingUuid: string): Promise<void>;
}

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
