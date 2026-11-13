import { renderAbs } from './abs-renderer';
import { authoringExtraState, precheckAbs, type AbsAuthoringContracts } from './abs-precheck';
import { AbsSyncError, type AbsAbiBlock, type AbsAbiWorkspace, type AbsProjectionContracts } from './abs-state';
import type { AbsFieldDefinition } from './abs-field-values';
import type { AbsBlockShapeContract } from './abs-declarative-contracts';

/** Authoring data only. No persisted identities, model creation or ABI writes. */
export interface AbsStructuredBlock {
  type: string;
  fields?: Record<string, string | number | boolean | null | { variable: string }>;
  values?: Record<string, AbsStructuredBlock | null>;
  statements?: Record<string, AbsStructuredBlock[]>;
  extraState?: unknown;
  disabled?: boolean;
}

interface AbsComposeIssue {
  path: string;
  message: string;
  blockType?: string;
  expected?: string;
  actual?: string;
  allowed?: (string | number | boolean)[];
  fallback?: 'text-abs';
}

export class AbsComposeFailure extends AbsSyncError {
  constructor(readonly composeDiagnostics: { issues: AbsComposeIssue[]; truncated: boolean }, code: string) {
    super(code, composeDiagnostics.issues[0].message);
  }
}

const MAX_ISSUES = 16;
const MAX_PATH_LENGTH = 2048;
const MAX_MESSAGE_LENGTH = 2304;
const INVALID_COMPOSE = 'ABS_COMPOSE_INVALID';
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const pointerKey = (key: string) => key.replace(/~/g, '~0').replace(/\//g, '~1');
const actualType = (value: unknown) => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
const scalar = (value: unknown) => value === null || typeof value === 'string' || typeof value === 'boolean'
  || typeof value === 'number' && Number.isFinite(value);
const reference = (value: unknown) => record(value) && Object.keys(value).length === 1 && Object.hasOwn(value, 'variable')
  && typeof value['variable'] === 'string' && value['variable'] ? value['variable'] : undefined;
const fieldAt = (shape: AbsBlockShapeContract | undefined, name: string) =>
  shape && Object.hasOwn(shape.fields, name) ? shape.fields[name] : undefined;
const inputAt = (shape: AbsBlockShapeContract | undefined, name: string) =>
  shape && Object.hasOwn(shape.inputs, name) ? shape.inputs[name] : undefined;
const fieldOptions = (definition: AbsFieldDefinition | undefined) => definition?.options?.map(option => option[1]);
const inputOptions = (shape: AbsBlockShapeContract | undefined, role: 'value' | 'statement') =>
  shape && Object.keys(shape.inputs).filter(name => shape.inputs[name] === role);

export function composeAbs(program: unknown, definitions: AbsAuthoringContracts) {
  const issues: AbsComposeIssue[] = [];
  let truncated = false, firstCode = INVALID_COMPOSE;
  const fail = (more = false): never => { throw new AbsComposeFailure({ issues, truncated: truncated || more }, firstCode); };
  const report = (path: string, message: string, { allowed, ...details }: Omit<AbsComposeIssue, 'path' | 'message'> = {}, code = INVALID_COMPOSE) => {
    if (issues.length >= MAX_ISSUES) fail(true);
    if (!issues.length) firstCode = code;
    if (path.length > MAX_PATH_LENGTH) {
      // Keep a resolvable pointer to the closest bounded ancestor.
      path = path.slice(0, path.lastIndexOf('/', MAX_PATH_LENGTH));
      message = 'A structured candidate error is inside an oversized JSON path.';
      truncated = true;
    } else if (message.length > MAX_MESSAGE_LENGTH) {
      message = message.slice(0, MAX_MESSAGE_LENGTH - 1) + '…';
      truncated = true;
    }
    const options = allowed?.slice(0, 16).filter(value => typeof value !== 'string' || value.length <= 256);
    if (allowed && options?.length !== allowed.length) truncated = true;
    issues.push({ path, message, ...details, ...(options?.length ? { allowed: options } : {}) });
  };
  if (!record(program) || Object.keys(program).some(key => key !== 'blocks') || !Array.isArray(program['blocks']) || !program['blocks'].length) {
    report('', 'Expected {blocks: [structured block, ...]}.', { expected: 'program' });
    return fail();
  }
  const contracts: AbsProjectionContracts = { fields: Object.create(null), syntax: Object.create(null) };
  let count = 0;
  const block = (value: unknown, depth: number, pointer: string): AbsAbiBlock | undefined => {
    if (++count > 10000 || depth > 96) {
      report(pointer, 'Structured candidate exceeds 10000 blocks or 96 nesting levels.');
      if (count > 10000) fail(true);
      return;
    }
    if (!record(value) || Object.keys(value).some(key => !['type', 'fields', 'values', 'statements', 'extraState', 'disabled'].includes(key))
      || typeof value['type'] !== 'string' || !/^[A-Za-z0-9_]+$/.test(value['type'])
      || value['disabled'] !== undefined && typeof value['disabled'] !== 'boolean') {
      report(pointer, `Invalid block at ${pointer}; IDs and raw ABS are not accepted.`, { expected: 'structured-block', actual: actualType(value) });
      return;
    }
    const node = value;
    const type = value['type'];
    const blockType = type.length <= 256 ? type : undefined;
    const bucket = (key: 'fields' | 'values' | 'statements') => {
      const data = node[key];
      if (record(data)) return data;
      if (data !== undefined) report(`${pointer}/${key}`, `${pointer}/${key} must be an object.`,
        { blockType, expected: 'object', actual: actualType(data) });
      return {};
    };
    const supplied = bucket('fields');
    const suppliedFields = Object.entries(supplied);
    const values = bucket('values'), statements = bucket('statements');
    const fields: Record<string, unknown> = Object.create(null);
    const references = new Set<string>();
    for (const [name, input] of suppliedFields) {
      const model = reference(input);
      if (model !== undefined) { fields[name] = model; references.add(name); }
      else if (scalar(input)) fields[name] = input;
    }
    const unsupportedFields = suppliedFields.some(([name]) => !Object.hasOwn(fields, name));
    const deferred = definitions.deferType?.(type);
    let shape: AbsBlockShapeContract | undefined, uncertainSlots = false, nativeOnly = false;
    if (!deferred) {
      try {
        const extra = authoringExtraState({ type, parameters: [],
          sections: [...Object.keys(values), ...Object.keys(statements)]
            .map(name => ({ name, children: [], start: 0, end: 0 })), disabled: false, start: 0, end: 0,
          ...(Object.hasOwn(node, 'extraState') ? { extraState: node['extraState'] } : {}) }, definitions);
        uncertainSlots = (unsupportedFields || references.size > 0) && !!definitions.fieldSelectors?.(type)?.some(name =>
          Object.hasOwn(supplied, name) && (!Object.hasOwn(fields, name) || references.has(name)));
        shape = uncertainSlots ? definitions.blockContract(type) : definitions.blockContract(type, extra, fields);
        nativeOnly = !shape && unsupportedFields && !!definitions.knownType?.(type) && !definitions.blockContract(type);
      } catch (error) {
        if (!(error instanceof AbsSyncError) || !['ABS_SYNTAX_INVALID', 'ABS_RUNTIME_SHAPE_UNSUPPORTED', 'ABS_FIELD_OPTION_INVALID'].includes(error.code)) throw error;
        uncertainSlots = true;
        const selectorError = error.code === 'ABS_FIELD_OPTION_INVALID';
        const path = selectorError ? `${pointer}/fields` : Object.hasOwn(node, 'extraState') ? `${pointer}/extraState` : pointer;
        report(path, selectorError ? 'Block shape requires a valid field selector value.' : error.message, { blockType }, error.code);
      }
    }
    const fieldContracts: Record<string, AbsFieldDefinition> = Object.create(null);
    for (const [name, input] of suppliedFields) {
      const path = `${pointer}/fields/${pointerKey(name)}`;
      const definition = fieldAt(shape, name);
      const slot = !definition && !uncertainSlots && inputAt(shape, name);
      const isReference = references.has(name);
      const isVariable = definition?.symbol?.kind === 'variable';
      if (slot) {
        report(path, `${path} is a ${slot} input.`, { blockType, expected: slot, actual: 'field', allowed: inputOptions(shape, slot) });
      } else if (!Object.hasOwn(fields, name)) {
        const actual = actualType(input);
        const serialized = (actual === 'object' || actual === 'array')
          && (definition?.valueType === 'json' || nativeOnly);
        const fallback = serialized ? ' Use the original serialized value unchanged as one JSON field argument in text ABS.' : '';
        report(path, `${path} must be a JSON scalar or {variable: "name"}.${fallback}`, {
          blockType, expected: definition?.type ?? 'scalar-or-variable-reference', actual, allowed: fieldOptions(definition),
          ...(serialized ? { fallback: 'text-abs' as const } : {}),
        });
      } else if (isReference && definition && !isVariable) {
        report(path, `${path} does not accept a variable reference.`,
          { blockType, expected: definition.type, actual: 'variable-reference', allowed: fieldOptions(definition) });
      } else if (isVariable && (typeof fields[name] !== 'string' || !fields[name])) {
        report(path, 'A model reference requires a nonempty name.',
          { blockType, expected: definition.type, actual: actualType(input) });
      }
      fieldContracts[name] = isReference || isVariable
        ? { type: 'field_variable', symbol: { kind: 'variable', storage: 'name' } }
        : definition ?? { type: 'field_input' };
    }
    const result: AbsAbiBlock = { type, id: `compose-${count}`, fields, inputs: Object.create(null),
      ...(Object.hasOwn(node, 'extraState') ? { extraState: node['extraState'] } : {}), ...(node['disabled'] ? { disabled: true } : {}) };
    const order = [...Object.keys(fields).map(name => ({ name, kind: 'field' as const }))];
    const inputs = result.inputs!;
    const validateSlot = (name: string, path: string, role: 'value' | 'statement', valid: boolean, actual: string = role) => {
      const activeShape = uncertainSlots ? undefined : shape;
      const slot = inputAt(activeShape, name);
      if (name !== 'next' && valid && (!activeShape || slot === role)) return true;
      const field = !slot ? fieldAt(activeShape, name) : undefined;
      report(path, `Invalid ${role} slot ${pointer}/${name}.`, { blockType, expected: slot ?? field?.type ?? role, actual,
        allowed: field ? fieldOptions(field) : inputOptions(activeShape, slot ?? role) });
      return false;
    };
    for (const [name, child] of Object.entries(values)) {
      const path = `${pointer}/values/${pointerKey(name)}`;
      const valid = validateSlot(name, path, 'value', !Object.hasOwn(statements, name));
      if (!valid && !record(child)) continue;
      inputs[name] = child === null ? {} : { block: block(child, depth + 1, path) };
    }
    for (const [name, children] of Object.entries(statements)) {
      const path = `${pointer}/statements/${pointerKey(name)}`;
      validateSlot(name, path, 'statement', Array.isArray(children), Array.isArray(children) ? 'statement' : actualType(children));
      if (!Array.isArray(children)) continue;
      const chain = children.map((child, index) => block(child, depth + 1, `${path}/${index}`)).filter(child => child !== undefined);
      chain.slice(0, -1).forEach((child, index) => child.next = { block: chain[index + 1] });
      inputs[name] = chain.length ? { block: chain[0] } : {};
    }
    contracts.fields[result.id] = fieldContracts;
    // The canonical renderer gets explicit slot roles from this structured input;
    // the host's real contracts still independently check the emitted source.
    contracts.syntax![result.id] = [...order,
      ...Object.keys(values).map(name => ({ name, kind: 'valueInput' as const })),
      ...Object.keys(statements).map(name => ({ name, kind: 'statementInput' as const }))];
    return result;
  };
  const blocks = program['blocks'].map((value, index) => block(value, 0, `/blocks/${index}`)).filter(child => child !== undefined);
  if (issues.length) fail();
  const workspace: AbsAbiWorkspace = { blocks: { blocks } };
  const rendered = renderAbs(workspace, contracts, { project(value, contract) {
    if (typeof value !== 'string' || !value) throw new AbsSyncError(INVALID_COMPOSE, 'A model reference requires a nonempty name.');
    return { value: value as string, kind: contract.kind, modelId: '' };
  } }, undefined, { namedArguments: true });
  return { abs: rendered.abs, blockCount: count, precheck: precheckAbs(rendered.abs, definitions) };
}
