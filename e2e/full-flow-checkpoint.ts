import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_FULL_FLOW_CHECKPOINT_DIRECTORY = path.resolve(
  __dirname,
  '.artifacts',
  'full-flow-checkpoints',
);

export type FullFlowCheckpointCandidate = {
  key: string;
  label: string;
};

export type FullFlowCheckpointEntry = FullFlowCheckpointCandidate & {
  position: number;
};

export type FullFlowCheckpointFailure = {
  key: string;
  message: string;
};

export type FullFlowCheckpointLastFailure = FullFlowCheckpointEntry & {
  message: string;
};

export type FullFlowCheckpointState = {
  version: 1;
  mode: string;
  remaining: FullFlowCheckpointEntry[];
  total: number;
  lastFailure: FullFlowCheckpointLastFailure | null;
  updatedAt: string;
};

export type FullFlowCheckpointRun<T extends FullFlowCheckpointCandidate> = {
  resumed: boolean;
  total: number;
  lastFailure: FullFlowCheckpointLastFailure | null;
  remaining: Array<FullFlowCheckpointEntry & { candidate: T }>;
};

export type FullFlowCheckpointBatch = {
  succeededKeys: readonly string[];
  failures: readonly FullFlowCheckpointFailure[];
};

export class StaleFullFlowCheckpointError extends Error {
  readonly mode: string;
  readonly missingKeys: string[];

  constructor(mode: string, missingKeys: string[]) {
    super(
      `[e2e] stale full-flow checkpoint for mode "${mode}": ` +
        `saved candidates are missing from the current batch: ${missingKeys.join(', ')}`,
    );
    this.name = 'StaleFullFlowCheckpointError';
    this.mode = mode;
    this.missingKeys = missingKeys;
  }
}

export function shouldStopOnError(raw: string | undefined): boolean {
  return raw !== '0';
}

export class FullFlowCheckpoint {
  readonly mode: string;
  readonly filePath: string;

  private readonly backupPath: string;
  private readonly directory: string;

  constructor(mode: string, directory = DEFAULT_FULL_FLOW_CHECKPOINT_DIRECTORY) {
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(mode)) {
      throw new Error(`[e2e] invalid full-flow checkpoint mode: ${mode}`);
    }

    this.mode = mode;
    this.directory = directory;
    this.filePath = path.join(directory, `${mode}.json`);
    this.backupPath = `${this.filePath}.bak`;
  }

  async begin<T extends FullFlowCheckpointCandidate>(
    candidates: readonly T[],
  ): Promise<FullFlowCheckpointRun<T>> {
    const candidatesByKey = indexCandidates(candidates);
    const saved = await this.read();

    if (saved) {
      const missingKeys = saved.remaining
        .map((entry) => entry.key)
        .filter((key) => !candidatesByKey.has(key));
      if (missingKeys.length > 0) {
        throw new StaleFullFlowCheckpointError(this.mode, missingKeys);
      }

      return {
        resumed: true,
        total: saved.total,
        lastFailure: saved.lastFailure,
        remaining: saved.remaining.map((entry) => {
          const candidate = candidatesByKey.get(entry.key)!;
          return {
            ...entry,
            label: candidate.label,
            candidate,
          };
        }),
      };
    }

    const remaining = candidates.map((candidate, index) => ({
      key: candidate.key,
      label: candidate.label,
      position: index + 1,
    }));
    const initial: FullFlowCheckpointState = {
      version: 1,
      mode: this.mode,
      remaining,
      total: remaining.length,
      lastFailure: null,
      updatedAt: new Date().toISOString(),
    };

    if (remaining.length > 0) {
      await this.write(initial);
    } else {
      await this.clear();
    }

    return {
      resumed: false,
      total: initial.total,
      lastFailure: null,
      remaining: initial.remaining.map((entry) => ({
        ...entry,
        candidate: candidatesByKey.get(entry.key)!,
      })),
    };
  }

  async applyBatch(batch: FullFlowCheckpointBatch): Promise<FullFlowCheckpointState | null> {
    const saved = await this.read();
    if (!saved) {
      throw new Error(`[e2e] full-flow checkpoint was not initialized for mode "${this.mode}"`);
    }

    if (batch.succeededKeys.length === 0 && batch.failures.length === 0) {
      return saved;
    }

    const entriesByKey = new Map(saved.remaining.map((entry) => [entry.key, entry]));
    const succeededKeys = new Set(batch.succeededKeys);
    const failureKeys = new Set(batch.failures.map((failure) => failure.key));
    const unknownKeys = [...succeededKeys, ...failureKeys].filter((key) => !entriesByKey.has(key));
    if (unknownKeys.length > 0) {
      throw new Error(
        `[e2e] checkpoint update for mode "${this.mode}" contains unknown keys: ${[...new Set(unknownKeys)].join(', ')}`,
      );
    }

    const conflictingKeys = [...succeededKeys].filter((key) => failureKeys.has(key));
    if (conflictingKeys.length > 0) {
      throw new Error(
        `[e2e] checkpoint update for mode "${this.mode}" marks keys as both succeeded and failed: ${conflictingKeys.join(', ')}`,
      );
    }

    const remaining = saved.remaining.filter((entry) => !succeededKeys.has(entry.key));
    if (remaining.length === 0) {
      await this.clear();
      return null;
    }

    const failureMessages = new Map(batch.failures.map((failure) => [failure.key, failure.message]));
    const firstFailedEntry = saved.remaining.find((entry) => failureMessages.has(entry.key));
    let lastFailure = saved.lastFailure;
    if (firstFailedEntry) {
      lastFailure = {
        ...firstFailedEntry,
        message: failureMessages.get(firstFailedEntry.key)!,
      };
    } else if (lastFailure && succeededKeys.has(lastFailure.key)) {
      lastFailure = null;
    }
    const updated: FullFlowCheckpointState = {
      ...saved,
      remaining,
      lastFailure,
      updatedAt: new Date().toISOString(),
    };
    await this.write(updated);
    return updated;
  }

  async clear(): Promise<void> {
    await Promise.all([
      rm(this.filePath, { force: true }),
      rm(this.backupPath, { force: true }),
    ]);
  }

  private async read(): Promise<FullFlowCheckpointState | null> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') {
        throw error;
      }

      try {
        raw = await readFile(this.backupPath, 'utf8');
      } catch (backupError) {
        if (isNodeError(backupError) && backupError.code === 'ENOENT') {
          return null;
        }
        throw backupError;
      }

      await rename(this.backupPath, this.filePath);
    }

    return parseCheckpoint(raw, this.filePath, this.mode);
  }

  private async write(state: FullFlowCheckpointState): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;

    try {
      await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
      try {
        await rename(temporaryPath, this.filePath);
      } catch (error) {
        if (!isReplaceError(error)) {
          throw error;
        }

        await rm(this.backupPath, { force: true });
        await rename(this.filePath, this.backupPath);
        try {
          await rename(temporaryPath, this.filePath);
        } catch (commitError) {
          try {
            await rename(this.backupPath, this.filePath);
          } catch (restoreError) {
            throw new AggregateError(
              [commitError, restoreError],
              `[e2e] failed to replace checkpoint ${this.filePath}; previous state remains at ${this.backupPath}`,
            );
          }
          throw commitError;
        }
      }
      await rm(this.backupPath, { force: true }).catch(() => {});
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => {});
    }
  }
}

