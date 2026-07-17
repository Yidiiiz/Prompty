/**
 * page/fetch-patch.ts — the core interception layer. Runs in the page's MAIN
 * world at document_start and monkey-patches window.fetch to observe:
 *
 *  - conversation tree loads (GET …/chat_conversations/{conv}?tree=True…)
 *  - outgoing completion sends (POST …/completion) — including the
 *    branch-compose parent_message_uuid rewrite
 *  - retry sends (POST …/retry_completion)
 *  - branch switches (PUT …/current_leaf_message_uuid)
 *  - streaming completion responses (teed via Response.clone)
 *
 * It also captures, per conversation, the last full send payload as a
 * template for extension-originated side-branch sends (notes/comments), the
 * organization uuid, and the model id.
 *
 * XMLHttpRequest is deliberately NOT patched: reconnaissance confirmed all
 * relevant claude.ai traffic uses fetch. If tree loads stop being observed,
 * the content script surfaces a "Prompt Tree unavailable" toast.
 *
 * Failure behavior: every interception step is wrapped so that on any error
 * the original request proceeds untouched — native claude.ai behavior is
 * never broken by this module.
 */
import { parseSseStream } from "./sse";
import { postToContent } from "./bridge";
import type { TurnMessageUuids } from "../shared/messages";

/** Bound before patching; all extension-originated requests use this. */
export const originalFetch: typeof fetch = window.fetch.bind(window);

const UUID = "[0-9a-fA-F-]{36}";
const RE_ORG = new RegExp(`/api/organizations/(${UUID})(?:/|$)`);
const RE_CONVERSATION = new RegExp(`/api/organizations/${UUID}/chat_conversations/(${UUID})$`);
const RE_COMPLETION = new RegExp(`/api/organizations/${UUID}/chat_conversations/(${UUID})/completion$`);
const RE_RETRY = new RegExp(`/api/organizations/${UUID}/chat_conversations/(${UUID})/retry_completion$`);
const RE_LEAF = new RegExp(
  `/api/organizations/${UUID}/chat_conversations/(${UUID})/current_leaf_message_uuid$`
);

/* ------------------------------------------------------- captured state */

let orgUuid: string | null = null;
/** conversation uuid -> parent uuid to inject into the next app send (branch-compose). */
const parentOverrides = new Map<string, string>();
/**
 * conversation uuid -> (visible uuid -> hidden tail uuid): hidden in-thread
 * note messages extend threads past what the app knows. Any app request that
 * references the visible message as a thread's end — a send's
 * parent_message_uuid or a leaf PUT's current_leaf_message_uuid — is
 * rewritten to the chain's real tail (the newest note reply).
 */
const threadTails = new Map<string, Map<string, string>>();
/** conversation uuid -> last full app send payload (template for side-branch sends). */
const sendTemplates = new Map<string, Record<string, unknown>>();
/** conversation uuid -> model id (from tree loads and sends). */
const models = new Map<string, string>();

export function getOrgUuid(): string | null {
  return orgUuid;
}

export function setParentOverride(conversationUuid: string, parentUuid: string | null): void {
  if (parentUuid === null) parentOverrides.delete(conversationUuid);
  else parentOverrides.set(conversationUuid, parentUuid);
}

export function setThreadTails(
  conversationUuid: string,
  tails: Array<{ from: string; to: string }>
): void {
  if (!tails.length) threadTails.delete(conversationUuid);
  else threadTails.set(conversationUuid, new Map(tails.map((t) => [t.from, t.to])));
}

export function getSendTemplate(conversationUuid: string): Record<string, unknown> | null {
  return sendTemplates.get(conversationUuid) ?? null;
}

export function getModel(conversationUuid: string): string | null {
  return models.get(conversationUuid) ?? null;
}

