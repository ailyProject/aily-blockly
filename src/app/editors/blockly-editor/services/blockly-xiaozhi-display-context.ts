const adapted = Symbol('xiaozhi-display-context');

/** Older Xiaozhi libraries store display metadata in realm globals while
 * generating setup blocks. Event functions may be emitted before setup, so
 * they otherwise see NONE on the first pass and the previous display later.
 * Prepare field metadata only; do not run any block generator twice. */
export function adaptXiaozhiDisplayContext(generator: any, realm: any): void {
  if (typeof generator?.forBlock?.['esp32ai_init_display'] !== 'function'
      || typeof generator?.forBlock?.['aivox_lcd_show_status'] !== 'function'
      || !Object.prototype.hasOwnProperty.call(realm, 'display_type')
      || !Object.prototype.hasOwnProperty.call(realm, 'display_mode')
      || typeof generator.init !== 'function' || generator.init[adapted]) return;
  const original = generator.init;
  const wrapped = function(this: unknown, workspace: any, ...args: unknown[]) {
    const result = original.call(this, workspace, ...args);
    realm.display_type = 'NONE';
    realm.display_mode = '';
    for (const block of workspace.getAllBlocks(true)) {
      if (!['esp32ai_init_display', 'aivox_display_mode'].includes(block.type)) continue;
      let enabled = true;
      for (let current = block; current; current = current.getSurroundParent()) {
        if (!current.isEnabled()) { enabled = false; break; }
      }
      if (!enabled) continue;
      if (block.type === 'esp32ai_init_display') realm.display_type = block.getFieldValue('DISPLAY_TYPE');
      else realm.display_mode = block.getFieldValue('display_mode');
    }
    return result;
  };
  Object.defineProperty(wrapped, adapted, { value: true });
  generator.init = wrapped;
}
