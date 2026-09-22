export interface SubappMoreMenuPosition {
  right: number;
  top: number;
}

interface TriggerRect {
  right: number;
  top: number;
  bottom: number;
}

const VIEWPORT_MARGIN = 8;
const MENU_GAP = 3;
const MAX_MENU_WIDTH = 220;
const MENU_HEIGHT = 2 * 28 + 10; // Two actions, vertical padding, and border.

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function resolveSubappMoreMenuPosition(
  triggerRect: TriggerRect | null,
  viewportWidth: number,
  viewportHeight: number
): SubappMoreMenuPosition {
  if (!triggerRect) return { right: VIEWPORT_MARGIN, top: VIEWPORT_MARGIN };

  // The menu's width depends on translated text. CSS right keeps its actual
  // right edge aligned with the button, with room for the widest allowed menu.
  const right = clamp(
    viewportWidth - triggerRect.right,
    VIEWPORT_MARGIN,
    Math.max(VIEWPORT_MARGIN, viewportWidth - MAX_MENU_WIDTH - VIEWPORT_MARGIN)
  );
  const below = triggerRect.bottom + MENU_GAP;
  const above = triggerRect.top - MENU_HEIGHT - MENU_GAP;
  const top = below + MENU_HEIGHT + VIEWPORT_MARGIN <= viewportHeight
    ? below
    : clamp(above, VIEWPORT_MARGIN, Math.max(VIEWPORT_MARGIN, viewportHeight - MENU_HEIGHT - VIEWPORT_MARGIN));

  return { right, top };
}
