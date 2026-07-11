/**
 * shared/selectors.ts — THE selector registry. Every DOM selector used
 * anywhere in the extension lives here, with a description of what it targets.
 * No selectors may be written inline in any other module.
 *
 * All entries prefer stable hooks: data-testid attributes, ARIA labels, and
 * structural landmarks. Hashed/minified class names are forbidden.
 *
 * Failure behavior: `validateSelectors()` runs at feature init and logs which
 * selectors currently match nothing; features consult it and disable
 * themselves (with a one-time toast) when a selector they depend on is gone.
 */

export interface SelectorEntry {
  /** CSS selector string. */
  selector: string;
  /** What this targets in claude.ai's DOM. */
  description: string;
  /**
   * Whether a zero-match result is expected on some pages (e.g. the selection
   * tooltip only exists while text is selected). Optional selectors are
   * reported but never counted as failures.
   */
  optional: boolean;
}

export const SELECTORS = {
  userMessage: {
    selector: '[data-testid="user-message"]',
    description: "A rendered user (human) message body in the chat.",
    optional: false,
  },
  chatInput: {
    selector: '[data-testid="chat-input"]',
    description: "The main composer (contenteditable) at the bottom of the chat.",
    optional: false,
  },
  actionBarEdit: {
    selector: '[data-testid="action-bar-edit"]',
    description: "Native 'edit' control in a user message's hover toolbar.",
    optional: true, // only present while a message row is hovered
  },
  actionBarRetry: {
    selector: '[data-testid="action-bar-retry"]',
    description: "Native 'retry' control in an assistant message's hover toolbar.",
    optional: true,
  },
  actionBarCopy: {
    selector: '[data-testid="action-bar-copy"]',
    description: "Native 'copy' control in a message's hover toolbar; used to classify assistant rows.",
    optional: true,
  },
  fileUpload: {
    selector: '[data-testid="file-upload"]',
    description: "The composer's file upload input; watched to capture draft attachments.",
    optional: true,
  },
  branchPrev: {
    selector: 'button[aria-label="Previous version"]',
    description: "Native branch pagination: previous sibling arrow next to the N / M counter.",
    optional: true, // only on branched messages
  },
  branchNext: {
    selector: 'button[aria-label="Next version"]',
    description: "Native branch pagination: next sibling arrow next to the N / M counter.",
    optional: true,
  },
  selectionTooltip: {
    selector: 'div[data-selection-tooltip="true"]',
    description:
      "Native text-selection popover (fixed, transform-centered). The note button is placed adjacent to, never overlapping, this.",
    optional: true, // only while a selection is active
  },
  alertBandWrapper: {
    selector: 'div[data-alert-band-wrapper="true"]',
    description:
      "The site's notice band directly above the composer (usage limits etc.). Extension bars (draft restore, branching header) are appended here so they sit exactly where native notices do.",
    optional: true, // present with the composer; fixed-position fallback exists
  },
  // NOTE: a `main` landmark entry used to live here; claude.ai stopped
  // rendering one (field-observed) and nothing consumed it, so it was removed
  // rather than producing a permanent false "hooks not found" warning.
} as const satisfies Record<string, SelectorEntry>;

export type SelectorName = keyof typeof SELECTORS;

export function sel(name: SelectorName): string {
  return SELECTORS[name].selector;
}

export function q<E extends Element = Element>(name: SelectorName, root: ParentNode = document): E | null {
  return root.querySelector<E>(SELECTORS[name].selector);
}

export function qa<E extends Element = Element>(name: SelectorName, root: ParentNode = document): E[] {
  return [...root.querySelectorAll<E>(SELECTORS[name].selector)];
}

export interface SelectorReport {
  /** Required selectors that matched nothing — a claude.ai update likely broke them. */
  failed: SelectorName[];
  /** Optional selectors that matched nothing right now (informational). */
  absent: SelectorName[];
}

export function validateSelectors(root: ParentNode = document): SelectorReport {
  const failed: SelectorName[] = [];
  const absent: SelectorName[] = [];
  for (const name of Object.keys(SELECTORS) as SelectorName[]) {
    const entry = SELECTORS[name];
    if (!root.querySelector(entry.selector)) {
      (entry.optional ? absent : failed).push(name);
    }
  }
  if (failed.length) {
    console.warn(
      "[prompt-tree] selector validation failures (claude.ai may have updated):",
      failed.map((n) => `${n} = ${SELECTORS[n].selector}`)
    );
  }
  return { failed, absent };
}
