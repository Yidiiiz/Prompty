/**
 * page/index.ts — entry point for the MAIN-world script (declared in the
 * manifest with `world: "MAIN"`, run_at document_start, so window.fetch is
 * patched before the app boots; no <script>-tag injection needed).
 *
 * Wires together: fetch patch, history patch, and the command listener for
 * content-script requests (parent overrides, side-branch sends, leaf
 * switches, tree refetches).
 *
 * Failure behavior: a top-level error disables the extension for the page
 * (logged); claude.ai itself is unaffected because patches install
 * defensively.
 */
import { installFetchPatch, setParentOverride, setThreadTails, onRetryCompleted } from "./fetch-patch";
import { installHistoryPatch } from "./history-patch";
import { fetchTree, switchLeaf, sendSideBranch } from "./api";
import { onContentMessage, postToContent } from "./bridge";

try {
  installFetchPatch();
  installHistoryPatch();

  // A retry creates an assistant sibling with uuids we never saw in the
  // request; resync the model from the server once its stream completes.
  onRetryCompleted((conversationUuid) => {
    void fetchTree(conversationUuid);
  });

  onContentMessage((msg) => {
    switch (msg.type) {
      case "set-parent-override":
        setParentOverride(msg.conversationUuid, msg.parentMessageUuid);
        break;
      case "set-thread-tails":
        setThreadTails(msg.conversationUuid, msg.tails);
        break;
      case "send-side-branch":
        void sendSideBranch(msg);
        break;
      case "switch-leaf":
        void switchLeaf(msg.conversationUuid, msg.leafUuid, msg.refetchTree);
        break;
      case "request-tree":
        void fetchTree(msg.conversationUuid);
        break;
    }
  });

  postToContent({ type: "page-ready" });
} catch (err) {
  console.error("[prompt-tree] page script failed to initialize", err);
}
