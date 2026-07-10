/**
 * popup/popup.ts — settings popup: one global on/off switch per feature,
 * persisted in chrome.storage.local. The content script picks changes up live
 * via chrome.storage.onChanged (no reload needed).
 *
 * Failure behavior: storage errors leave the defaults in place; the checkbox
 * state always reflects what was actually persisted.
 */
import { getSettings, setSettings, type Settings } from "../shared/storage";

async function init(): Promise<void> {
  const settings = await getSettings();
  const boxes = document.querySelectorAll<HTMLInputElement>("input[data-key]");
  for (const box of boxes) {
    const key = box.dataset["key"] as keyof Settings;
    box.checked = settings[key];
    box.addEventListener("change", () => {
      void (async () => {
        const current = await getSettings();
        current[key] = box.checked;
        await setSettings(current);
        box.checked = (await getSettings())[key];
      })();
    });
  }
}

void init();
