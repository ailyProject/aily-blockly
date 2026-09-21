import { assertAbsProcedureModelIntents } from './abs-procedure-model-intents';
import { customFunctionSyntax } from './abs-custom-function-syntax';

describe('explicit model ownership boundary', () => {
  const describe = (type: string) => type === 'function_definition'
    ? { protocol: { kind: 'definition' as const }, base: { argumentOrder: [
      { name: 'FUNC_NAME', kind: 'field' as const }, { name: 'RETURN_TYPE', kind: 'field' as const },
    ] } } : undefined;
  const definition = (type: string) => type === 'function_definition' ? { nameField: 'FUNC_NAME', modelType: 'FUNC' }
    : type === 'procedure_definition' ? {} : undefined;
  const run = (body: string, requested: { name: string; type?: string }[]) => {
    const source = '# ABS Schema: 2\n' + body;
    assertAbsProcedureModelIntents(source, requested, customFunctionSyntax(source, { blocks: { blocks: [] } }, describe), definition);
  };

  it('preserves positional and explicit signatures for attested function/parameter creation', () => {
    for (const source of ['function_definition("work", int, int, "amount")',
      'function_definition(FUNC_NAME="work", RETURN_TYPE=int) @extra:{"params":[{"name":"amount","type":"int"}]}']) {
      expect(() => run(source, [{ name: 'work', type: 'FUNC' }, { name: 'amount' }])).not.toThrow();
    }
    expect(() => run('procedure_definition("work") @extra:{"params":[{"name":"amount"}]}', [{ name: 'amount' }])).not.toThrow();
  });
  it('rejects consumers, unknown blocks, disabled definitions and guessed typed objects', () => {
    for (const source of ['object_read($amount)', 'object_begin("amount")',
      'unknown_definition() @extra:{"params":[{"name":"amount"}]}',
      'procedure_call() @extra:{"params":[{"name":"amount"}]}',
      'procedure_definition("work") @disabled @extra:{"params":[{"name":"amount"}]}',
      'root() @disabled\n    procedure_definition("work") @extra:{"params":[{"name":"amount"}]}']) {
      expect(() => run(source, [{ name: 'amount' }])).toThrowError(/Direct model allocation/);
    }
    expect(() => run('function_definition("work", void, int, "amount")', [{ name: 'amount', type: 'Device' }])).toThrowError(/Direct model allocation/);
  });
});
