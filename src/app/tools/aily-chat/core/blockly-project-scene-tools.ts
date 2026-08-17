import type { IToolContribution, ToolResultContent } from 'aily-lex/browser';

import type { InvokeHandler } from './blockly-contributed-tool-runtime';
import { PROJECT_SCENE_AGENT_TYPE } from './agent-identifiers';
import {
  consumeProjectSceneProposalInvocationContext,
  readProjectSceneProposalInvocation,
  submitProjectSceneProposalInvocation,
  type ProjectSceneProposalInvocationInput,
} from './project-scene-proposal-invocation';

export const GET_PROJECT_SCENE_GENERATION_CONTEXT_TOOL =
  'get_project_scene_generation_context';
export const SUBMIT_PROJECT_SCENE_WIRING_INTENT_TOOL =
  'submit_project_scene_wiring_intent';

const SHA_256_PATTERN = /^[a-f0-9]{64}$/u;
const PORTABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;
const SIGNAL_KINDS = new Set([
  'ground',
  'power',
  'gpio',
  'analog',
  'pwm',
  'i2c',
  'spi',
  'uart',
]);
const MAX_COMMANDS = 64;
const MAX_SUMMARY_LENGTH = 512;

interface ProjectSceneToolInvocationContext {
  readonly toolCallId?: string;
  readonly trace?: { readonly turnId?: string };
}

interface WiringPartInput {
  readonly ref: string;
  readonly packageId: string;
  readonly properties: Readonly<Record<string, string | number | boolean>>;
}

interface WiringEndpointInput {
  readonly part: string;
  readonly pin: string;
  readonly function: string;
}

interface WiringNetInput {
  readonly ref: string;
  readonly signal: Readonly<{ kind: string }>;
  readonly endpoints: readonly WiringEndpointInput[];
}

interface SubmitProjectSceneGenerationProposalInput {
  readonly requestId: string;
  readonly summary: string;
  readonly parts: readonly WiringPartInput[];
  readonly nets: readonly WiringNetInput[];
}

interface GenerationComponentPackageGuide {
  readonly packageId: string;
  readonly version: string;
  readonly name: string;
  readonly category: string;
  readonly instanceIdPrefix: string;
  readonly maxInstances: number;
  readonly pins: readonly {
    readonly pinId: string;
    readonly functions: readonly {
      readonly name: string;
      readonly type: string;
    }[];
  }[];
}

function result(value: unknown): ToolResultContent {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
  };
}

function error(message: string): ToolResultContent {
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
  };
}

