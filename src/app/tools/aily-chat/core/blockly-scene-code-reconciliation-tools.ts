import type { IToolContribution, ToolResultContent } from 'aily-lex/browser';

import type { InvokeHandler } from './blockly-contributed-tool-runtime';
import { SCENE_CODE_RECONCILIATION_AGENT_TYPE } from './agent-identifiers';
import {
  consumeSceneCodeReconciliationInvocationContext,
  readSceneCodeReconciliationInvocation,
  submitSceneCodeReconciliationInvocation,
  type SceneCodeReconciliationCandidate,
} from './scene-code-reconciliation-invocation';

export const GET_SCENE_CODE_RECONCILIATION_CONTEXT_TOOL =
  'get_scene_code_reconciliation_context';
export const SUBMIT_SCENE_CODE_RECONCILIATION_CANDIDATE_TOOL =
  'submit_scene_code_reconciliation_candidate';

const MAX_SUMMARY_LENGTH = 512;
const MAX_ABS_CONTENT_LENGTH = 1_000_000;

interface SceneCodeReconciliationToolInvocationContext {
  readonly toolCallId?: string;
  readonly trace?: { readonly turnId?: string };
}

interface SubmitCandidateInput {
  readonly requestId: string;
  readonly outcome: 'applied' | 'already-aligned';
  readonly summary: string;
  readonly absContent: string | null;
}

function result(value: unknown): ToolResultContent {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
  };
}

export function appendSceneCodeReconciliationContributions(
  contributions: IToolContribution[],
): void {
  contributions.push(
    {
      name: GET_SCENE_CODE_RECONCILIATION_CONTEXT_TOOL,
      toolSet: 'blockly-scene-code-reconciliation',
      description:
        'Read one bounded native Scene revision and the current Blockly ABS program.',
      prompt: `Use this read-only tool exactly once with the requestId supplied in the scoped provider prompt.
It returns the exact Scene revision and the current ABS working copy for one active reconciliation request. It never returns a host path, capability token, iframe handle, Simulator process, QEMU/GDB control, legacy connection JSON, or AWS.
After producing either a changed complete ABS program or an already-aligned decision, call ${SUBMIT_SCENE_CODE_RECONCILIATION_CANDIDATE_TOOL}.`,
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
      agentScope: [SCENE_CODE_RECONCILIATION_AGENT_TYPE],
    },
    {
      name: SUBMIT_SCENE_CODE_RECONCILIATION_CANDIDATE_TOOL,
      toolSet: 'blockly-scene-code-reconciliation',
      description:
        'Submit a complete ABS candidate for Host review without editing Blockly.',
      prompt: `Use this exactly once after ${GET_SCENE_CODE_RECONCILIATION_CONTEXT_TOOL}.
For outcome="applied", absContent must contain the complete changed ABS program. For outcome="already-aligned", absContent must be null.
This tool only returns a candidate to the Host product boundary. It cannot write project.abs, mutate Blockly, build firmware, import an Artifact, or control Simulator/QEMU/GDB. The Host performs a separate explicit user approval and stale-working-copy check before any import.`,
      inputSchema: {
        type: 'object',
        properties: {
          requestId: { type: 'string' },
          outcome: {
            type: 'string',
            enum: ['applied', 'already-aligned'],
          },
          summary: {
            type: 'string',
            minLength: 1,
            maxLength: MAX_SUMMARY_LENGTH,
          },
          absContent: {
            oneOf: [
              {
                type: 'string',
                minLength: 1,
                maxLength: MAX_ABS_CONTENT_LENGTH,
              },
              { type: 'null' },
            ],
          },
        },
        required: ['requestId', 'outcome', 'summary', 'absContent'],
        additionalProperties: false,
      },
      annotations: {
        readOnly: false,
        destructive: false,
        idempotent: true,
      },
      runtimeModes: ['blockly'],
      requiredCapabilities: ['runtime:blockly'],
      agentScope: [SCENE_CODE_RECONCILIATION_AGENT_TYPE],
    },
  );
}

