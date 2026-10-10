import * as Blockly from 'blockly';

const standardFields = new Set<Function>([
  Blockly.FieldLabel, Blockly.FieldLabelSerializable, Blockly.FieldTextInput,
  Blockly.FieldNumber, Blockly.FieldDropdown, Blockly.FieldVariable,
]);

/** Prime the existing, synchronous Blockly width cache before renderers start
 * interleaving SVG writes with computed-style reads. Measure each real field's
 * font; never assume that themes, CSS overrides or different fields share it.
 * Custom renderers/field subclasses retain their own measurement path.
 * Call only inside startTextWidthCache/stopTextWidthCache.
 */
export function primeBlocklyTextWidths(workspace: Blockly.WorkspaceSvg): void {
  const fields: Array<{ field: Blockly.Field; text: SVGTextElement }> = [];
  for (const block of workspace.getAllBlocks(false)) {
    for (const input of block.inputList) for (const field of input.fieldRow) {
      if (!standardFields.has(field.constructor) || !field.isVisible()) continue;
      // These are the bundled v13 built-ins, not arbitrary library internals.
      const text = (field as any).textElement_ as SVGTextElement | null;
      if (!text) continue;
      if (field instanceof Blockly.FieldDropdown) {
        // Image/HTML options use a different layout path.
        if (typeof (field as any).selectedOption?.[0] !== 'string') continue;
        // This is the class renderSelectedText adds before measuring. Apply all
        // class writes before the read pass, so overridden fonts are respected.
        text.classList.add('blocklyDropdownText');
      }
      fields.push({ field, text });
    }
  }
  // Snapshot all font values before measuring. getComputedStyle returns a live
  // object, and the canvas helper's first call itself inserts a DOM element.
  const measurements = fields.map(({ field, text }) => {
    const style = getComputedStyle(text);
    const display = (field as any).getDisplayText_() as string;
    // Text dropdown arrows are part of the measured <text>; SVG arrows are not.
    const arrow = field instanceof Blockly.FieldDropdown ? (field as any).arrow?.textContent || '' : '';
    return {
      content: field.getSourceBlock()?.RTL ? arrow + display : display + arrow,
      className: text.getAttribute('class') || '',
      size: style.fontSize, weight: style.fontWeight, family: style.fontFamily,
    };
  });
  const probe = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  for (const measurement of measurements) {
    probe.textContent = measurement.content;
    probe.setAttribute('class', measurement.className);
    Blockly.utils.dom.getFastTextWidthWithSizeString(probe, measurement.size, measurement.weight, measurement.family);
  }
}
