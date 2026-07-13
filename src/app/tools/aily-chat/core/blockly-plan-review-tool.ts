import type { IToolContribution } from 'aily-lex/browser';

import { text, type BlocklyToolInvocationContext, type InvokeHandler } from './blockly-contributed-tool-runtime';

interface PlanReviewActionInput {
  readonly id?: unknown;
  readonly label?: unknown;
  readonly description?: unknown;
  readonly default?: unknown;
  readonly permissionLevel?: unknown;
}

interface PlanReviewToolInput {
  readonly title?: unknown;
  readonly plan?: unknown;
  readonly content?: unknown;
  readonly actions?: unknown;
  readonly canProvideFeedback?: unknown;
}

interface RuntimePlanReviewHost {
  present(review: {
    readonly id: string;
    readonly title: string;
    readonly planUri?: string;
    readonly content: string;
    readonly actions: readonly {
      readonly id: string;
      readonly label: string;
      readonly description?: string;
      readonly default?: boolean;
      readonly permissionLevel?: 'autopilot';
    }[];
    readonly canProvideFeedback: boolean;
  }): Promise<{
    readonly approved: boolean;
    readonly actionId?: string;
    readonly feedback?: string;
  }>;
}

const REVIEW_PLAN_TOOL_NAME = 'review_plan';

export function makePlanReviewContribution(): IToolContribution {
  return {
    name: REVIEW_PLAN_TOOL_NAME,
    toolSet: 'plan-review',
    description: 'Present a structured plan review widget to the user',
    prompt: [
      'Use this internal tool to present a plan to the user for review.',
      'Provide markdown content, one or more approval actions, and whether freeform feedback is allowed.',
      'The tool returns JSON with rejected, action/actionId, and feedback fields.',
      'This is a structured plan-review carrier; it is not a substitute for the final <proposed_plan> artifact.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Title displayed in the widget header. Defaults to "Review plan" if omitted.',
        },
        plan: {
          type: 'string',
          description: 'Optional URI or path of an editable plan file.',
        },
        content: {
          type: 'string',
          description: 'Markdown content rendered in the review widget body.',
        },
        actions: {
          type: 'array',
          description: 'Approval actions shown to the user. Order is preserved.',
          items: {
            type: 'object',
            properties: {
              id: {
                type: 'string',
                description: 'Optional stable action identifier. If omitted, one is derived from label.',
              },
              label: {
                type: 'string',
                description: 'Short action label shown in the dropdown button.',
              },
              description: {
                type: 'string',
                description: 'Optional detail shown below the label.',
              },
              default: {
                type: 'boolean',
                description: 'Whether this action should be selected by default.',
              },
              permissionLevel: {
                type: 'string',
                enum: ['autopilot'],
                description: 'When set to "autopilot", the implementation turn can request autopilot permissions.',
              },
            },
            required: ['label'],
          },
          minItems: 1,
        },
        canProvideFeedback: {
          type: 'boolean',
          description: 'When true, a feedback textarea is shown below the plan content.',
        },
      },
      required: ['content', 'actions', 'canProvideFeedback'],
    },
    annotations: { readOnly: true },
    agentScope: ['main'],
  };
}

export function createPlanReviewHandler(): InvokeHandler {
  return async (input, _hostAPI, invocationContext) => {
    const normalized = normalizePlanReviewInput(input as PlanReviewToolInput, invocationContext);
    if ('error' in normalized) {
      return {
        content: [{ type: 'text', text: normalized.error }],
        isError: true,
      };
    }

    const planReviewHost = invocationContext?.host?.getExtension<RuntimePlanReviewHost>('planReview');
    if (!planReviewHost?.present) {
      return text(JSON.stringify({ rejected: true }));
    }

    const decision = await planReviewHost.present(normalized.review);
    const action = normalized.review.actions.find(item => item.id === decision.actionId);
    return text(JSON.stringify({
      rejected: !decision.approved,
      ...(action ? { action: action.label } : {}),
      ...(decision.actionId ? { actionId: decision.actionId } : {}),
      ...(decision.feedback ? { feedback: decision.feedback } : {}),
    }));
  };
}

function normalizePlanReviewInput(
  input: PlanReviewToolInput,
  invocationContext?: BlocklyToolInvocationContext,
): { review: Parameters<RuntimePlanReviewHost['present']>[0] } | { error: string } {
  const content = typeof input.content === 'string' ? input.content.trim() : '';
  if (!content) {
    return { error: 'review_plan requires non-empty content.' };
  }

  if (!Array.isArray(input.actions) || input.actions.length === 0) {
    return { error: 'review_plan requires at least one action.' };
  }

  const actions = input.actions
    .map((action, index) => normalizePlanReviewAction(action as PlanReviewActionInput, index))
    .filter((action): action is NonNullable<ReturnType<typeof normalizePlanReviewAction>> => !!action);
  if (actions.length === 0) {
    return { error: 'review_plan requires at least one action with a label.' };
  }

  const title = typeof input.title === 'string' && input.title.trim()
    ? input.title.trim()
    : 'Review plan';
  const planUri = typeof input.plan === 'string' && input.plan.trim()
    ? input.plan.trim()
    : undefined;

  return {
    review: {
      id: `plan-review-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      title,
      ...(planUri ? { planUri } : {}),
      content,
      actions,
      canProvideFeedback: input.canProvideFeedback === true,
    },
  };
}

function normalizePlanReviewAction(
  action: PlanReviewActionInput,
  index: number,
): {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly default?: boolean;
  readonly permissionLevel?: 'autopilot';
} | null {
  const label = typeof action?.label === 'string' ? action.label.trim() : '';
  if (!label) {
    return null;
  }

  const id = typeof action.id === 'string' && action.id.trim()
    ? action.id.trim()
    : slugifyPlanReviewActionLabel(label, index);
  const description = typeof action.description === 'string' && action.description.trim()
    ? action.description.trim()
    : undefined;

  return {
    id,
    label,
    ...(description ? { description } : {}),
    ...(action.default === true ? { default: true } : {}),
    ...(action.permissionLevel === 'autopilot' ? { permissionLevel: 'autopilot' as const } : {}),
  };
}

function slugifyPlanReviewActionLabel(label: string, index: number): string {
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return slug || `action_${index + 1}`;
}
