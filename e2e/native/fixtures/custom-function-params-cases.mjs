export function functionParamsCase(name) {
  const number = id => ({ id, type: 'math_number', fields: { NUM: 7 } })
  const text = id => ({ id, type: 'text', fields: { TEXT: 'probe' } })
  const signature = [{ name: 'amount', type: 'int' }]
  const definition = (id, functionName, parameters, body) => ({ id, type: 'custom_function_def',
    fields: { FUNC_NAME: functionName, RETURN_TYPE: 'String', ...Object.fromEntries(parameters.flatMap((p, n) =>
      [[`PARAM_NAME${n}`, p.name], [`PARAM_TYPE${n}`, p.type]])) },
    extraState: { paramCount: parameters.length, returnType: 'String', params: parameters,
      funcVarId: `function-${functionName}`, paramVarIds: parameters.map(p => `parameter-${p.name}`), nextParamVarSeq: 0 },
    inputs: { RETURN: { block: body } } })
  const caller = (parameters = signature) => ({ id: 'call-pad', type: 'custom_function_call_return_advance',
    fields: { FUNC_NAME: { id: 'function-pad' } }, extraState: { extraCount: parameters.length,
      funcVarId: 'function-pad', ...(parameters.length ? { params: parameters } : {}) },
    ...(parameters.length ? { inputs: { INPUT0: { block: number('argument') } } } : {}) })
  const nested = { id: 'join', type: 'text_join', extraState: { itemCount: 2 },
    inputs: { ADD0: { block: caller() }, ADD1: { block: text('suffix') } } }
  const pad = definition('definition-pad', 'pad', signature, text('pad-result'))
  let outer = definition('definition-format', 'format', [], nested)
  let roots
  if (name === 'zero-parameter-control') roots = [definition('definition-pad', 'pad', [], text('pad-result')), caller([])]
  else if (name === 'parameter-definition-first') roots = [pad, caller()]
  else if (name === 'nested-forward-call') roots = [outer, pad]
  else if (name === 'nested-definition-first') roots = [pad, outer]
  else if (['nested-parameterized-outer', 'nested-shared-parameter', 'nested-many-definitions'].includes(name)) {
    const shared = name === 'nested-shared-parameter'
    outer = definition('definition-format', 'format', [{ name: shared ? 'amount' : 'index', type: 'int' }], nested)
    roots = [outer, pad]
    if (name === 'nested-many-definitions') roots.unshift(...Array.from({ length: 12 }, (_, n) =>
      definition(`definition-extra-${n}`, `extra${n}`, [{ name: 'index', type: 'int' }], text(`extra-result-${n}`))))
  }
  else throw Error('Unknown case: ' + name)
  roots.forEach((block, n) => { block.x = 30; block.y = 40 + 180 * n })
  const variables = [], models = new Set()
  for (const root of roots) if (root.type === 'custom_function_def') {
    if (!models.has(root.extraState.funcVarId)) {
      models.add(root.extraState.funcVarId); variables.push({ id: root.extraState.funcVarId, name: root.fields.FUNC_NAME, type: 'FUNC' })
    }
    for (const param of root.extraState.params) if (!models.has(`parameter-${param.name}`)) {
      models.add(`parameter-${param.name}`); variables.push({ id: `parameter-${param.name}`, name: param.name })
    }
  }
  const fields = {}
  const pending = [...roots]
  while (pending.length) {
    const block = pending.pop(); fields[block.id] = {}
    for (const [key, value] of Object.entries(block.fields ?? {})) fields[block.id][key] =
      key === 'FUNC_NAME' && block.type !== 'custom_function_def' ? { type: 'field_variable' }
        : key === 'NUM' ? { type: 'field_number' } : key === 'RETURN_TYPE' || key.startsWith('PARAM_TYPE')
          ? { type: 'field_dropdown', options: [['String', 'String'], ['int', 'int']] } : { type: 'field_input' }
    for (const input of Object.values(block.inputs ?? {})) if (input.block) pending.push(input.block)
  }
  return { blocks: [], verify: { state: { blocks: { blocks: roots }, variables }, contracts: { fields } } }
}
