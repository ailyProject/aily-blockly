import { parse } from 'acorn';
import type { NativeCandidateRequest } from './blockly-native-candidate-protocol';
import { hasUniqueAbsArguments } from '../../../integrations/blockly/abs/abs-argument-identity';
import { assertNativeBudget } from './blockly-native-budget';

/** Validate the synchronous replay subset without rewriting library source. */
export function assertSynchronousNativeCandidate(request: NativeCandidateRequest): void {
  if (request.modelRequestId !== undefined && (request.abs === undefined || !/^[a-zA-Z0-9-]{16,80}$/.test(request.modelRequestId))) {
    throw new Error('Native model preparation requires an internal ABS request namespace.');
  }
  if (!Array.isArray(request.steps) || !Array.isArray(request.blocks)) throw new Error('Native candidate requires steps and blocks arrays.');
  assertNativeBudget('requestCharacters', JSON.stringify(request).length, 'request');
  for (const [key, resource] of [['blocks', 'blocks'], ['identities', 'identities'], ['variables', 'variables'],
    ['creations', 'defaultCreations'], ['hostCalls', 'hostCalls'], ['values', 'resources']] as const) {
    if (Array.isArray(request[key])) assertNativeBudget(resource, request[key]!.length, 'request');
  }
  for (const call of Array.isArray(request.hostCalls) ? request.hostCalls : []) {
    if (Array.isArray(call?.argumentOrder)) assertNativeBudget('arguments', call.argumentOrder.length, 'request');
  }
  if (request.abs !== undefined && (typeof request.abs !== 'string' || request.blocks.length)) {
    throw new Error('Native candidate requires either ABS source or explicit blocks, not both.');
  }
  if (request.identities !== undefined && (request.abs === undefined || !Array.isArray(request.identities)
    || request.identities.some(item => !Number.isInteger(item.start) || item.start < 0 || typeof item.id !== 'string' || !item.id)
    || new Set(request.identities.map(item => item.start)).size !== request.identities.length
    || new Set(request.identities.map(item => item.id)).size !== request.identities.length)) {
    throw new Error('Native candidate identities must uniquely cover ABS calls.');
  }
  if (request.variables !== undefined && (!Array.isArray(request.variables)
    || request.variables.some(model => !model || typeof model.id !== 'string' || !model.id || typeof model.name !== 'string'
      || model.type !== undefined && typeof model.type !== 'string')
    || new Set(request.variables.map(model => model.id)).size !== request.variables.length)) {
    throw new Error('Native candidate requires an explicit, unique variable model table.');
  }
  if (request.creations !== undefined && (request.abs === undefined || !request.identities || !Array.isArray(request.creations)
    || request.creations.some(entry => !entry || !Number.isInteger(entry.owner) || entry.owner < 0
      || !Number.isInteger(entry.ordinal) || entry.ordinal < 0 || typeof entry.type !== 'string' || !entry.type || typeof entry.id !== 'string' || !entry.id)
    || new Set(request.creations.map(entry => `${entry.owner}:${entry.ordinal}`)).size !== request.creations.length
    || request.creations.some(entry => !request.identities!.some(owner => owner.start === entry.owner) || request.identities!.some(owner => owner.id === entry.id)))) {
    throw new Error('Native default identities require a unique, bounded ABS creation journal.');
  }
  if (request.hostCalls !== undefined && (request.abs === undefined || !Array.isArray(request.hostCalls)
    || request.hostCalls.some(call => !call || !Number.isInteger(call.start) || call.start < 0 || typeof call.type !== 'string' || !call.type
      || call.argumentOrder !== undefined && (!Array.isArray(call.argumentOrder)
        || call.argumentOrder.some(arg => !arg || typeof arg.name !== 'string' || !['field', 'valueInput', 'statementInput'].includes(arg.kind))
        || !hasUniqueAbsArguments(call.argumentOrder)))
    || new Set(request.hostCalls.map(call => call.start)).size !== request.hostCalls.length)) {
    throw new Error('Native host bindings require unique source calls and valid argument orders.');
  }
  if (request.values !== undefined && !Array.isArray(request.values)) {
    throw new Error('Native resource snapshots require bounded entries.');
  }
  if (request.verify !== undefined && (request.abs !== undefined || request.blocks.length || request.identities !== undefined || request.creations !== undefined || request.variables !== undefined || request.hostCalls !== undefined)) {
    throw new Error('Native ABI verification cannot be mixed with binding or explicit blocks.');
  }
  for (const step of request.steps) {
    if (step.kind !== 'script') continue;
    const nodes: any[] = [parse(step.source, { ecmaVersion: 'latest', sourceType: 'script' })];
    while (nodes.length) {
      const node = nodes.pop();
      if (node.async || node.type === 'AwaitExpression' || node.type === 'ImportExpression'
        || node.type === 'ForOfStatement' && node.await) {
        throw new Error(`Native candidate does not support async/await or dynamic import. Source: ${step.label}`);
      }
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) nodes.push(...value.filter(child => child && typeof child.type === 'string'));
        else if (value && typeof (value as any).type === 'string') nodes.push(value);
      }
    }
  }
}