export function appendProjectSceneGenerationContributions(
  contributions: IToolContribution[],
): void {
  contributions.push(
    {
      name: GET_PROJECT_SCENE_GENERATION_CONTEXT_TOOL,
      toolSet: 'blockly-project-scene',
      description: 'Read the bounded hardware intent and revision baseline for one active Project Scene generation request.',
      prompt: `Use this read-only tool exactly once for the requestId supplied in the provider prompt.
It returns only the provider-neutral generation request, bounded project hardware intent, and a temporary Component Package guide. It never returns a host path, Blockly workspace, legacy JSON body, Scene body, capability token, iframe URL, or runtime process handle.
After inferring the circuit, call ${SUBMIT_PROJECT_SCENE_WIRING_INTENT_TOOL}.`,
      inputSchema: {
        type: 'object',
        properties: {
          requestId: {
            type: 'string',
            description: 'Exact requestId supplied in the provider prompt.',
          },
        },
        required: ['requestId'],
        additionalProperties: false,
      },
      annotations: { readOnly: true, idempotent: true },
      runtimeModes: ['blockly'],
      requiredCapabilities: ['runtime:blockly'],
      agentScope: [PROJECT_SCENE_AGENT_TYPE],
    },
    {
      name: SUBMIT_PROJECT_SCENE_WIRING_INTENT_TOOL,
      toolSet: 'blockly-project-scene',
      description: 'Submit a bounded semantic wiring intent without saving or editing a Scene document.',
      prompt: `Use this only after ${GET_PROJECT_SCENE_GENERATION_CONTEXT_TOOL} returns the matching active request and you have inferred the circuit.
This operation only returns semantic intent to the provider. It cannot save, replace or edit a Scene document and cannot write connection_output.json. Simulator resolves exact package versions, persistent instance/net/segment/junction IDs, layout, routing, colors, diagnostics, diff and revision/CAS.
parts uses request-scoped refs plus packageId values from the supplied catalog snapshot. nets supports two or more endpoints and uses those refs. Each endpoint pin/function must be advertised for its selected package (for example GPIO1, A(IO), C(GND), 3V3, or GND). signal.kind must be ground, power, gpio, analog, pwm, i2c, spi, or uart.
Never submit package versions, instance IDs, segment IDs, line colors, or coordinates. Include the board and every required physical component. LED and button each have two electrical terminals; model pull-up/pull-down or LED current limiting with explicit resistor parts when required.`,
      inputSchema: {
        type: 'object',
        properties: {
          requestId: {
            type: 'string',
            description: `The exact requestId returned by ${GET_PROJECT_SCENE_GENERATION_CONTEXT_TOOL}.`,
          },
          summary: {
            type: 'string',
            description: 'Concise user-facing description of the proposed components and wiring.',
            minLength: 1,
            maxLength: MAX_SUMMARY_LENGTH,
          },
          parts: {
            type: 'array',
            minItems: 1,
            maxItems: MAX_COMMANDS,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                ref: { type: 'string' },
                packageId: { type: 'string' },
                properties: {
                  type: 'object',
                  maxProperties: 16,
                  additionalProperties: {
                    anyOf: [
                      { type: 'string', maxLength: 256 },
                      { type: 'number' },
                      { type: 'boolean' },
                    ],
                  },
                },
              },
              required: ['ref', 'packageId'],
            },
          },
          nets: {
            type: 'array',
            maxItems: MAX_COMMANDS,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                ref: { type: 'string' },
                signal: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    kind: { type: 'string', enum: [...SIGNAL_KINDS] },
                  },
                  required: ['kind'],
                },
                endpoints: {
                  type: 'array',
                  minItems: 2,
                  maxItems: 32,
                  items: { $ref: '#/$defs/endpoint' },
                },
              },
              required: ['ref', 'signal', 'endpoints'],
            },
          },
        },
        $defs: {
          endpoint: {
            type: 'object',
            additionalProperties: false,
            properties: {
              part: { type: 'string' },
              pin: { type: 'string' },
              function: { type: 'string' },
            },
            required: ['part', 'pin', 'function'],
          },
        },
        required: ['requestId', 'summary', 'parts', 'nets'],
        additionalProperties: false,
      },
      annotations: {
        readOnly: false,
        destructive: false,
        idempotent: true,
      },
      runtimeModes: ['blockly'],
      requiredCapabilities: ['runtime:blockly'],
      agentScope: [PROJECT_SCENE_AGENT_TYPE],
    },
  );
}

export function createProjectSceneGenerationHandlers(): Record<string, InvokeHandler> {
  return {
    [GET_PROJECT_SCENE_GENERATION_CONTEXT_TOOL]: async (input) => {
      const requestId = requireRequestIdInput(input);
      const context = consumeProjectSceneProposalInvocationContext(requestId);
      const request = requireGenerationRequest(context);
      const componentPackages = requireGenerationComponentPackages(
        request['componentPackages'],
      );
      const { componentPackages: _catalogProjection, ...boundedRequest } = request;
      void _catalogProjection;
      return result({
        schemaVersion: 1,
        kind: 'aily-project-scene-agent-generation-context',
        request: boundedRequest,
        hardwareIntent: context.hardwareIntent,
        componentPackages,
        constraints: {
          sceneStartsEmpty: true,
          maxCommands: MAX_COMMANDS,
          componentCatalogAuthority: 'simulator-request-snapshot',
          authority: 'electron-main-project-scene',
          forbiddenInputs: [
            'host-path',
            'legacy-json-body',
            'scene-document',
            'capability-token',
            'runtime-process-handle',
          ],
        },
      });
    },
    [SUBMIT_PROJECT_SCENE_WIRING_INTENT_TOOL]: async (
      input,
      _hostAPI,
      invocationContext,
    ) => {
      const requestId = requireRequestIdFromSubmitInput(input);
      const context = readProjectSceneProposalInvocation(requestId);
      const request = requireGenerationRequest(context);
      const normalized = validateSubmitInput(
        input,
        requireGenerationComponentPackages(request['componentPackages']),
      );
      if (Number(request['expiresAtUnixMs']) <= Date.now()) {
        return error('Project Scene generation request has expired.');
      }
      const wiringIntent = buildGenerationWiringIntent(
        context,
        normalized,
        invocationContext,
      );
      submitProjectSceneProposalInvocation(normalized.requestId, wiringIntent);
      return result({
        schemaVersion: 1,
        kind: 'aily-project-scene-agent-wiring-intent-submission-result',
        state: 'submitted',
        requestId: normalized.requestId,
      });
    },
  };
}