export function createSceneCodeReconciliationHandlers():
Record<string, InvokeHandler> {
  return {
    [GET_SCENE_CODE_RECONCILIATION_CONTEXT_TOOL]: async (input) => {
      const requestId = requireRequestIdInput(input);
      const context =
        consumeSceneCodeReconciliationInvocationContext(requestId);
      return result({
        schemaVersion: 1,
        kind: 'aily-scene-code-reconciliation-agent-context',
        request: context.request,
        currentProgram: {
          format: 'aily-block-syntax',
          content: context.currentAbs,
        },
        constraints: {
          outputMustBeCompleteAbs: true,
          maxAbsCharacters: MAX_ABS_CONTENT_LENGTH,
          authority: 'blockly-host-product-adapter',
          approval: 'host-after-candidate',
          forbiddenInputs: [
            'host-path',
            'capability-token',
            'legacy-connection-json',
            'aws',
            'iframe-handle',
            'runtime-process-handle',
          ],
        },
      });
    },
    [SUBMIT_SCENE_CODE_RECONCILIATION_CANDIDATE_TOOL]: async (
      input,
      _hostAPI,
      invocationContext,
    ) => {
      const normalized = validateSubmitInput(input);
      readSceneCodeReconciliationInvocation(normalized.requestId);
      const candidate = buildCandidate(normalized, invocationContext);
      submitSceneCodeReconciliationInvocation(
        normalized.requestId,
        candidate,
      );
      return result({
        schemaVersion: 1,
        kind: 'aily-scene-code-reconciliation-candidate-submission-result',
        state: 'submitted',
        requestId: normalized.requestId,
        agentRunId: candidate.agentRunId,
      });
    },
  };
}

function buildCandidate(
  input: SubmitCandidateInput,
  invocationContext?: SceneCodeReconciliationToolInvocationContext,
): SceneCodeReconciliationCandidate {
  return {
    schemaVersion: 1,
    kind: 'aily-scene-code-reconciliation-agent-candidate',
    requestId: input.requestId,
    outcome: input.outcome,
    summary: input.summary,
    candidateAbs: input.absContent,
    agentRunId: createPortableRuntimeId(
      'scene-code-agent',
      invocationContext?.trace?.turnId,
      invocationContext?.toolCallId ?? input.requestId,
    ),
  };
}

function validateSubmitInput(value: unknown): SubmitCandidateInput {
  const input = requireRecord(value, 'candidate input');
  requireExactKeys(input, [
    'requestId',
    'outcome',
    'summary',
    'absContent',
  ], 'candidate input');
  const outcome = input['outcome'];
  if (outcome !== 'applied' && outcome !== 'already-aligned') {
    throw new TypeError('candidate outcome is invalid.');
  }
  const absContent = input['absContent'] === null
    ? null
    : requireAbsContent(input['absContent'], 'absContent');
  if (
    (outcome === 'already-aligned' && absContent !== null)
    || (outcome === 'applied' && absContent === null)
  ) {
    throw new TypeError(
      'candidate outcome and absContent are inconsistent.',
    );
  }
  return {
    requestId: requirePortableIdentifier(
      input['requestId'],
      'requestId',
    ),
    outcome,
    summary: requireText(input['summary'], MAX_SUMMARY_LENGTH, 'summary'),
    absContent,
  };
}

function requireRequestIdInput(value: unknown): string {
  const input = requireRecord(value, 'reconciliation context input');
  requireExactKeys(
    input,
    ['requestId'],
    'reconciliation context input',
  );
  return requirePortableIdentifier(input['requestId'], 'requestId');
}

function createPortableRuntimeId(
  prefix: string,
  primary: unknown,
  fallback: unknown,
): string {
  const candidate = [primary, fallback]
    .find(value => typeof value === 'string' && value.trim().length > 0);
  const normalized = String(candidate ?? 'unknown')
    .trim()
    .replace(/[^A-Za-z0-9._:-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 96);
  return `${prefix}:${normalized || 'unknown'}`.slice(0, 128);
}

function requireRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  if (
    Object.keys(value).length !== keys.length
    || keys.some(key => !Object.hasOwn(value, key))
  ) {
    throw new TypeError(`${label} contains unsupported fields.`);
  }
}

function requirePortableIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)
  ) {
    throw new TypeError(`${label} must be a portable identifier.`);
  }
  return value;
}

function requireText(
  value: unknown,
  maximumLength: number,
  label: string,
): string {
  if (
    typeof value !== 'string'
    || value.trim().length < 1
    || value.length > maximumLength
  ) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value.trim();
}

function requireAbsContent(value: unknown, label: string): string {
  if (
    typeof value !== 'string'
    || value.trim().length < 1
    || value.length > MAX_ABS_CONTENT_LENGTH
  ) {
    throw new TypeError(`${label} must contain a bounded ABS program.`);
  }
  return value;
}
