import type { TurnResponseFollowup, TurnResponseTurn } from 'aily-lex/browser';

export function normalizeTurnResponseSummaryPreview(summaryPreview: string | null | undefined): string | undefined {
  return typeof summaryPreview === 'string' && summaryPreview.trim()
    ? summaryPreview.trim()
    : undefined;
}

export type TurnResponseRoundSummaryCarrier = NonNullable<NonNullable<TurnResponseTurn['responseModel']>['summary']>;

function normalizeOptionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim()
    ? value.trim()
    : undefined;
}

export function cloneTurnResponseModelRouting(
  modelRouting: TurnResponseTurn['responseModel']['modelRouting'] | undefined,
): TurnResponseTurn['responseModel']['modelRouting'] | undefined {
  const requestedModel = normalizeOptionalText(modelRouting?.requestedModel);
  const requestedPresetId = normalizeOptionalText(modelRouting?.requestedPresetId);
  const selectedModel = normalizeOptionalText(modelRouting?.selectedModel);
  const selectedFamily = normalizeOptionalText(modelRouting?.selectedFamily);
  const selectedPresetId = normalizeOptionalText(modelRouting?.selectedPresetId);
  const candidateModels = Array.isArray(modelRouting?.candidateModels)
    ? modelRouting.candidateModels
      .map(model => normalizeOptionalText(model))
      .filter((model): model is string => !!model)
    : undefined;
  const predictedLabel = normalizeOptionalText(modelRouting?.predictedLabel);
  const confidence = typeof modelRouting?.confidence === 'number' && Number.isFinite(modelRouting.confidence)
    ? modelRouting.confidence
    : undefined;
  const scores = modelRouting?.scores
    ? Object.fromEntries(
      Object.entries(modelRouting.scores)
        .filter(([, score]) => typeof score === 'number' && Number.isFinite(score))
        .map(([model, score]) => [model, score]),
    )
    : undefined;
  const latencyMs = typeof modelRouting?.latencyMs === 'number' && Number.isFinite(modelRouting.latencyMs) && modelRouting.latencyMs >= 0
    ? modelRouting.latencyMs
    : undefined;
  const candidateCount = typeof modelRouting?.candidateCount === 'number' && Number.isFinite(modelRouting.candidateCount) && modelRouting.candidateCount >= 0
    ? modelRouting.candidateCount
    : undefined;
  const fallback = typeof modelRouting?.fallback === 'boolean'
    ? modelRouting.fallback
    : undefined;
  const fallbackReason = normalizeOptionalText(modelRouting?.fallbackReason);
  const stickyOverride = typeof modelRouting?.stickyOverride === 'boolean'
    ? modelRouting.stickyOverride
    : undefined;
  const routingMethod = normalizeOptionalText(modelRouting?.routingMethod);
  const policyVersion = normalizeOptionalText(modelRouting?.policyVersion);
  const modelBillingLabel = normalizeOptionalText(modelRouting?.modelBillingLabel);

  if (!requestedModel && !requestedPresetId && !selectedModel && !selectedFamily && !selectedPresetId && !candidateModels?.length && !predictedLabel && confidence === undefined && !scores && latencyMs === undefined && candidateCount === undefined && fallback === undefined && !fallbackReason && stickyOverride === undefined && !routingMethod && !policyVersion && !modelBillingLabel) {
    return undefined;
  }

  return {
    ...(requestedModel ? { requestedModel } : {}),
    ...(requestedPresetId ? { requestedPresetId } : {}),
    ...(selectedModel ? { selectedModel } : {}),
    ...(selectedFamily ? { selectedFamily } : {}),
    ...(selectedPresetId ? { selectedPresetId } : {}),
    ...(candidateModels?.length ? { candidateModels } : {}),
    ...(predictedLabel ? { predictedLabel } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
    ...(scores && Object.keys(scores).length > 0 ? { scores } : {}),
    ...(latencyMs !== undefined ? { latencyMs } : {}),
    ...(candidateCount !== undefined ? { candidateCount } : {}),
    ...(fallback !== undefined ? { fallback } : {}),
    ...(fallbackReason ? { fallbackReason } : {}),
    ...(stickyOverride !== undefined ? { stickyOverride } : {}),
    ...(routingMethod ? { routingMethod } : {}),
    ...(policyVersion ? { policyVersion } : {}),
    ...(modelBillingLabel ? { modelBillingLabel } : {}),
  };
}

function normalizeTurnResponseRoundSummarySource(
  source: unknown,
): TurnResponseRoundSummaryCarrier['source'] | undefined {
  return source === 'background' || source === 'foreground' || source === 'heuristic'
    ? source
    : undefined;
}

export function cloneTurnResponseRoundSummaryCarrier(
  summary: TurnResponseTurn['responseModel']['summary'] | undefined,
): TurnResponseRoundSummaryCarrier | undefined {
  const toolCallRoundId = normalizeOptionalText(summary?.toolCallRoundId);
  const text = normalizeOptionalText(summary?.text);
  const source = normalizeTurnResponseRoundSummarySource(summary?.source);

  if (!toolCallRoundId || !text) {
    return undefined;
  }

  return {
    toolCallRoundId,
    text,
    ...(source ? { source } : {}),
  };
}

export function cloneTurnResponseRoundSummaryCarriers(
  summaries: TurnResponseTurn['responseModel']['summaries'] | undefined,
): readonly TurnResponseRoundSummaryCarrier[] | undefined {
  const cloned = (summaries ?? [])
    .map(summary => cloneTurnResponseRoundSummaryCarrier(summary))
    .filter((summary): summary is TurnResponseRoundSummaryCarrier => !!summary);

  return cloned.length > 0 ? cloned : undefined;
}

export function getTurnResponseResolvedModelName(
  turn:
    | {
      responseModel?: {
        modelName?: string | null;
        modelRouting?: { selectedModel?: string | null } | null;
      } | null;
      response?: unknown;
    }
    | null
    | undefined,
): string | undefined {
  const responseModelName = normalizeOptionalText(turn?.responseModel?.modelName);
  if (responseModelName) {
    return responseModelName;
  }

  const routedModelName = normalizeOptionalText(turn?.responseModel?.modelRouting?.selectedModel);
  if (routedModelName) {
    return routedModelName;
  }

  const response = turn?.response as { continuation?: { diagnostics?: unknown } | null } | null | undefined;
  const continuationDiagnostics = response?.continuation?.diagnostics;
  if (!continuationDiagnostics || typeof continuationDiagnostics !== 'object') {
    return undefined;
  }

  const usage = 'usage' in continuationDiagnostics ? continuationDiagnostics['usage'] : undefined;
  if (!usage || typeof usage !== 'object') {
    return undefined;
  }

  return 'resolvedModel' in usage
    ? normalizeOptionalText(usage['resolvedModel'])
    : undefined;
}

export function getTurnResponseResolvedPresetId(
  turn:
    | {
      responseModel?: {
        modelRouting?: { selectedPresetId?: string | null } | null;
      } | null;
      response?: unknown;
    }
    | null
    | undefined,
): string | undefined {
  const routedPresetId = normalizeOptionalText(turn?.responseModel?.modelRouting?.selectedPresetId);
  if (routedPresetId) {
    return routedPresetId;
  }

  const response = turn?.response as { continuation?: { diagnostics?: unknown } | null } | null | undefined;
  const continuationDiagnostics = response?.continuation?.diagnostics;
  if (!continuationDiagnostics || typeof continuationDiagnostics !== 'object') {
    return undefined;
  }

  const usage = 'usage' in continuationDiagnostics ? continuationDiagnostics['usage'] : undefined;
  if (!usage || typeof usage !== 'object') {
    return undefined;
  }

  return 'selectedPresetId' in usage
    ? normalizeOptionalText(usage['selectedPresetId'])
    : undefined;
}

export function getTurnResponseResolvedModelBillingLabel(
  turn:
    | {
      responseModel?: {
        modelBillingLabel?: string | null;
        modelRouting?: { modelBillingLabel?: string | null } | null;
      } | null;
      response?: unknown;
    }
    | null
    | undefined,
): string | undefined {
  const responseModelBillingLabel = normalizeOptionalText(turn?.responseModel?.modelBillingLabel);
  if (responseModelBillingLabel) {
    return responseModelBillingLabel;
  }

  const routedModelBillingLabel = normalizeOptionalText(turn?.responseModel?.modelRouting?.modelBillingLabel);
  if (routedModelBillingLabel) {
    return routedModelBillingLabel;
  }

  const response = turn?.response as { continuation?: { diagnostics?: unknown } | null } | null | undefined;
  const continuationDiagnostics = response?.continuation?.diagnostics;
  if (!continuationDiagnostics || typeof continuationDiagnostics !== 'object') {
    return undefined;
  }

  const usage = 'usage' in continuationDiagnostics ? continuationDiagnostics['usage'] : undefined;
  if (!usage || typeof usage !== 'object') {
    return undefined;
  }

  return 'modelBillingLabel' in usage
    ? normalizeOptionalText(usage['modelBillingLabel'])
    : undefined;
}

export function cloneTurnResponseModelSidecar(
  responseModel: TurnResponseTurn['responseModel'] | undefined,
): TurnResponseTurn['responseModel'] | undefined {
  if (!responseModel) {
    return undefined;
  }

  const modelName = normalizeOptionalText(responseModel.modelName);
  const modelBillingLabel = normalizeOptionalText(responseModel.modelBillingLabel);
  const modelRouting = cloneTurnResponseModelRouting(responseModel.modelRouting);
  const summary = cloneTurnResponseRoundSummaryCarrier(responseModel.summary);
  const summaries = cloneTurnResponseRoundSummaryCarriers(responseModel.summaries);
  const summaryPreview = normalizeTurnResponseSummaryPreview(responseModel.summaryPreview);
  const requestUsage = responseModel.requestUsage
    && Number.isFinite(responseModel.requestUsage.promptTokens)
    && responseModel.requestUsage.promptTokens >= 0
    && Number.isFinite(responseModel.requestUsage.completionTokens)
    && responseModel.requestUsage.completionTokens >= 0
    ? {
      promptTokens: responseModel.requestUsage.promptTokens,
      completionTokens: responseModel.requestUsage.completionTokens,
      ...(typeof responseModel.requestUsage.outputBuffer === 'number' && Number.isFinite(responseModel.requestUsage.outputBuffer) && responseModel.requestUsage.outputBuffer > 0
        ? { outputBuffer: responseModel.requestUsage.outputBuffer }
        : {}),
      ...(Array.isArray(responseModel.requestUsage.promptTokenDetails) && responseModel.requestUsage.promptTokenDetails.length > 0
        ? {
          promptTokenDetails: responseModel.requestUsage.promptTokenDetails
            .map(detail => {
              const category = normalizeOptionalText(detail?.category);
              const label = normalizeOptionalText(detail?.label);
              const percentageOfPrompt = typeof detail?.percentageOfPrompt === 'number'
                && Number.isFinite(detail.percentageOfPrompt)
                && detail.percentageOfPrompt >= 0
                ? detail.percentageOfPrompt
                : undefined;

              if (!category || !label || percentageOfPrompt === undefined) {
                return undefined;
              }

              return {
                category,
                label,
                percentageOfPrompt,
              };
            })
            .filter((detail): detail is { category: string; label: string; percentageOfPrompt: number } => !!detail),
        }
        : {}),
    }
    : undefined;

  if (!responseModel.slashCommand && !responseModel.followups && !summary && !summaries && !summaryPreview && !modelName && !modelBillingLabel && !modelRouting && !requestUsage) {
    return undefined;
  }

  return {
    ...(responseModel.slashCommand ? { slashCommand: { ...responseModel.slashCommand } } : {}),
    ...(responseModel.followups ? { followups: responseModel.followups.map((followup: TurnResponseFollowup) => ({ ...followup })) } : {}),
    ...(summary ? { summary } : {}),
    ...(summaries ? { summaries } : {}),
    ...(summaryPreview ? { summaryPreview } : {}),
    ...(modelName ? { modelName } : {}),
    ...(modelBillingLabel ? { modelBillingLabel } : {}),
    ...(modelRouting ? { modelRouting } : {}),
    ...(requestUsage ? { requestUsage } : {}),
  };
}

function isExplicitAgentSummaryMarkdown(part: TurnResponseTurn['response']['parts'][number]): part is Extract<TurnResponseTurn['response']['parts'][number], { type: 'markdown' }> {
  if (part.type !== 'markdown') {
    return false;
  }

  return /^\[[^\]\s]+(?:\/[^\]\s]+)?\]\s+.+$/.test(part.content.trim());
}

