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
export const SUBMIT_PROJECT_SCENE_GENERATION_PROPOSAL_TOOL =
  'submit_project_scene_generation_proposal';

const SHA_256_PATTERN = /^[a-f0-9]{64}$/u;
const PORTABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;
const COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/u;
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

interface ProposalComponentInput {
  readonly instanceId: string;
  readonly package: {
    readonly id: string;
    readonly version: string;
  };
  readonly placement: {
    readonly x: number;
    readonly y: number;
  };
}

interface ProposalEndpointInput {
  readonly instanceId: string;
  readonly pinId: string;
  readonly function: string;
}

interface ProposalConnectionInput {
  readonly segmentId: string;
  readonly from: ProposalEndpointInput;
  readonly to: ProposalEndpointInput;
  readonly signalKind: string;
  readonly label?: string;
  readonly color?: string;
}

interface SubmitProjectSceneGenerationProposalInput {
  readonly requestId: string;
  readonly summary: string;
  readonly components: readonly ProposalComponentInput[];
  readonly connections: readonly ProposalConnectionInput[];
}

const COMPONENT_PACKAGE_GUIDE = Object.freeze([
  Object.freeze({
    id: 'aily.component-package.xiao-esp32s3',
    version: '1.0.0',
    instanceIdPrefix: 'xiao_esp32s3_',
    maxInstances: 1,
    pins: Object.freeze([
      'pin_1:D0/A0/GPIO1/TOUCH1',
      'pin_2:D1/A1/GPIO2/TOUCH2',
      'pin_3:D2/A2/GPIO3/TOUCH3',
      'pin_4:D3/A3/GPIO4/TOUCH4',
      'pin_5:D4/A4/SDA/GPIO5/TOUCH5',
      'pin_6:D5/A5/SCL/GPIO6/TOUCH6',
      'pin_7:D6/TX/GPIO43',
      'pin_8:5V',
      'pin_9:GND',
      'pin_10:3V3',
      'pin_11:D10/A10/MOSI/GPIO9/TOUCH9',
      'pin_12:D9/A9/MISO/GPIO8/TOUCH8',
      'pin_13:D8/A8/SCK/GPIO7/TOUCH7',
      'pin_14:D7/RX/GPIO44',
    ]),
  }),
  Object.freeze({
    id: 'aily.component-package.gpio-led',
    version: '1.0.0',
    instanceIdPrefix: 'led_',
    pins: Object.freeze(['anode:A(IO)/A(3V3)', 'cathode:C(IO)/C(GND)']),
  }),
  Object.freeze({
    id: 'aily.component-package.gpio-button',
    version: '1.0.0',
    instanceIdPrefix: 'button_',
    pins: Object.freeze([
      'terminal_a:A(IO)/A(3V3)/A(GND)',
      'terminal_b:B(IO)/B(3V3)/B(GND)',
    ]),
  }),
  Object.freeze({
    id: 'aily.component-package.resistor',
    version: '1.0.0',
    instanceIdPrefix: 'resistor_',
    pins: Object.freeze([
      'terminal_a:A(IO)/A(3V3)/A(GND)',
      'terminal_b:B(IO)/B(3V3)/B(GND)',
    ]),
  }),
]);

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
After inferring the circuit, call ${SUBMIT_PROJECT_SCENE_GENERATION_PROPOSAL_TOOL}.`,
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
      name: SUBMIT_PROJECT_SCENE_GENERATION_PROPOSAL_TOOL,
      toolSet: 'blockly-project-scene',
      description: 'Submit a bounded Project Scene candidate proposal without saving or editing a Scene document.',
      prompt: `Use this only after ${GET_PROJECT_SCENE_GENERATION_CONTEXT_TOOL} returns the matching active request and you have inferred the circuit.
