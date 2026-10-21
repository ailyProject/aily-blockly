import { composeAbs } from './abs-compose';
import { precheckAbs, type AbsAuthoringContracts } from './abs-precheck';
import { compileAbsDeclarativeContract } from './abs-declarative-contracts';
import { parseAbsSyntax } from './abs-syntax';

const definitions = [
  { type: 'root', message0: '%1', args0: [{ type: 'input_statement', name: 'DO' }] },
  { type: 'branch', message0: '%1 %2 %3', args0: [{ type: 'input_value', name: 'IF0' }, { type: 'input_statement', name: 'DO0' }, { type: 'input_statement', name: 'ELSE' }], previousStatement: null, nextStatement: null },
  { type: 'num', message0: '%1', args0: [{ type: 'field_number', name: 'NUM', value: 0, min: 0, max: 10 }], output: 'Number' },
  { type: 'emit', message0: '%1 %2', args0: [{ type: 'field_dropdown', name: 'MODE', options: [['one', 'ONE'], ['two', 'TWO']] }, { type: 'input_value', name: 'VALUE' }], previousStatement: null, nextStatement: null },
  { type: 'text', message0: '%1', args0: [{ type: 'field_input', name: 'TEXT', text: '' }], output: 'String' },
  { type: 'get', message0: '%1', args0: [{ type: 'field_variable', name: 'VAR' }], output: null },
];
const shapes = new Map(definitions.map(definition => [definition.type, compileAbsDeclarativeContract(definition)!]));
const contracts: AbsAuthoringContracts = {
  blockContract: type => shapes.get(type), knownType: type => shapes.has(type) || type === 'dynamic',
  argumentOrder: type => shapes.get(type)?.argumentOrder,
};

describe('structured ABS generation and batch precheck', () => {
  it('round-trips nested branch ownership, empty sections, special text and references through the canonical parser', () => {
    const result = composeAbs({ blocks: [{ type: 'root', statements: { DO: [{ type: 'branch', values: { IF0: { type: 'num', fields: { NUM: 1 } } },
      statements: { DO0: [{ type: 'emit', fields: { MODE: 'ONE' }, values: { VALUE: { type: 'text', fields: { TEXT: 'quoted "\\\n@ELSE: $literal 中文' } } } }],
        ELSE: [{ type: 'emit', fields: { MODE: 'TWO' }, values: { VALUE: { type: 'get', fields: { VAR: { variable: '计数 器' } } } } }] } }] } }] }, contracts);
    expect(result.precheck.ok).toBeTrue();
    expect(result.precheck.nativeValidationRequired).toBeTrue();
    const [root] = parseAbsSyntax(result.abs, contracts);
    const branch = root.inputs['DO']!;
    expect(Object.keys(branch.inputs)).toEqual(['IF0', 'DO0', 'ELSE']);
    expect(branch.inputs['DO0']!.inputs['VALUE']!.fields['TEXT'].value).toBe('quoted "\\\n@ELSE: $literal 中文');
    expect(branch.inputs['ELSE']!.inputs['VALUE']!.fields['VAR'].reference).toBe('variable');
    expect(result.abs).not.toContain('compose-');
  });
  it('batches field, range and wrongly owned section errors with positions in one pass', () => {
    const report = precheckAbs('# ABS Schema: 2\nroot()\n    @ELSE:\n        emit(MODE="bad", VALUE=num(99))\n    @DO:\n        emit(MODE="wrong", VALUE=num(2))', contracts);
    expect(report.ok).toBeFalse();
    expect(report.diagnostics.length).toBe(4);
    expect(report.diagnostics.map(d => d.line)).toEqual([2, 4, 4, 6]);
    expect(report.diagnostics[0].message).toContain('parent owns');
  });
  it('does not reject dynamic shapes or claim static success authorizes a native commit', () => {
    const report = precheckAbs('# ABS Schema: 2\ndynamic("runtime-specific")', contracts);
    expect(report.ok).toBeTrue(); expect(report.deferredTypes).toEqual(['dynamic']); expect(report.nativeValidationRequired).toBeTrue();
    expect(precheckAbs('# ABS Schema: 2\nmissing()', contracts).ok).toBeFalse();
  });
  it('defers identity-bearing function adapters while checking their children and bounds locations', () => {
    const options = { ...contracts, deferType: (type: string) => type === 'procedure',
      blockContract: (type: string) => { if (type === 'procedure') throw new Error('identities not prepared'); return shapes.get(type); } };
    const report = precheckAbs('# ABS Schema: 2\nprocedure()\n    @STACK:\n        num(99)', options);
    expect(report.deferredTypes).toEqual(['procedure']);
    expect(report.diagnostics.length).toBe(1);
    expect(Object.keys(report.diagnostics[0].range!)).toEqual(['start', 'end']);
  });
  it('stops lexical recovery instead of guessing multiline literal boundaries', () => {
    const report = precheckAbs('# ABS Schema: 2\ntext("unterminated\nroot()\nnum(99)', contracts);
    expect(report.ok).toBeFalse(); expect(report.diagnostics.length).toBe(1);
  });
  it('bounds diagnostic output without hiding a failure', () => {
    const report = precheckAbs('# ABS Schema: 2\n' + 'num(99)\n'.repeat(100), contracts);
    expect(report.diagnostics.length).toBe(64); expect(report.truncated).toBeTrue(); expect(report.ok).toBeFalse();
  });
  it('rejects IDs, arbitrary structures, wrong slot kinds and references in literal fields', () => {
    for (const value of [
      { blocks: [{ type: 'num', id: 'persistent' }] },
      { blocks: [{ type: 'num', fields: { NUM: [1] } }] },
      { blocks: [{ type: 'root', values: { DO: { type: 'num' } } }] },
      { blocks: [{ type: 'text', fields: { TEXT: { variable: 'data' } } }] },
      { blocks: [{ type: 'root', statements: { next: [] } }] },
    ]) expect(() => composeAbs(value, contracts)).toThrowError();
  });
});
