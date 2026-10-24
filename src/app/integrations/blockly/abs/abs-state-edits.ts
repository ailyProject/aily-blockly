import { AbsAbiBlock, AbsSyntaxNode, AbsSyncError } from './abs-state';
import { AbsFieldDefinition, readAbsFieldToken, resolveAbsFieldValue } from './abs-field-values';

// Match bundled Blockly CommentIcon.loadState/saveState. The edit must already
// describe the persisted state so complete readback can remain strict.
const COMMENT_DEFAULTS = { pinned: false, width: 160, height: 80 };

/** Explicit state edits never accept identity, type, protection or disabled attributes. */
export function applyAbsStateEdits(block: AbsAbiBlock, node: AbsSyntaxNode,
  definition: (shadow: AbsAbiBlock, field: string) => AbsFieldDefinition | undefined): void {
  if (Object.hasOwn(node, 'comment')) {
    if (block['editable'] === false) throw new AbsSyncError('ABS_STATE_EDIT_FORBIDDEN', 'Cannot edit a locked block comment.', node, [block.id]);
    const icons = { ...(block['icons'] as Record<string, any> ?? {}) };
    // Blockly omits an empty comment icon when serializing the workspace.
    if (node.comment === null || node.comment === '') { delete icons['comment']; delete block['comment']; }
    else { icons['comment'] = { ...COMMENT_DEFAULTS, ...icons['comment'], text: node.comment }; delete block['comment']; }
    if (Object.keys(icons).length) block['icons'] = icons; else delete block['icons'];
  }
  for (const [inputName, fields] of Object.entries(node.shadowFields ?? {})) {
    const input = Object.hasOwn(block.inputs ?? {}, inputName) ? block.inputs![inputName] : undefined;
    const shadow = input?.shadow;
    if (!input?.block || !shadow) throw new AbsSyncError('ABS_SHADOW_EDIT_INVALID', 'Only an existing dormant shadow can be edited.', node, [block.id]);
    if (block['editable'] === false || shadow['editable'] === false) throw new AbsSyncError('ABS_STATE_EDIT_FORBIDDEN', 'Cannot edit a locked shadow.', node, [shadow.id]);
    for (const [name, value] of Object.entries(fields)) {
      const contract = definition(shadow, name);
      if (!Object.hasOwn(shadow.fields ?? {}, name) || !contract || contract.symbol) {
        throw new AbsSyncError('ABS_SHADOW_EDIT_INVALID', 'Shadow edits require an existing ordinary field and a captured definition.', node, [shadow.id]);
      }
      const resolved = resolveAbsFieldValue(readAbsFieldToken(JSON.stringify(value)), contract);
      Object.defineProperty(shadow.fields!, name, { value: resolved, writable: true, enumerable: true, configurable: true });
    }
  }
}
