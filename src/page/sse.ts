/**
 * page/sse.ts — parser for claude.ai's completion SSE streams.
 *
 * Confirmed format: `event:` / `data:` line pairs. Assistant text arrives as
 * `content_block_delta` events with `delta.type === "text_delta"`; thinking
 * deltas are ignored. `message_delta` carries `stop_reason`; `message_stop`
 * ends the turn.
 *
 * Failure behavior: unparseable data lines are skipped; a stream error
 * resolves with whatever text was accumulated and `stopReason: null` plus
 * `ok: false` so callers can report an honest partial result.
 */

export interface SseCallbacks {
  onTextDelta?: (text: string) => void;
}

export interface SseResult {
  text: string;
  stopReason: string | null;
  /** false when the stream errored/aborted before message_stop */
  ok: boolean;
}

export async function parseSseStream(
  body: ReadableStream<Uint8Array> | null,
  callbacks: SseCallbacks = {}
): Promise<SseResult> {
  if (!body) return { text: "", stopReason: null, ok: false };
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "";
  let text = "";
  let stopReason: string | null = null;
  let sawStop = false;

  const handleLine = (line: string): void => {
    if (line.startsWith("event:")) {
      eventName = line.slice(6).trim();
      return;
    }
    if (!line.startsWith("data:")) return;
    let data: unknown;
    try {
      data = JSON.parse(line.slice(5).trim());
    } catch {
      return;
    }
    const d = data as {
      type?: string;
      delta?: { type?: string; text?: string; stop_reason?: string };
    };
    const type = d.type ?? eventName;
    if (type === "content_block_delta" && d.delta?.type === "text_delta" && typeof d.delta.text === "string") {
      text += d.delta.text;
      callbacks.onTextDelta?.(d.delta.text);
    } else if (type === "message_delta" && typeof d.delta?.stop_reason === "string") {
      stopReason = d.delta.stop_reason;
    } else if (type === "message_stop") {
      sawStop = true;
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        handleLine(line);
      }
    }
    if (buffer) handleLine(buffer.replace(/\r$/, ""));
    return { text, stopReason, ok: sawStop || text.length > 0 };
  } catch (err) {
    console.warn("[prompt-tree] SSE stream error", err);
    return { text, stopReason, ok: false };
  }
}