export function buildGenerationWiringIntent(
  context: ProjectSceneProposalInvocationInput,
  input: SubmitProjectSceneGenerationProposalInput,
  _invocationContext?: ProjectSceneToolInvocationContext,
): Record<string, unknown> {
  const request = requireGenerationRequest(context);
  const requestId = String(request['requestId']);
  return {
    schemaVersion: 1,
    kind: 'aily-project-wiring-intent',
    requestId,
    mode: 'reconcile',
    summary: input.summary,
    parts: input.parts.map(part => ({
      ref: part.ref,
      packageId: part.packageId,
      properties: { ...part.properties },
    })),
    nets: input.nets.map(net => ({
      ref: net.ref,
      signal: { ...net.signal },
      endpoints: net.endpoints.map(endpoint => ({ ...endpoint })),
    })),
  };
}

function validateSubmitInput(
  value: unknown,
  componentPackages: readonly GenerationComponentPackageGuide[],
): SubmitProjectSceneGenerationProposalInput {
  const input = requireRecord(value, 'wiring intent input');
  requireExactKeys(input, [
    'requestId',
    'summary',
    'parts',
    'nets',
  ], 'wiring intent input');
  const requestId = requirePortableId(input['requestId'], 'requestId');
  const summary = requireText(input['summary'], MAX_SUMMARY_LENGTH, 'summary');
  if (!Array.isArray(input['parts']) || !Array.isArray(input['nets'])) {
    throw new Error('parts and nets must be arrays.');
  }
  if (input['parts'].length < 1) {
    throw new Error('Project wiring intent requires at least one part.');
  }
  if (input['parts'].length + input['nets'].length > MAX_COMMANDS) {
    throw new Error(`Wiring intent permits at most ${MAX_COMMANDS} parts and nets.`);
  }

  const partRefs = new Set<string>();
  const partPackages = new Map<string, GenerationComponentPackageGuide>();
  const packageCounts = new Map<string, number>();
  const packageById = new Map(componentPackages.map((componentPackage) => [
    componentPackage.packageId,
    componentPackage,
  ]));
  const parts = input['parts'].map((entry, index) => {
    const part = requireRecord(entry, `parts[${index}]`);
    requireAllowedKeys(part, ['ref', 'packageId', 'properties'], `parts[${index}]`);
    for (const required of ['ref', 'packageId']) {
      if (!(required in part)) throw new Error(`parts[${index}].${required} is required.`);
    }
    const ref = requirePortableId(part['ref'], `parts[${index}].ref`);
    if (partRefs.has(ref)) throw new Error(`Duplicate wiring part ref: ${ref}`);
    partRefs.add(ref);
    const packageId = requirePortableId(part['packageId'], `parts[${index}].packageId`);
    const componentPackage = packageById.get(packageId);
    if (!componentPackage) {
      throw new Error(`parts[${index}].packageId is not in the Simulator catalog snapshot.`);
    }
    const nextCount = (packageCounts.get(packageId) ?? 0) + 1;
    if (nextCount > componentPackage.maxInstances) {
      throw new Error(`Component Package ${packageId} exceeds maxInstances.`);
    }
    packageCounts.set(packageId, nextCount);
    partPackages.set(ref, componentPackage);
    return {
      ref,
      packageId,
      properties: validateProperties(part['properties'], `parts[${index}].properties`),
    };
  });

  const netRefs = new Set<string>();
  const connectedPins = new Set<string>();
  const nets = input['nets'].map((entry, index) => {
    const net = requireRecord(entry, `nets[${index}]`);
    requireExactKeys(net, ['ref', 'signal', 'endpoints'], `nets[${index}]`);
    const ref = requirePortableId(net['ref'], `nets[${index}].ref`);
    if (netRefs.has(ref)) throw new Error(`Duplicate wiring net ref: ${ref}`);
    netRefs.add(ref);
    const signal = requireRecord(net['signal'], `nets[${index}].signal`);
    requireExactKeys(signal, ['kind'], `nets[${index}].signal`);
    const kind = requireText(signal['kind'], 16, `nets[${index}].signal.kind`);
    if (!SIGNAL_KINDS.has(kind)) throw new Error(`Unsupported signal kind: ${kind}`);
    if (!Array.isArray(net['endpoints']) || net['endpoints'].length < 2 || net['endpoints'].length > 32) {
      throw new Error(`nets[${index}].endpoints must contain 2..32 endpoints.`);
    }
    const localPins = new Set<string>();
    const endpoints = net['endpoints'].map((endpoint, endpointIndex) => {
      const resolved = validateEndpoint(
        endpoint,
        `nets[${index}].endpoints[${endpointIndex}]`,
        partRefs,
        partPackages,
      );
      const identity = `${resolved.part}\0${resolved.pin}`;
      if (localPins.has(identity) || connectedPins.has(identity)) {
        throw new Error(`Wiring endpoint ${resolved.part}.${resolved.pin} is duplicated.`);
      }
      localPins.add(identity);
      connectedPins.add(identity);
      return resolved;
    });
    return {
      ref,
      signal: { kind },
      endpoints,
    };
  });

  return { requestId, summary, parts, nets };
}

