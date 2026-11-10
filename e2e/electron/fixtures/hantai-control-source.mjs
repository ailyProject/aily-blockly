import assert from 'node:assert/strict'

export function hantaiColdFieldPlans(document) {
  const delays = []
  const visit = value => {
    if (!value || typeof value !== 'object') return
    if (value.type === 'time_delay') {
      const input = value.inputs?.DELAY_TIME, number = input?.block ?? input?.shadow
      if (number?.type === 'math_number') delays.push(number)
    }
    for (const child of Object.values(value)) if (Array.isArray(child)) child.forEach(visit); else visit(child)
  }
  visit(document)
  return Object.fromEntries([['A', 20], ['B', 120], ['C', 80]].map(([name, oldValue]) => {
    const nodes = delays.filter(block => block.fields?.NUM === oldValue)
    assert.equal(nodes.length, 1, 'Use one genuine original delay(' + oldValue + ') numeric block')
    return [name, { blockId: nodes[0].id, field: 'NUM', oldValue, value: oldValue + 1,
      oldText: 'time_delay(math_number(' + oldValue + '))', newText: 'time_delay(math_number(' + (oldValue + 1) + '))' }]
  }))
}

/** One original executable literal, with no changes to model identity or the
 * complete host-owned state suffix. This helper never reads/writes a project. */
export function hantaiControlSource(document, source, mode) {
  assert.ok(['original', 'minimal-field'].includes(mode))
  assert.equal(typeof source, 'string')
  assert.ok(source.includes('# @project-state:'), 'Use the complete original user ABS, never a readable preview')
  if (mode === 'original') return { source, expectedNative: structuredClone(document), edit: null }
  const targets = []
  const visit = value => {
    if (!value || typeof value !== 'object') return
    if (value.type === 'time_delay') {
      const input = value.inputs?.DELAY_TIME, number = input?.block ?? input?.shadow
      if (number?.type === 'math_number' && number.fields?.NUM === 20) targets.push(number)
    }
    for (const child of Object.values(value)) if (Array.isArray(child)) child.forEach(visit); else visit(child)
  }
  visit(document)
  assert.equal(targets.length, 1, 'The real HANTAI loop must contain exactly one delay(20) literal')
  const matches = [...source.matchAll(/^[ \t]*time_delay\(math_number\(20\)\)[ \t]*$/gm)]
  assert.equal(matches.length, 1, 'The original source must identify that one executable call uniquely')
  const start = matches[0].index + matches[0][0].indexOf('20'), end = start + 2
  const candidate = source.slice(0, start) + '21' + source.slice(end)
  const expectedNative = structuredClone(document)
  const update = value => {
    if (!value || typeof value !== 'object') return
    if (value.id === targets[0].id && value.type === 'math_number') value.fields.NUM = 21
    for (const child of Object.values(value)) if (Array.isArray(child)) child.forEach(update); else update(child)
  }
  update(expectedNative)
  return { source: candidate, expectedNative, edit: { blockId: targets[0].id, field: 'NUM',
    oldValue: 20, newValue: 21, start, end, originalLiteral: source.slice(start, end) } }
}