function indexCandidates<T extends FullFlowCheckpointCandidate>(candidates: readonly T[]): Map<string, T> {
  const result = new Map<string, T>();
  for (const candidate of candidates) {
    if (!candidate.key.trim()) {
      throw new Error('[e2e] full-flow checkpoint candidate key must not be empty');
    }
    if (result.has(candidate.key)) {
      throw new Error(`[e2e] duplicate full-flow checkpoint candidate key: ${candidate.key}`);
    }
    result.set(candidate.key, candidate);
  }
  return result;
}

function parseCheckpoint(raw: string, filePath: string, expectedMode: string): FullFlowCheckpointState {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`[e2e] invalid full-flow checkpoint JSON at ${filePath}: ${message}`);
  }

  if (!isRecord(value) || value['version'] !== 1 || value['mode'] !== expectedMode) {
    throw new Error(`[e2e] invalid full-flow checkpoint metadata at ${filePath}`);
  }

  const total = value['total'];
  const updatedAt = value['updatedAt'];
  const rawRemaining = value['remaining'];
  if (!Number.isInteger(total) || (total as number) < 0 || typeof updatedAt !== 'string' || !Array.isArray(rawRemaining)) {
    throw new Error(`[e2e] invalid full-flow checkpoint state at ${filePath}`);
  }

  const remaining = rawRemaining.map((entry) => parseEntry(entry, filePath));
  if (remaining.length === 0) {
    throw new Error(`[e2e] invalid empty full-flow checkpoint queue at ${filePath}`);
  }
  const keys = new Set<string>();
  for (const entry of remaining) {
    if (keys.has(entry.key) || entry.position > (total as number)) {
      throw new Error(`[e2e] invalid full-flow checkpoint queue at ${filePath}`);
    }
    keys.add(entry.key);
  }

  const rawLastFailure = value['lastFailure'];
  let lastFailure: FullFlowCheckpointLastFailure | null = null;
  if (rawLastFailure !== null) {
    const entry = parseEntry(rawLastFailure, filePath);
    if (!isRecord(rawLastFailure) || typeof rawLastFailure['message'] !== 'string') {
      throw new Error(`[e2e] invalid full-flow checkpoint failure at ${filePath}`);
    }
    lastFailure = { ...entry, message: rawLastFailure['message'] };
  }

  return {
    version: 1,
    mode: expectedMode,
    remaining,
    total: total as number,
    lastFailure,
    updatedAt,
  };
}

function parseEntry(value: unknown, filePath: string): FullFlowCheckpointEntry {
  if (
    !isRecord(value) ||
    typeof value['key'] !== 'string' ||
    !value['key'].trim() ||
    typeof value['label'] !== 'string' ||
    !Number.isInteger(value['position']) ||
    (value['position'] as number) <= 0
  ) {
    throw new Error(`[e2e] invalid full-flow checkpoint entry at ${filePath}`);
  }

  return {
    key: value['key'],
    label: value['label'],
    position: value['position'] as number,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function isReplaceError(error: unknown): boolean {
  return (
    isNodeError(error) &&
    (error.code === 'EEXIST' || error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'ENOTEMPTY')
  );
}
