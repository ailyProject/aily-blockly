import { resolveInitialProjectCategory } from './project-creation-category';

describe('resolveInitialProjectCategory', () => {
  it('forces Coder for the dedicated Aily Coder product', () => {
    expect(resolveInitialProjectCategory(true, 'blockly', 'blockly', 'blockly', true)).toBe('coder');
  });

  it('keeps the normal product fallback unchanged', () => {
    expect(resolveInitialProjectCategory(false, 'coder', 'coder')).toBe('blockly');
    expect(resolveInitialProjectCategory(true, undefined, 'coder')).toBe('coder');
  });
});