/** Called by api.ts when it fetches the tree itself, to keep state fresh. */
export function noteConversationJson(json: unknown): void {
  if (typeof json !== "object" || json === null) return;
  const conv = json as { uuid?: unknown; model?: unknown };
  if (typeof conv.uuid === "string" && typeof conv.model === "string") {
    models.set(conv.uuid, conv.model);
  }
}

/* ---------------------------------------------------------- body helpers */

interface RequestParts {
  url: URL;
  method: string;
}

function parseParts(input: RequestInfo | URL, init?: RequestInit): RequestParts | null {
  try {
    const urlStr =
      input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
    const url = new URL(urlStr, location.origin);
    if (url.origin !== location.origin) return null;
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    return { url, method };
  } catch {
    return null;
  }
}

/** Reads the JSON request body without disturbing the original request. */
async function readBodyText(input: RequestInfo | URL, init?: RequestInit): Promise<string | null> {
  if (typeof init?.body === "string") return init.body;
  if (input instanceof Request) {
    try {
      return await input.clone().text();
    } catch {
      return null;
    }
  }
  return null;
}

/** Re-issues the request, substituting a new body when `newBody` is set. */
function forward(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  newBody: string | null
): Promise<Response> {
  if (newBody === null) return originalFetch(input, init);
  if (typeof init?.body === "string") return originalFetch(input, { ...init, body: newBody });
  if (input instanceof Request) return originalFetch(new Request(input, { body: newBody }));
  return originalFetch(input, { ...(init ?? {}), body: newBody });
}

/* -------------------------------------------------------------- handlers */

function captureOrg(url: URL): void {
  const m = RE_ORG.exec(url.pathname);
  if (m?.[1]) orgUuid = m[1];
}

async function handleTreeLoad(
  input: RequestInfo | URL,
  init: RequestInit | undefined
): Promise<Response> {
  const res = await originalFetch(input, init);
  if (res.ok) {
    res
      .clone()
      .json()
      .then((json: unknown) => {
        noteConversationJson(json);
        postToContent({ type: "conversation-loaded", conversation: json });
      })
      .catch(() => {
        /* non-JSON body: not a tree response after all; ignore */
      });
  }
  return res;
}

async function handleCompletion(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  conversationUuid: string
): Promise<Response> {
  const bodyText = await readBodyText(input, init);
  let payload: Record<string, unknown> | null = null;
  if (bodyText) {
    try {
      payload = JSON.parse(bodyText) as Record<string, unknown>;
    } catch {
      payload = null;
    }
  }
  if (!payload) return originalFetch(input, init); // unreadable: observe nothing, break nothing

  // Branch-compose: rewrite parent_message_uuid on this app-originated send.
  let rewriteApplied = false;
  const override = parentOverrides.get(conversationUuid);
  if (override !== undefined) {
    payload["parent_message_uuid"] = override;
    parentOverrides.delete(conversationUuid);
    rewriteApplied = true;
  }
  // Thread-tail: the app doesn't know about hidden in-thread note messages;
  // a send parented to the last visible message continues under the notes
  // instead of branching around them. Branch-compose (above) takes priority
  // and this flag intentionally stays false — it drives branch-mode exit.
  let bodyChanged = rewriteApplied;
  if (!rewriteApplied) {
    const parent = payload["parent_message_uuid"];
    const to =
      typeof parent === "string" ? threadTails.get(conversationUuid)?.get(parent) : undefined;
    if (to) {
      payload["parent_message_uuid"] = to;
      bodyChanged = true;
    }
  }

  if (typeof payload["model"] === "string") models.set(conversationUuid, payload["model"]);
  sendTemplates.set(conversationUuid, payload);

  const turnUuids = (payload["turn_message_uuids"] ?? null) as TurnMessageUuids | null;
  postToContent({
    type: "send-observed",
    conversationUuid,
    parentMessageUuid:
      typeof payload["parent_message_uuid"] === "string" ? payload["parent_message_uuid"] : null,
    prompt: typeof payload["prompt"] === "string" ? payload["prompt"] : "",
    turnMessageUuids: turnUuids,
    rewriteApplied,
    isNewConversation: payload["create_conversation_params"] !== undefined,
  });

  const res = await forward(input, init, bodyChanged ? JSON.stringify(payload) : null);
  if (!res.ok) {
    postToContent({ type: "send-failed", conversationUuid, status: res.status });
    return res;
  }

  const assistantUuid = turnUuids?.assistant_message_uuid ?? null;
  parseSseStream(res.clone().body, {
    onTextDelta: (text) =>
      postToContent({ type: "stream-delta", conversationUuid, assistantUuid, text }),
  })
    .then((result) => {
      postToContent({
        type: "stream-done",
        conversationUuid,
        assistantUuid,
        text: result.text,
        stopReason: result.stopReason,
      });
    })
    .catch(() => {
      /* parseSseStream never rejects by contract; belt and suspenders */
    });
  return res;
}

