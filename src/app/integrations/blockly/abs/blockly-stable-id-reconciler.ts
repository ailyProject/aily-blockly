/**
 * Copy prior Blockly ids into an ABS-derived config only where the connection
 * structure identifies the same block. ABS intentionally omits ids, but a
 * field-only Agent edit must not invalidate block breakpoints, selections or
 * source-map identities.
 *
 * Statement chains use positional matching only when their lengths and block
 * types are unchanged. When structure changes, only unique semantic/shape
 * matches retain ids, avoiding an old breakpoint being silently moved onto an
 * inserted look-alike block.
 */
export function inheritStableBlockIds(
  previousConfig: any,
  nextConfig: any,
): number {
  const previousChain = flattenConfigChain(previousConfig);
  const nextChain = flattenConfigChain(nextConfig);
  if (previousChain.length === 0 || nextChain.length === 0) return 0;

  const matches: Array<[any, any]> = [];
  if (
    previousChain.length === nextChain.length
    && previousChain.every((block, index) => block.type === nextChain[index]?.type)
  ) {
    previousChain.forEach((block, index) => {
      matches.push([block, nextChain[index]]);
    });
  } else {
    matchUniqueConfigNodes(
      previousChain,
      nextChain,
      blockNodeSemanticSignature,
      matches,
    );
    const matchedPrevious = new Set(matches.map(([previous]) => previous));
    const matchedNext = new Set(matches.map(([, next]) => next));
    matchUniqueConfigNodes(
      previousChain.filter(block => !matchedPrevious.has(block)),
      nextChain.filter(block => !matchedNext.has(block)),
      blockNodeShapeSignature,
      matches,
    );
  }

  let inherited = 0;
  for (const [previous, next] of matches) {
    if (
      typeof previous.id === 'string'
      && previous.id.length > 0
      && previous.type === next.type
    ) {
      next.id = previous.id;
      inherited++;
    }
    const previousInputs = asConfigRecord(previous.inputs);
    const nextInputs = asConfigRecord(next.inputs);
    for (const inputName of Object.keys(nextInputs)) {
      const previousChild = getConfigInputChild(previousInputs[inputName]);
      const nextChild = getConfigInputChild(nextInputs[inputName]);
      if (!previousChild || !nextChild) continue;
      inherited += inheritStableBlockIds(previousChild, nextChild);
    }
  }
  return inherited;
}

function flattenConfigChain(config: any): any[] {
  const blocks: any[] = [];
  const visited = new Set<any>();
  let current = config;
  while (
    current
    && typeof current === 'object'
    && typeof current.type === 'string'
    && !visited.has(current)
  ) {
    visited.add(current);
    blocks.push(current);
    current = current.next?.block;
  }
  return blocks;
}

function matchUniqueConfigNodes(
  previousBlocks: any[],
  nextBlocks: any[],
  signatureOf: (block: any) => string,
  matches: Array<[any, any]>,
): void {
  const previousBySignature = groupConfigNodes(previousBlocks, signatureOf);
  const nextBySignature = groupConfigNodes(nextBlocks, signatureOf);
  for (const [signature, previousMatches] of previousBySignature) {
    const nextMatches = nextBySignature.get(signature);
    if (previousMatches.length === 1 && nextMatches?.length === 1) {
      matches.push([previousMatches[0], nextMatches[0]]);
    }
  }
}

function groupConfigNodes(
  blocks: any[],
  signatureOf: (block: any) => string,
): Map<string, any[]> {
  const grouped = new Map<string, any[]>();
  for (const block of blocks) {
    const signature = signatureOf(block);
    grouped.set(signature, [...(grouped.get(signature) ?? []), block]);
  }
  return grouped;
}

function blockNodeSemanticSignature(block: any): string {
  return computeBlockSemanticSignature({
    ...block,
    id: undefined,
    next: undefined,
    position: undefined,
  });
}

function computeBlockSemanticSignature(block: any): string {
  if (!block) return '';
  const parts = [`T:${String(block.type ?? '')}`];
  const fields = Object.entries(asConfigRecord(block.fields))
    .filter(([name, value]) => (
      !/^(PLUS|MINUS)\d*$/iu.test(name)
      && value !== null
      && value !== undefined
      && value !== ''
    ))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}=${normalizeFieldValue(value)}`);
  if (fields.length > 0) parts.push(`F:{${fields.join(',')}}`);
  const extraState = asConfigRecord(block.extraState);
  if (Object.keys(extraState).length > 0) {
    parts.push(`E:${JSON.stringify(extraState)}`);
  }
  const inputs = Object.entries(asConfigRecord(block.inputs))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, input]) => {
      const child = getConfigInputChild(input);
      return child ? `${name}:[${computeBlockSemanticSignature(child)}]` : '';
    })
    .filter(Boolean);
  if (inputs.length > 0) parts.push(`I:{${inputs.join(',')}}`);
  return parts.join('|');
}

function normalizeFieldValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'object') return String(value);
  const record = asConfigRecord(value);
  if (typeof record['name'] === 'string') return `var:${record['name']}`;
  if (typeof record['id'] === 'string') return `id:${record['id']}`;
  return JSON.stringify(value);
}

function blockNodeShapeSignature(block: any): string {
  const fields = Object.keys(asConfigRecord(block?.fields)).sort().join(',');
  const inputs = Object.entries(asConfigRecord(block?.inputs))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, input]) => {
      const child = getConfigInputChild(input);
      return `${name}:${child?.type ?? ''}`;
    })
    .join(',');
  const extraState = Object.keys(asConfigRecord(block?.extraState)).sort().join(',');
  return `T:${String(block?.type ?? '')}|F:${fields}|I:${inputs}|E:${extraState}`;
}

function getConfigInputChild(input: unknown): any | null {
  const record = asConfigRecord(input);
  const child = record['block'] ?? record['shadow'];
  return child && typeof child === 'object' && typeof child.type === 'string'
    ? child
    : null;
}

function asConfigRecord(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
}
