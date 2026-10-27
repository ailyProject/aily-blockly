/** Blockly chooses a bubble location when an open comment has no requested
 * position. Only that native display default is optional: explicit positions,
 * partial positions, comment content and other icon metadata remain opaque. */
export function normalizeAbsCommentPlacement(attributes: Record<string, unknown>, original: Record<string, unknown>): void {
  const record = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
  const icons = attributes['icons'], expectedIcons = original['icons'];
  if (!record(icons) || !record(expectedIcons)) return;
  const comment = icons['comment'], expected = expectedIcons['comment'];
  if (!record(comment) || !record(expected) || expected['pinned'] !== true
    || Object.hasOwn(expected, 'x') || Object.hasOwn(expected, 'y')) return;
  if (typeof comment['x'] !== 'number' || !Number.isFinite(comment['x'])
    || typeof comment['y'] !== 'number' || !Number.isFinite(comment['y'])) return;
  const { x: _x, y: _y, ...state } = comment;
  attributes['icons'] = { ...icons, comment: state };
}