This operation only returns a candidate to the provider. It cannot save, replace or edit a Scene document and cannot write connection_output.json. The host fills projectIdentity, sceneId, revision baseline, reason, proposalId, and agentRunId.
components declares exact Component Package instances in the new empty Scene. connections creates point-to-point segments between declared component pins. The endpoint function must be one function advertised for that pin (for example GPIO1, A(IO), C(GND), 3V3, or GND). signalKind must be ground, power, gpio, analog, pwm, i2c, spi, or uart.
Use stable unique portable IDs that follow each Component Package instanceIdPrefix. Include the XIAO board and every required physical component. LED and button each have two electrical terminals; model pull-up/pull-down or LED current limiting with explicit resistor components when required.`,
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
          components: {
            type: 'array',
            minItems: 1,
            maxItems: MAX_COMMANDS,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                instanceId: { type: 'string' },
                package: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    id: { type: 'string' },
                    version: { type: 'string' },
                  },
                  required: ['id', 'version'],
                },
                placement: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    x: { type: 'number' },
                    y: { type: 'number' },
                  },
                  required: ['x', 'y'],
                },
              },
              required: ['instanceId', 'package', 'placement'],
            },
          },
          connections: {
            type: 'array',
            maxItems: MAX_COMMANDS,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                segmentId: { type: 'string' },
                from: { $ref: '#/$defs/endpoint' },
                to: { $ref: '#/$defs/endpoint' },
                signalKind: {
                  type: 'string',
                  enum: [...SIGNAL_KINDS],
                },
                label: { type: 'string', maxLength: 128 },
                color: { type: 'string', pattern: '^#[0-9A-Fa-f]{6}$' },
              },
              required: ['segmentId', 'from', 'to', 'signalKind'],
            },
          },
        },
        $defs: {
          endpoint: {
            type: 'object',
            additionalProperties: false,
            properties: {
              instanceId: { type: 'string' },
              pinId: { type: 'string' },
              function: { type: 'string' },
            },
            required: ['instanceId', 'pinId', 'function'],
          },
        },
        required: ['requestId', 'summary', 'components', 'connections'],
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
      return result({
        schemaVersion: 1,
        kind: 'aily-project-scene-agent-generation-context',
        request: context.request,
        hardwareIntent: context.hardwareIntent,
        componentPackages: COMPONENT_PACKAGE_GUIDE,
        constraints: {
          sceneStartsEmpty: true,
          maxCommands: MAX_COMMANDS,
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
    [SUBMIT_PROJECT_SCENE_GENERATION_PROPOSAL_TOOL]: async (
      input,
      _hostAPI,
      invocationContext,
    ) => {
      const normalized = validateSubmitInput(input);
      const context = readProjectSceneProposalInvocation(normalized.requestId);
      const request = requireGenerationRequest(context);
      if (Number(request['expiresAtUnixMs']) <= Date.now()) {
        return error('Project Scene generation request has expired.');
      }
      const proposal = buildGenerationProposal(
        context,
        normalized,
        invocationContext,
      );
      submitProjectSceneProposalInvocation(normalized.requestId, proposal);
      return result({
        schemaVersion: 1,
        kind: 'aily-project-scene-agent-proposal-submission-result',
        state: 'submitted',
        requestId: normalized.requestId,
        proposalId: proposal['proposalId'],
      });
    },
  };
}

export function buildGenerationProposal(
  context: ProjectSceneProposalInvocationInput,
  input: SubmitProjectSceneGenerationProposalInput,
  invocationContext?: ProjectSceneToolInvocationContext,
): Record<string, unknown> {
  const request = requireGenerationRequest(context);
  const requestId = String(request['requestId']);
  const proposalId = createPortableRuntimeId(
    'scene-proposal',
    invocationContext?.toolCallId,
    requestId,
  );
  const agentRunId = createPortableRuntimeId(
    'scene-agent-run',
    invocationContext?.trace?.turnId,
    invocationContext?.toolCallId ?? requestId,
  );
  return {
    schemaVersion: 1,
    kind: 'aily-agent-scene-change-proposal',
    proposalId,
    agentRunId,
    reason: request['reason'] === 'legacy-detected'
      ? 'legacy-regeneration'
      : 'user-requested-change',
    summary: input.summary,
    target: {
      projectIdentity: request['projectIdentity'],
      sceneId: request['sceneId'],
    },
    base: {
      ...(requireRecord(request['base'], 'request.base') as {
        visualRevision: string;
        graphSemanticRevision: string;
        catalogRevision: string;
      }),
    },
    componentMutations: input.components.map((component) => ({
      type: 'instantiate-component',
      instanceId: component.instanceId,
      package: { ...component.package },
      placement: { ...component.placement },
    })),
    batch: input.connections.length === 0
      ? null
      : {
          schemaVersion: 1,
          kind: 'aily-scene-editor-network-command-batch',
          commands: input.connections.map((connection) => ({
            type: 'create-segment',
            segmentId: connection.segmentId,
            from: {
              kind: 'component-terminal',
              ...connection.from,
              extensions: {},
            },
            to: {
              kind: 'component-terminal',
              ...connection.to,
              extensions: {},
            },
            signalKind: connection.signalKind,
            presentation: {
              label: connection.label ?? '',
              color: connection.color ?? defaultSignalColor(connection.signalKind),
              vertices: [],
            },
            extensions: {},
          })),
        },
  };
}

function validateSubmitInput(value: unknown): SubmitProjectSceneGenerationProposalInput {
  const input = requireRecord(value, 'proposal input');
  requireExactKeys(input, [
    'requestId',
    'summary',
    'components',
    'connections',
  ], 'proposal input');
  const requestId = requirePortableId(input['requestId'], 'requestId');
  const summary = requireText(input['summary'], MAX_SUMMARY_LENGTH, 'summary');
  if (!Array.isArray(input['components']) || !Array.isArray(input['connections'])) {
    throw new Error('components 与 connections 必须是数组。');
  }
  if (input['components'].length < 1) {
    throw new Error('新的 Project Scene 至少需要一个 Component Package。');
  }
  if (input['components'].length + input['connections'].length > MAX_COMMANDS) {
    throw new Error(`proposal 最多允许 ${MAX_COMMANDS} 个组件/连线命令。`);
  }

  const instanceIds = new Set<string>();
  const components = input['components'].map((entry, index) => {
    const component = requireRecord(entry, `components[${index}]`);
    requireExactKeys(component, ['instanceId', 'package', 'placement'], `components[${index}]`);
    const instanceId = requirePortableId(component['instanceId'], `components[${index}].instanceId`);
    if (instanceIds.has(instanceId)) throw new Error(`组件 instanceId 重复：${instanceId}`);
    instanceIds.add(instanceId);
    const packageReference = requireRecord(component['package'], `components[${index}].package`);
    requireExactKeys(packageReference, ['id', 'version'], `components[${index}].package`);
    const packageId = requirePortableId(packageReference['id'], `components[${index}].package.id`);
    const version = requireText(packageReference['version'], 64, `components[${index}].package.version`);
    if (!SEMVER_PATTERN.test(version)) throw new Error(`Component Package version 无效：${version}`);
    const placement = requireRecord(component['placement'], `components[${index}].placement`);
    requireExactKeys(placement, ['x', 'y'], `components[${index}].placement`);
    return {
      instanceId,
      package: { id: packageId, version },
      placement: {
        x: requireCoordinate(placement['x'], `components[${index}].placement.x`),
        y: requireCoordinate(placement['y'], `components[${index}].placement.y`),
      },
    };
  });

  const segmentIds = new Set<string>();
  const connections = input['connections'].map((entry, index) => {
    const connection = requireRecord(entry, `connections[${index}]`);
    requireAllowedKeys(connection, [
      'segmentId',
      'from',
      'to',
      'signalKind',
      'label',
      'color',
    ], `connections[${index}]`);
    for (const key of ['segmentId', 'from', 'to', 'signalKind']) {
      if (!(key in connection)) throw new Error(`connections[${index}].${key} 缺失。`);
    }
    const segmentId = requirePortableId(connection['segmentId'], `connections[${index}].segmentId`);
    if (segmentIds.has(segmentId)) throw new Error(`连线 segmentId 重复：${segmentId}`);
    segmentIds.add(segmentId);
    const from = validateEndpoint(connection['from'], `connections[${index}].from`, instanceIds);
    const to = validateEndpoint(connection['to'], `connections[${index}].to`, instanceIds);
    if (from.instanceId === to.instanceId && from.pinId === to.pinId) {
      throw new Error(`connections[${index}] 不能把同一引脚连接到自身。`);
    }
    const signalKind = requireText(connection['signalKind'], 16, `connections[${index}].signalKind`);
    if (!SIGNAL_KINDS.has(signalKind)) throw new Error(`signalKind 不受支持：${signalKind}`);
    const label = connection['label'] === undefined
      ? undefined
      : requireOptionalText(connection['label'], 128, `connections[${index}].label`);
    const color = connection['color'] === undefined
      ? undefined
      : requireText(connection['color'], 7, `connections[${index}].color`);
    if (color !== undefined && !COLOR_PATTERN.test(color)) {
      throw new Error(`connections[${index}].color 必须是 #RRGGBB。`);
    }
    return {
      segmentId,
      from,
      to,
      signalKind,
      ...(label !== undefined ? { label } : {}),
      ...(color !== undefined ? { color } : {}),
    };
  });

  return { requestId, summary, components, connections };
}