function validateEndpoint(
  value: unknown,
  field: string,
  partRefs: ReadonlySet<string>,
  partPackages: ReadonlyMap<string, GenerationComponentPackageGuide>,
): WiringEndpointInput {
  const endpoint = requireRecord(value, field);
  requireExactKeys(endpoint, ['part', 'pin', 'function'], field);
  const part = requirePortableId(endpoint['part'], `${field}.part`);
  if (!partRefs.has(part)) {
    throw new Error(`${field}.part is not declared: ${part}`);
  }
  const pinId = requirePortableId(endpoint['pin'], `${field}.pin`);
  const selectedFunction = requireText(
    endpoint['function'],
    128,
    `${field}.function`,
  );
  const componentPackage = partPackages.get(part);
  const pin = componentPackage?.pins.find((candidate) => candidate.pinId === pinId);
  if (!pin) throw new Error(`${field}.pin is not in the Simulator catalog snapshot.`);
  if (!pin.functions.some((candidate) => candidate.name === selectedFunction)) {
    throw new Error(`${field}.function is not exposed by ${part}.${pinId}.`);
  }
  return { part, pin: pinId, function: selectedFunction };
}

function validateProperties(
  value: unknown,
  field: string,
): Readonly<Record<string, string | number | boolean>> {
  if (value === undefined) return {};
  const properties = requireRecord(value, field);
  if (Object.keys(properties).length > 16) throw new Error(`${field} is too large.`);
  const normalized: Record<string, string | number | boolean> = {};
  for (const [key, property] of Object.entries(properties)) {
    requirePortableId(key, `${field} key`);
    if (typeof property === 'boolean') normalized[key] = property;
    else if (typeof property === 'number' && Number.isFinite(property)) normalized[key] = property;
    else if (typeof property === 'string') normalized[key] = requireText(property, 256, `${field}.${key}`);
    else throw new Error(`${field}.${key} must be a bounded scalar.`);
  }
  return normalized;
}

function requireRequestIdFromSubmitInput(value: unknown): string {
  const input = requireRecord(value, 'proposal input');
  return requirePortableId(input['requestId'], 'requestId');
}

function requireRequestIdInput(value: unknown): string {
  const input = requireRecord(value, 'generation context input');
  requireExactKeys(input, ['requestId'], 'generation context input');
  return requirePortableId(input['requestId'], 'requestId');
}

function requireGenerationRequest(
  context: ProjectSceneProposalInvocationInput,
): Record<string, unknown> {
  const request = requireRecord(context.request, 'generation request');
  requireRequiredAndOptionalKeys(request, [
    'schemaVersion',
    'kind',
    'requestId',
    'projectIdentity',
    'sceneId',
    'reason',
    'base',
    'componentPackages',
    'expiresAtUnixMs',
  ], ['instruction'], 'generation request');
  if (
    request['schemaVersion'] !== 1
    || request['kind'] !== 'aily-project-scene-generation-request'
  ) throw new Error('Project Scene generation request is invalid.');
  requirePortableId(request['requestId'], 'generation request.requestId');
  requirePortableId(request['projectIdentity'], 'generation request.projectIdentity');
  requirePortableId(request['sceneId'], 'generation request.sceneId');
  if (!['missing-scene', 'user-regenerate'].includes(String(request['reason']))) {
    throw new Error('Project Scene generation reason is invalid.');
  }
  const base = requireRecord(request['base'], 'generation request.base');
  requireExactKeys(base, [
    'visualRevision',
    'graphSemanticRevision',
    'catalogRevision',
  ], 'generation request.base');
  requireSha256(base['visualRevision'], 'generation request.base.visualRevision');
  requireSha256(
    base['graphSemanticRevision'],
    'generation request.base.graphSemanticRevision',
  );
  requireSha256(base['catalogRevision'], 'generation request.base.catalogRevision');
  requireGenerationComponentPackages(request['componentPackages']);
  if (
    !Number.isSafeInteger(request['expiresAtUnixMs'])
    || Number(request['expiresAtUnixMs']) <= 0
  ) throw new Error('Project Scene generation expiry is invalid.');
  if (request['instruction'] !== undefined) {
    requireSafeInstruction(request['instruction'], 'generation request.instruction');
  }
  return request;
}

