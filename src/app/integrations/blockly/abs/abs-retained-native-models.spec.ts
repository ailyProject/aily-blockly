import { readAbsSyntax } from './abs-syntax';
import { retainedAbsNativeModelCalls } from './abs-retained-native-models';

describe('committed native model producer retention', () => {
  const header = '# ABS Schema: 2\n';
  it('retains exact producer subtrees across an unrelated edit, but not an added identical producer', () => {
    const baseline = header + 'producer("old")\ntime_delay(1000)';
    const edit = header + 'producer("old")\ntime_delay(5000)';
    expect(retainedAbsNativeModelCalls(baseline, edit, readAbsSyntax(edit))).toEqual([header.length]);
    const duplicate = edit + '\nproducer("old")';
    expect(retainedAbsNativeModelCalls(baseline, duplicate, readAbsSyntax(duplicate))).toEqual([]);
  });
  it('does not retain a producer whose input subtree changed', () => {
    const baseline = header + 'producer()\n    child(1)';
    const edit = header + 'producer()\n    child(2)';
    expect(retainedAbsNativeModelCalls(baseline, edit, readAbsSyntax(edit))).toEqual([]);
  });
});