function validateEndpoint(
  value: unknown,
  field: string,
  instanceIds: ReadonlySet<string>,
): ProposalEndpointInput {
  const endpoint = requireRecord(value, field);
  requireExactKeys(endpoint, ['instanceId', 'pinId', 'function'], field);
  const instanceId = requirePortableId(endpoint['instanceId'], `${field}.instanceId`);
  if (!instanceIds.has(instanceId)) {
    throw new Error(`${field}.instanceId 未在 components 中声明：${instanceId}`);
  }
  return {
    instanceId,
    pinId: requirePortableId(endpoint['pinId'], `${field}.pinId`),
    function: requireText(endpoint['function'], 128, `${field}.function`),
  };
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
  requireExactKeys(request, [
    'schemaVersion',
    'kind',
    'requestId',
    'projectIdentity',
    'sceneId',
    'reason',
    'base',
    'legacySource',
    'expiresAtUnixMs',
  ], 'generation request');
  if (
    request['schemaVersion'] !== 1
    || request['kind'] !== 'aily-project-scene-generation-request'
  ) throw new Error('Project Scene generation request is invalid.');
  requirePortableId(request['requestId'], 'generation request.requestId');
  requirePortableId(request['projectIdentity'], 'generation request.projectIdentity');
  requirePortableId(request['sceneId'], 'generation request.sceneId');
  if (!['missing-scene', 'legacy-detected', 'user-regenerate'].includes(String(request['reason']))) {
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
  if (request['reason'] === 'legacy-detected') {
    const legacySource = requireRecord(
      request['legacySource'],
      'generation request.legacySource',
    );
    requireExactKeys(
      legacySource,
      ['kind', 'revision', 'bytes'],
      'generation request.legacySource',
    );
    if (
      legacySource['kind'] !== 'connection-output-v1'
      || !Number.isSafeInteger(legacySource['bytes'])
      || Number(legacySource['bytes']) < 1
    ) throw new Error('Project Scene generation legacy source metadata is invalid.');
    requireSha256(legacySource['revision'], 'generation request.legacySource.revision');
  } else if (request['legacySource'] !== null) {
    throw new Error('Only legacy-detected generation may include legacy source metadata.');
  }
  if (
    !Number.isSafeInteger(request['expiresAtUnixMs'])
    || Number(request['expiresAtUnixMs']) <= 0
  ) throw new Error('Project Scene generation expiry is invalid.');
  return request;
}

function createPortableRuntimeId(
  prefix: string,
  value: string | undefined,
  fallback: string,
): string {
  const source = typeof value === 'string' && value.trim() ? value : fallback;
  const suffix = source
    .replace(/[^A-Za-z0-9._:-]+/gu, '-')
    .replace(/^-+/u, '')
    .slice(0, Math.max(1, 127 - prefix.length));
  return `${prefix}:${suffix || 'unknown'}`.slice(0, 128);
}

function defaultSignalColor(signalKind: string): string {
  switch (signalKind) {
    case 'ground': return '#111827';
    case 'power': return '#EF4444';
    case 'analog': return '#10B981';
    case 'pwm': return '#EAB308';
    case 'i2c': return '#8B5CF6';
    case 'spi': return '#EC4899';
    case 'uart': return '#F59E0B';
    case 'gpio':
    default: return '#3B82F6';
  }
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

function requireOptionalText(value: unknown, maxLength: number, field: string): string {
  if (value === '') return '';
  return requireText(value, maxLength, field);
}

function requireCoordinate(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1_000_000) {
    throw new Error(`${field} 坐标无效。`);
  }
  return value;
}