function requireGenerationComponentPackages(
  value: unknown,
): readonly GenerationComponentPackageGuide[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) {
    throw new Error('generation request.componentPackages is invalid.');
  }
  const identities = new Set<string>();
  return value.map((entry, packageIndex) => {
    const field = `generation request.componentPackages[${packageIndex}]`;
    const componentPackage = requireRecord(entry, field);
    requireExactKeys(componentPackage, [
      'packageId',
      'version',
      'name',
      'category',
      'instanceIdPrefix',
      'maxInstances',
      'pins',
    ], field);
    const packageId = requirePortableId(
      componentPackage['packageId'],
      `${field}.packageId`,
    );
    const version = requireText(componentPackage['version'], 64, `${field}.version`);
    if (!SEMVER_PATTERN.test(version)) throw new Error(`${field}.version is invalid.`);
    const identity = `${packageId}\0${version}`;
    if (identities.has(identity)) throw new Error(`${field} is duplicated.`);
    identities.add(identity);
    const maxInstances = componentPackage['maxInstances'];
    if (!Number.isSafeInteger(maxInstances) || Number(maxInstances) < 1 || Number(maxInstances) > 64) {
      throw new Error(`${field}.maxInstances is invalid.`);
    }
    if (!Array.isArray(componentPackage['pins']) || componentPackage['pins'].length < 1) {
      throw new Error(`${field}.pins is invalid.`);
    }
    const pinIds = new Set<string>();
    const pins = componentPackage['pins'].map((pinEntry, pinIndex) => {
      const pinField = `${field}.pins[${pinIndex}]`;
      const pin = requireRecord(pinEntry, pinField);
      requireExactKeys(pin, ['pinId', 'functions'], pinField);
      const pinId = requirePortableId(pin['pinId'], `${pinField}.pinId`);
      if (pinIds.has(pinId)) throw new Error(`${pinField}.pinId is duplicated.`);
      pinIds.add(pinId);
      if (!Array.isArray(pin['functions']) || pin['functions'].length < 1) {
        throw new Error(`${pinField}.functions is invalid.`);
      }
      const names = new Set<string>();
      const functions = pin['functions'].map((functionEntry, functionIndex) => {
        const functionField = `${pinField}.functions[${functionIndex}]`;
        const functionValue = requireRecord(functionEntry, functionField);
        requireExactKeys(functionValue, ['name', 'type'], functionField);
        const name = requireText(functionValue['name'], 128, `${functionField}.name`);
        if (names.has(name)) throw new Error(`${functionField}.name is duplicated.`);
        names.add(name);
        return {
          name,
          type: requirePortableId(functionValue['type'], `${functionField}.type`),
        };
      });
      return { pinId, functions };
    });
    return {
      packageId,
      version,
      name: requireText(componentPackage['name'], 512, `${field}.name`),
      category: requirePortableId(componentPackage['category'], `${field}.category`),
      instanceIdPrefix: requirePortableId(
        componentPackage['instanceIdPrefix'],
        `${field}.instanceIdPrefix`,
      ),
      maxInstances: Number(maxInstances),
      pins,
    };
  });
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} 必须是对象。`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  field: string,
): void {
  const actual = Object.keys(value).sort();
  const normalizedExpected = [...expected].sort();
  if (actual.join('\0') !== normalizedExpected.join('\0')) {
    throw new Error(`${field} 字段不完整或包含越权字段。`);
  }
}

function requireAllowedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw new Error(`${field}.${key} 不受支持。`);
  }
}

function requireRequiredAndOptionalKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  field: string,
): void {
  requireAllowedKeys(value, [...required, ...optional], field);
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      throw new Error(`${field}.${key} is required.`);
    }
  }
}

function requireSafeInstruction(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string.`);
  const normalized = value.trim();
  if (
    normalized.length < 1
    || new TextEncoder().encode(normalized).byteLength > 2 * 1024
    || /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw new Error(`${field} must be safe non-empty text within 2 KiB.`);
  }
  return normalized;
}

function requirePortableId(value: unknown, field: string): string {
  const text = requireText(value, 128, field);
  if (!PORTABLE_ID_PATTERN.test(text)) throw new Error(`${field} 不是 portable ID。`);
  return text;
}

function requireSha256(value: unknown, field: string): string {
  if (typeof value !== 'string' || !SHA_256_PATTERN.test(value)) {
    throw new Error(`${field} 必须是 lowercase SHA-256。`);
  }
  return value;
}

function requireText(value: unknown, maxLength: number, field: string): string {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > maxLength
    || /[\u0000-\u001F\u007F]/u.test(value)
  ) throw new Error(`${field} 文本无效。`);
  return value;
}
