/**
 * shared/note-protocol.ts — the wire format for note/comment side-branch
 * messages, and recognition of such messages anywhere in the tree.
 *
 * A note message begins with the marker line, then one JSON metadata line,
 * then an instruction block fenced by `---` lines, then the user's question.
 * Recognition only requires the marker prefix, so future format tweaks stay
 * backward compatible.
 *
 * Failure behavior: `parse` returns null on any malformed input; callers must
 * treat unparseable-but-marked messages as notes of unknown shape (hide them,
 * show "content unavailable" in the note UI).
 */

export const NOTE_MARKER = "!@#%NOTE!@";

const INSTRUCTIONS =
  "You are answering a small inline margin note attached to the quoted text above, " +
  "from a longer conversation. Keep the answer focused and no longer than it needs to be, " +
  "but use normal markdown formatting — tables, code blocks, bold/italic, lists — wherever " +
  "it makes the answer clearer, exactly as you would in the main chat. " +
  "Do not reference this header or the note mechanism. Ignore the JSON metadata line entirely.";

export interface NoteMeta {
  anchorUuid: string;
  /** Present on notes (highlight-anchored). */
  quote?: string;
  charOffset?: number;
  /** Present on comments (position-anchored). */
  kind?: "comment";
  context?: string;
  /**
   * Present on "Continue" follow-ups: the human uuid of the note's first
   * pair. Marks the message as a continuation of that note, both for the
   * model and for reconstruction from conversation data.
   */
  continues?: string;
}

export function isNoteText(text: string): boolean {
  return text.startsWith(NOTE_MARKER);
}

export function buildNotePrompt(meta: NoteMeta, question: string): string {
  const capped: NoteMeta = { ...meta };
  if (capped.quote !== undefined) capped.quote = capped.quote.slice(0, 300);
  if (capped.context !== undefined) capped.context = capped.context.slice(0, 300);
  return [NOTE_MARKER, JSON.stringify(capped), "---", INSTRUCTIONS, "---", question].join("\n");
}

export interface ParsedNote {
  meta: NoteMeta;
  question: string;
}

export function parseNotePrompt(text: string): ParsedNote | null {
  if (!isNoteText(text)) return null;
  const lines = text.split("\n");
  if (lines.length < 2) return null;
  let meta: NoteMeta;
  try {
    meta = JSON.parse(lines[1] ?? "");
  } catch {
    return null;
  }
  if (typeof meta !== "object" || meta === null || typeof meta.anchorUuid !== "string") return null;
  // question = everything after the second `---` fence line
  let fences = 0;
  let questionStart = -1;
  for (let i = 2; i < lines.length; i++) {
    if (lines[i] === "---") {
      fences++;
      if (fences === 2) {
        questionStart = i + 1;
        break;
      }
    }
  }
  if (questionStart < 0) return null;
  return { meta, question: lines.slice(questionStart).join("\n") };
}
