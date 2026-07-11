/**
 * shared/storage.ts — persistence for the content script and popup.
 *
 *  - chrome.storage.local: settings, panel state, note/comment anchor records
 *    (keyed by conversation uuid), and draft records.
 *  - IndexedDB (page-origin database named "prompt-tree-drafts"): draft
 *    attachment Blobs, which are too large/binary for chrome.storage. The DB
 *    name is pt-prefixed so it is clearly ours inside the claude.ai origin.
 *
 * Failure behavior: every accessor resolves to a safe default on error and
 * logs once; storage loss degrades features (no drafts/notes restored) but
 * never throws into feature code.
 */

export interface NoteRecord {
  noteId: string;
  kind: "note" | "comment";
  conversationUuid: string;
  anchorMessageUuid: string;
  /** Root (human) message uuid of the note's side branch in Claude's tree. */
  noteBranchRootUuid: string;
  /* --- note (highlight) anchoring --- */
  quote?: string;
  prefix?: string;
  suffix?: string;
  charOffset?: number;
  /* --- comment (position) anchoring --- */
  anchorText?: string;
  offsetRatio?: number;
  /** Soft-deleted: hidden from the gutter but restorable from the panel. */
  deleted?: boolean;
  createdAt: number;
}

export type DraftMode = "normal" | "branch" | "note" | "comment";

export interface DraftRecord {
  conversationUuid: string;
  text: string;
  mode: DraftMode;
  /** branch mode: the ghosted (branched-from) message and its parent. */
  branchTargetUuid?: string;
  branchParentUuid?: string;
  /** note/comment mode: the full anchor object. */
  anchor?: Partial<NoteRecord> & { anchorMessageUuid: string };
  /** true when attachments exceeded the cap and were not saved. */
  attachmentsSkipped?: boolean;
  /** true when attachment blobs were saved to IndexedDB. */
  hasAttachments?: boolean;
  savedAt: number;
}

export interface Settings {
  branchCompose: boolean;
  treePanel: boolean;
  notes: boolean;
  comments: boolean;
  draftAutosave: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  branchCompose: true,
  treePanel: true,
  notes: true,
  comments: true,
  draftAutosave: true,
};

const KEY_SETTINGS = "pt.settings";
const KEY_PANEL_COLLAPSED = "pt.panel.collapsed";
const keyNotes = (conv: string) => `pt.notes.${conv}`;
const keyDraft = (conv: string) => `pt.draft.${conv}`;

async function get<T>(key: string, fallback: T): Promise<T> {
  try {
    const result = await chrome.storage.local.get(key);
    return (result[key] as T) ?? fallback;
  } catch (err) {
    console.warn("[prompt-tree] storage.get failed", key, err);
    return fallback;
  }
}

async function set(key: string, value: unknown): Promise<void> {
  try {
    await chrome.storage.local.set({ [key]: value });
  } catch (err) {
    console.warn("[prompt-tree] storage.set failed", key, err);
  }
}

async function remove(key: string): Promise<void> {
  try {
    await chrome.storage.local.remove(key);
  } catch (err) {
    console.warn("[prompt-tree] storage.remove failed", key, err);
  }
}

/* ------------------------------------------------------------- settings */

export async function getSettings(): Promise<Settings> {
  return { ...DEFAULT_SETTINGS, ...(await get<Partial<Settings>>(KEY_SETTINGS, {})) };
}

export async function setSettings(settings: Settings): Promise<void> {
  await set(KEY_SETTINGS, settings);
}

export function onSettingsChanged(fn: (settings: Settings) => void): void {
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes[KEY_SETTINGS]) return;
      fn({ ...DEFAULT_SETTINGS, ...(changes[KEY_SETTINGS].newValue as Partial<Settings>) });
    });
  } catch (err) {
    console.warn("[prompt-tree] settings listener failed", err);
  }
}

/* --------------------------------------------------------------- panel */

export async function getPanelCollapsed(): Promise<boolean> {
  return get(KEY_PANEL_COLLAPSED, false);
}

export async function setPanelCollapsed(collapsed: boolean): Promise<void> {
  await set(KEY_PANEL_COLLAPSED, collapsed);
}

/* --------------------------------------------------------------- notes */

export async function getNotes(conversationUuid: string): Promise<NoteRecord[]> {
  return get<NoteRecord[]>(keyNotes(conversationUuid), []);
}

export async function saveNote(record: NoteRecord): Promise<void> {
  const notes = await getNotes(record.conversationUuid);
  const idx = notes.findIndex((n) => n.noteId === record.noteId);
  if (idx >= 0) notes[idx] = record;
  else notes.push(record);
  await set(keyNotes(record.conversationUuid), notes);
}

export async function deleteNote(conversationUuid: string, noteId: string): Promise<void> {
  const notes = (await getNotes(conversationUuid)).filter((n) => n.noteId !== noteId);
  await set(keyNotes(conversationUuid), notes);
}

/* --------------------------------------------------------------- drafts */

export async function getDraft(conversationUuid: string): Promise<DraftRecord | null> {
  return get<DraftRecord | null>(keyDraft(conversationUuid), null);
}

export async function saveDraft(draft: DraftRecord): Promise<void> {
  await set(keyDraft(draft.conversationUuid), draft);
}

export async function clearDraft(conversationUuid: string): Promise<void> {
  await remove(keyDraft(conversationUuid));
  await clearDraftFiles(conversationUuid);
}

/* ----------------------------------------------- draft attachments (IDB) */

export interface DraftFile {
  name: string;
  type: string;
  blob: Blob;
}

const IDB_NAME = "prompt-tree-drafts";
const IDB_STORE = "draftFiles";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(IDB_STORE)) {
        req.result.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbOp<T>(
  mode: IDBTransactionMode,
  op: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, mode);
      const req = op(tx.objectStore(IDB_STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export async function saveDraftFiles(conversationUuid: string, files: DraftFile[]): Promise<boolean> {
  try {
    await idbOp("readwrite", (s) => s.put(files, conversationUuid));
    return true;
  } catch (err) {
    console.warn("[prompt-tree] draft file save failed", err);
    return false;
  }
}

export async function getDraftFiles(conversationUuid: string): Promise<DraftFile[]> {
  try {
    return ((await idbOp("readonly", (s) => s.get(conversationUuid))) as DraftFile[] | undefined) ?? [];
  } catch (err) {
    console.warn("[prompt-tree] draft file load failed", err);
    return [];
  }
}

export async function clearDraftFiles(conversationUuid: string): Promise<void> {
  try {
    await idbOp("readwrite", (s) => s.delete(conversationUuid));
  } catch {
    /* already logged in idbOp path; nothing else to do */
  }
}