async function handleRetry(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  conversationUuid: string
): Promise<Response> {
  const res = await originalFetch(input, init);
  if (!res.ok) return res;
  // Retry payloads carry no turn_message_uuids in captures; sync via a tree
  // refetch once the stream completes (see index.ts, which owns api access).
  parseSseStream(res.clone().body, {}).then(() => {
    retryCompletedListeners.forEach((fn) => fn(conversationUuid));
  });
  return res;
}

const retryCompletedListeners: Array<(conversationUuid: string) => void> = [];
export function onRetryCompleted(fn: (conversationUuid: string) => void): void {
  retryCompletedListeners.push(fn);
}

async function handleLeafPut(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  conversationUuid: string
): Promise<Response> {
  const bodyText = await readBodyText(input, init);
  let leafUuid: string | null = null;
  let newBody: string | null = null;
  if (bodyText) {
    try {
      const body = JSON.parse(bodyText) as Record<string, unknown>;
      const requested = body["current_leaf_message_uuid"];
      if (typeof requested === "string") {
        leafUuid = requested;
        // The app switches branches by PUTting the branch's last VISIBLE
        // message as the leaf — but a hidden note chain can extend past it,
        // and a leaf that still has children is rejected ("Current leaf
        // message has unexpected children"). Substitute the chain's tail.
        const to = threadTails.get(conversationUuid)?.get(requested);
        if (to) {
          body["current_leaf_message_uuid"] = to;
          leafUuid = to;
          newBody = JSON.stringify(body);
        }
      }
    } catch {
      /* unparseable body: pass through untouched */
    }
  }
  const res = await forward(input, init, newBody);
  if (res.ok && leafUuid) {
    postToContent({ type: "leaf-switched", conversationUuid, leafUuid });
  }
  return res;
}

/* ----------------------------------------------------------------- patch */

export function installFetchPatch(): void {
  const patched = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let parts: RequestParts | null = null;
    try {
      parts = parseParts(input, init);
    } catch {
      parts = null;
    }
    if (!parts) return originalFetch(input, init);
    try {
      captureOrg(parts.url);
      const path = parts.url.pathname;
      let m: RegExpExecArray | null;
      if (
        parts.method === "GET" &&
        (m = RE_CONVERSATION.exec(path)) &&
        /^true$/i.test(parts.url.searchParams.get("tree") ?? "")
      ) {
        return await handleTreeLoad(input, init);
      }
      if (parts.method === "POST" && (m = RE_COMPLETION.exec(path))) {
        return await handleCompletion(input, init, m[1]!);
      }
      if (parts.method === "POST" && (m = RE_RETRY.exec(path))) {
        return await handleRetry(input, init, m[1]!);
      }
      if (parts.method === "PUT" && (m = RE_LEAF.exec(path))) {
        return await handleLeafPut(input, init, m[1]!);
      }
    } catch (err) {
      console.warn("[prompt-tree] fetch interception error; passing through", err);
    }
    return originalFetch(input, init);
  };
  window.fetch = patched as typeof fetch;
}
