import { attachAbsDerivedPublication, describeAbsDerivedOutputs } from './abs-derived-outputs';

describe('ABS source and derived artifact outcome separation', () => {
  it('identifies preview publication without claiming root generated files were written', () => {
    const report = attachAbsDerivedPublication(describeAbsDerivedOutputs({ code: 'current preview' }), {
      changed: false, target: 'preview', previewPublished: true, diskPublished: false,
    });
    expect(report.output).toEqual({ published: true, target: 'preview', previewPublished: true, diskPublished: false });
    expect(report.warnings).toEqual([]);
  });
  it('does not certify output when generation was not requested', () => {
    expect(describeAbsDerivedOutputs()).toEqual({ output: undefined, warnings: [] });
  });
  it('reports successful prepared output without implying a compiler was run', () => {
    expect(describeAbsDerivedOutputs({ code: '' })).toEqual({ output: { published: true }, warnings: [] });
  });
  for (const prepared of [null, { code: null, error: '' }]) it('reports missing code even with an empty error message: ' + JSON.stringify(prepared), () => {
    const result = describeAbsDerivedOutputs(prepared);
    expect(result.output!.published).toBeFalse(); expect(result.output!.code).toBe('PROJECT_CODE_GENERATION_FAILED');
    expect(result.output!.error).toContain('did not produce code'); expect(result.warnings.length).toBe(1);
  });
  it('retains a caught generator error even when later publication returns normally', () => {
    const result = describeAbsDerivedOutputs({ code: null, error: 'missing generator for block_a' });
    expect(result.output).toEqual({ published: false, code: 'PROJECT_CODE_GENERATION_FAILED', error: 'missing generator for block_a' });
    expect(result.warnings.length).toBe(1);
  });
  it('preserves a publication diagnostic code independently of the source commit', () => {
    const error = Object.assign(new Error('build workspace belongs to another task'), { code: 'BUILD_WORKSPACE_RECOVERY_REQUIRED' });
    const result = describeAbsDerivedOutputs(undefined, { error });
    expect(result.output).toEqual({ published: false, code: error.code, error: error.message });
    expect(result.warnings.length).toBe(1);
  });
  it('recognizes native build contention even when the bridge only preserves its message', () => {
    const result = describeAbsDerivedOutputs({ code: 'saved code' }, { error: new Error('BUILD_WORKSPACE_BUSY: native owner') });
    expect(result.output).toEqual({ published: false, code: 'BUILD_WORKSPACE_BUSY', error: 'BUILD_WORKSPACE_BUSY: native owner' });
  });
  it('does not lose the generator error when a second artifact publication error occurs', () => {
    const result = describeAbsDerivedOutputs({ code: null, error: 'generator failure' }, { error: new Error('header write failure') });
    expect(result.output!.published).toBeFalse(); expect(result.output!.code).toBe('PROJECT_CODE_GENERATION_FAILED');
    expect(result.output!.error).toBe('generator failure\nheader write failure'); expect(result.warnings.length).toBe(2);
  });
  it('captures even a non-Error or undefined thrown publication failure', () => {
    for (const error of [undefined, null, 'disk full']) {
      const result = describeAbsDerivedOutputs(undefined, { error });
      expect(result.output).toEqual({ published: false, code: 'PROJECT_DERIVED_OUTPUT_PENDING', error: String(error) });
    }
  });
});
