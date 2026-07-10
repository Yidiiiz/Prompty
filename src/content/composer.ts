/**
 * content/composer.ts — helpers around claude.ai's main composer
 * (contenteditable, [data-testid="chat-input"]): read/write its text, locate
 * the dock element for banners/headers, and reattach files for draft restore.
 *
 * Text insertion uses execCommand('insertText') (still the only way to drive
 * a contenteditable through the editor's own beforeinput pipeline), with a
 * synthetic paste event as fallback. File reattachment synthesizes a
 * dragenter/dragover/drop sequence carrying a DataTransfer.
 *
 * Failure behavior: every function returns null/false rather than throwing;
 * callers surface honest notices ("attachments not restored") on failure.
 */
import { q } from "../shared/selectors";

export function getComposerEl(): HTMLElement | null {
  return q<HTMLElement>("chatInput");
}

export function getComposerText(): string {
  const el = getComposerEl();
  if (!el) return "";
  // innerText preserves visual line breaks; trailing newline is editor noise
  return el.innerText.replace(/\n$/, "");
}

/**
 * The element the composer visually lives in — banners insert before this.
 * Prefers the enclosing form; falls back one structural level up.
 */
export function getComposerDock(): HTMLElement | null {
  const el = getComposerEl();
  if (!el) return null;
  return el.closest("form") ?? el.parentElement;
}

/** Replaces the composer's content with `text`. Returns success. */
export function setComposerText(text: string): boolean {
  const el = getComposerEl();
  if (!el) return false;
  el.focus();
  try {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    selection?.removeAllRanges();
    selection?.addRange(range);
    // Deprecated but universally supported in Chrome and the only route that
    // triggers the editor's own input pipeline.
    if (document.execCommand("insertText", false, text)) {
      return getComposerText().length > 0 || text.length === 0;
    }
  } catch {
    /* fall through to paste */
  }
  try {
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    const pasted = !el.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })
    );
    return pasted;
  } catch {
    return false;
  }
}

/**
 * Attempts to reattach files by synthesizing a drop onto the composer.
 * Returns true if the app default-prevented the drop (i.e. handled it).
 */
export function attachFilesToComposer(files: File[]): boolean {
  const el = getComposerEl();
  if (!el || !files.length) return false;
  try {
    const dt = new DataTransfer();
    for (const file of files) dt.items.add(file);
    const opts = { dataTransfer: dt, bubbles: true, cancelable: true } as DragEventInit;
    el.dispatchEvent(new DragEvent("dragenter", opts));
    el.dispatchEvent(new DragEvent("dragover", opts));
    const drop = new DragEvent("drop", opts);
    el.dispatchEvent(drop);
    return drop.defaultPrevented;
  } catch (err) {
    console.warn("[prompt-tree] file reattach failed", err);
    return false;
  }
}
