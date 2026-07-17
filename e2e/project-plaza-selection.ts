import { createHash } from 'node:crypto';

type ProjectPlazaSelectionCandidate = {
  key: string;
};

export function readProjectPlazaSampleRate(raw: string | undefined): number {
  if (!raw) {
    return 1;
  }

  const rate = Number(raw);
  if (!Number.isFinite(rate) || rate <= 0 || rate > 1) {
    throw new Error(
      `[e2e] AILY_E2E_PROJECT_PLAZA_SAMPLE_RATE 必须大于 0 且不超过 1，当前值：${raw}`,
    );
  }
  return rate;
}

export function selectProjectPlazaSample<T extends ProjectPlazaSelectionCandidate>(
  candidates: readonly T[],
  rate: number,
  seed: string | undefined,
): T[] {
  if (rate === 1 || candidates.length === 0) {
    return [...candidates];
  }

  const normalizedSeed = String(seed || '').trim();
  if (!normalizedSeed) {
    throw new Error(
      '[e2e] 项目广场抽样时必须设置 AILY_E2E_PROJECT_PLAZA_SAMPLE_SEED，以便断点续跑复用同一批项目。',
    );
  }

  const sampleSize = Math.max(1, Math.ceil(candidates.length * rate));
  return candidates
    .map((candidate, index) => ({
      candidate,
      index,
      score: createHash('sha256')
        .update(`${normalizedSeed}\0${candidate.key}`)
        .digest('hex'),
    }))
    .sort((left, right) => left.score.localeCompare(right.score) || left.index - right.index)
    .slice(0, sampleSize)
    .sort((left, right) => left.index - right.index)
    .map(({ candidate }) => candidate);
}

export function readProjectPlazaSkipProjectIds(raw: string | undefined): Set<string> {
  return new Set(
    String(raw || '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
  );
}
