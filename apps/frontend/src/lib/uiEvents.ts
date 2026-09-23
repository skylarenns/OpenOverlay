import type { PresetDeletedEvent } from "./api";

export const PRESET_DELETED_UI_EVENT = "openoverlay:preset-deleted";

export function dispatchPresetDeleted(payload: PresetDeletedEvent): void {
  window.dispatchEvent(new CustomEvent(PRESET_DELETED_UI_EVENT, { detail: payload }));
}
