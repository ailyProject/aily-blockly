import { canonicalJsonStringify as json } from '@domain/project/public-api';
import { AbsAbiBlock, AbsAbiWorkspace, AbsProjectionContracts, AbsSyncError, ABS_SCHEMA_HEADER,
  absFieldPath, absInputPath, getAbsFieldDefinition, isAbsBlockDisabled, ABS_PROJECTION_VERSION } from './abs-state';
import { AbsSymbols } from './abs-symbols';
import { absSyntaxOptions } from './abs-syntax-contracts';
import { absBranchInputs } from './abs-branch-presentation';

const identifier = (name: string) => /^[A-Za-z_]\w*$/.test(name) ? name : json(name);
const variable = (name: string) => '$' + (/^[\p{L}_][\p{L}\p{N}_]*$/u.test(name) ? name : json(name));

/** The sole canonical renderer; identity bookkeeping consumes its paths, not a second serializer. */
export function renderAbs(workspace: AbsAbiWorkspace, contracts: AbsProjectionContracts, symbols: AbsSymbols, projectionVersion = ABS_PROJECTION_VERSION) {
  // Only the immutable-baseline validator uses this historical formatting policy.
  // New exports always use current syntax; there is no caller-selectable write mode.
  const previousProjectionValidation = projectionVersion === 'abs-v2.preview.3';
  const syntax = previousProjectionValidation ? {} : absSyntaxOptions(workspace, contracts);
  const branches = (block: AbsAbiBlock) => projectionVersion === ABS_PROJECTION_VERSION
    ? absBranchInputs(block.type, syntax.argumentOrder?.(block.type, block.extraState, block.fields)) : undefined;
  const blockAtPath = new Map<string, AbsAbiBlock>();
  const symbolAtPath = new Map<string, { kind: 'variable' | 'procedure'; modelId: string }>();
  const renderedInputs = new Map<AbsAbiBlock, Set<string>>();
  const childAt = (block: AbsAbiBlock, name: string) => block.inputs?.[name]?.block ?? block.inputs?.[name]?.shadow;
  const canInline = (block: AbsAbiBlock): boolean => !block.next && Object.entries(block.inputs ?? {}).every(([name]) => {
    if (previousProjectionValidation) return false;
    const kind = syntax.argumentOrder?.(block.type, block.extraState, block.fields)?.find(arg => arg.kind !== 'field' && arg.name === name)?.kind;
    const child = childAt(block, name);
    return kind === 'valueInput' && (!child || canInline(child));
  });
  const inlineInput = (block: AbsAbiBlock, name: string) => {
    const kind = syntax.argumentOrder?.(block.type, block.extraState, block.fields)?.find(arg => arg.kind !== 'field' && arg.name === name)?.kind;
    const child = childAt(block, name);
    return kind !== 'statementInput' && !!child && canInline(child);
  };
  const field = (block: AbsAbiBlock, name: string, path: string): string => {
    const value = block.fields![name];
    const definition = getAbsFieldDefinition(contracts, block.id, name);
    if (definition?.symbol) {
      const projected = symbols.project(value, definition.symbol);
      symbolAtPath.set(absFieldPath(path, name), { kind: projected.kind, modelId: projected.modelId });
      return projected.kind === 'variable' && !previousProjectionValidation ? variable(projected.value) : json(projected.value);
    }
    if (!previousProjectionValidation && definition?.type === 'field_dropdown' && typeof value === 'string'
      && /^[A-Za-z_]\w*$/.test(value) && !['true', 'false', 'null'].includes(value)) return value;
    return json(value);
  };
  const call = (block: AbsAbiBlock, path: string): string => {
    blockAtPath.set(path, block);
    const inCall = new Set<string>();
    renderedInputs.set(block, inCall);
    const order = syntax.argumentOrder?.(block.type, block.extraState, block.fields)?.filter(arg => arg.kind !== 'statementInput');
    const branch = branches(block);
    const positional = !branch && order && order.every(arg => arg.kind === 'field'
      ? Object.hasOwn(block.fields ?? {}, arg.name) : !childAt(block, arg.name) || inlineInput(block, arg.name))
      && Object.keys(block.fields ?? {}).every(name => order.some(arg => arg.kind === 'field' && arg.name === name));
    const inputArgument = (name: string) => {
      inCall.add(name);
      return childAt(block, name) ? call(childAt(block, name)!, absInputPath(path, name)) : 'null';
    };
    const args = positional ? order!.map(arg => arg.kind === 'field' ? field(block, arg.name, path) : inputArgument(arg.name))
      : Object.keys(block.fields ?? {}).map(name => `${identifier(name)}=${field(block, name, path)}`);
    if (!positional) for (const name of Object.keys(block.inputs ?? {})) {
      if (!branch && inlineInput(block, name)) args.push(`${identifier(name)}=${inputArgument(name)}`);
    }
    return `${block.type}(${args.join(', ')})`
      + (Object.hasOwn(block, 'extraState') ? ` @extra:${json(block.extraState)}` : '')
      + (isAbsBlockDisabled(block) ? ' @disabled' : '');
  };
  const lines = [ABS_SCHEMA_HEADER, '# Project Data Schema: 1 (external-only)', ''];
  const render = (block: AbsAbiBlock, path: string, depth: number, chain = false) => {
    const indent = '    '.repeat(depth);
    lines.push(indent + call(block, path));
    const statements = syntax.argumentOrder?.(block.type, block.extraState, block.fields)?.filter(arg => arg.kind === 'statementInput');
    const branch = branches(block);
    const names = [...new Set([...(branch ?? []), ...Object.keys(block.inputs ?? {})])]
      .filter(name => Object.hasOwn(block.inputs ?? {}, name));
    for (const name of names) {
      const child = childAt(block, name);
      if (renderedInputs.get(block)?.has(name)) continue;
      if (name === 'next') throw new AbsSyncError('ABS_INPUT_UNSUPPORTED', 'The input name next conflicts with @next.');
      if (branch && child && inlineInput(block, name)) {
        lines.push(`${indent}    @${identifier(name)}: ${call(child, absInputPath(path, name))}`);
        continue;
      }
      const implicit = !branch && child && statements?.length === 1 && statements[0].name === name;
      if (!implicit) lines.push(`${indent}    @${identifier(name)}:`);
      if (child) render(child, absInputPath(path, name), depth + (implicit ? 1 : 2), statements?.some(arg => arg.name === name));
    }
    if (block.next?.block) {
      if (!chain) lines.push(`${indent}    @next:`);
      render(block.next.block, `${path}/next`, depth + (chain ? 0 : 2), chain);
    }
  };
  workspace.blocks.blocks.forEach((block, index) => render(block, `/blocks/${index}`, 0));
  return { abs: lines.join('\n'), blockAtPath, symbolAtPath };
}