function hasExplicitAgentInvocationRequest(turn: TurnResponseTurn | null | undefined): boolean {
  return Boolean(turn?.request.metadata?.explicitAgentInvocation);
}

export function deriveExplicitAgentSummaryPreview(
  turn: TurnResponseTurn | null | undefined,
): string | undefined {

  if (!turn || !hasExplicitAgentInvocationRequest(turn)) {
    return undefined;
  }

  for (let index = turn.response.parts.length - 1; index >= 0; index -= 1) {
    const part = turn.response.parts[index];
    if (!isExplicitAgentSummaryMarkdown(part)) {
      continue;
    }

    return part.content.trim();
  }

  return undefined;
}

export function withExplicitAgentSummaryPreview(
  turn: TurnResponseTurn,
): TurnResponseTurn {
  const summaryPreview = deriveExplicitAgentSummaryPreview(turn);
  const currentSummaryPreview = normalizeTurnResponseSummaryPreview(turn.responseModel?.summaryPreview);

  if (summaryPreview === currentSummaryPreview) {
    return turn;
  }

  const responseModel = {
    ...(turn.responseModel ?? {}),
    ...(summaryPreview ? { summaryPreview } : {}),
  };

  if (!responseModel.slashCommand && !responseModel.followups && !responseModel.summaryPreview && !responseModel.modelName && !responseModel.modelBillingLabel && !responseModel.modelRouting && !responseModel.requestUsage) {
    const { responseModel: _responseModel, ...turnWithoutResponseModel } = turn as TurnResponseTurn & { responseModel?: TurnResponseTurn['responseModel'] };
    return turnWithoutResponseModel;
  }

  return {
    ...turn,
    responseModel,
  };
}