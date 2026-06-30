import type { TurnResponseTurn } from 'aily-lex/browser';

export interface SessionTurnOwnerDiagnostics {
  readonly sessionId: string;
  readonly turnCount: number;
  readonly firstTurnId: string | null;
  readonly firstTurnOwner: string | null;
  readonly firstRequestPreview: string;
  readonly ownerSamples: readonly string[];
  readonly mismatchedTurnIds: readonly string[];
  readonly mismatchedOwners: readonly string[];
  readonly mismatchCount: number;
}

export function inferSessionOwnerFromTurnId(turnId: unknown): string | null {
  const normalizedTurnId = typeof turnId === 'string' ? turnId.trim() : '';
  if (!normalizedTurnId) {
    return null;
  }

  const separatorIndex = normalizedTurnId.indexOf('-turn-');
  return separatorIndex > 0
    ? normalizedTurnId.slice(0, separatorIndex)
    : null;
}

export function buildSessionTurnOwnerDiagnostics(
  sessionId: string | null | undefined,
  turnResponses: readonly TurnResponseTurn[] | null | undefined,
): SessionTurnOwnerDiagnostics {
  const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
  const turns = Array.isArray(turnResponses) ? turnResponses : [];
  const firstTurn = turns[0] ?? null;
  const ownerSamples: string[] = [];
  const mismatchedTurnIds: string[] = [];
  const mismatchedOwners: string[] = [];
  const seenOwners = new Set<string>();

  for (const turn of turns) {
    const turnId = typeof turn?.turnId === 'string' ? turn.turnId : '';
    const owner = inferSessionOwnerFromTurnId(turnId);
    if (!owner) {
      continue;
    }

    if (!seenOwners.has(owner)) {
      seenOwners.add(owner);
      ownerSamples.push(owner);
    }

    if (normalizedSessionId && owner !== normalizedSessionId) {
      mismatchedTurnIds.push(turnId);
      if (!mismatchedOwners.includes(owner)) {
        mismatchedOwners.push(owner);
      }
    }
  }

  return {
    sessionId: normalizedSessionId,
    turnCount: turns.length,
    firstTurnId: typeof firstTurn?.turnId === 'string' ? firstTurn.turnId : null,
    firstTurnOwner: inferSessionOwnerFromTurnId(firstTurn?.turnId),
    firstRequestPreview: previewTurnRequest(firstTurn),
    ownerSamples,
    mismatchedTurnIds,
    mismatchedOwners,
    mismatchCount: mismatchedTurnIds.length,
  };
}

export function formatSessionTurnOwnerDiagnosticsFields(
  prefix: string,
  diagnostics: SessionTurnOwnerDiagnostics,
): readonly string[] {
  return [
    `${prefix}Turns=${diagnostics.turnCount}`,
    `${prefix}FirstTurn=${diagnostics.firstTurnId ?? '<none>'}`,
    `${prefix}FirstOwner=${diagnostics.firstTurnOwner ?? '<none>'}`,
    `${prefix}OwnerSamples=${diagnostics.ownerSamples.length ? diagnostics.ownerSamples.join(',') : '<none>'}`,
    `${prefix}OwnerMismatch=${diagnostics.mismatchCount}`,
    `${prefix}FirstRequest=${JSON.stringify(diagnostics.firstRequestPreview)}`,
  ];
}

export function hasBlockingSessionTurnOwnerMismatch(
  diagnostics: SessionTurnOwnerDiagnostics,
  options?: { readonly allowForkedTurns?: boolean },
): boolean {
  return diagnostics.mismatchCount > 0 && options?.allowForkedTurns !== true;
}

function previewTurnRequest(turn: TurnResponseTurn | null | undefined): string {
  const request = turn?.request as { displayContent?: unknown; content?: unknown } | undefined;
  const content = typeof request?.displayContent === 'string' && request.displayContent.trim().length > 0
    ? request.displayContent
    : typeof request?.content === 'string'
      ? request.content
      : '';
  const normalized = content.replace(/\s+/g, ' ').trim();
  return normalized.length > 96
    ? `${normalized.slice(0, 96)}...`
    : normalized;
}
