import { computeTextDiffSync } from './editing-text-diff.core';
import type {
  EditingTextDiffOptions,
  EditingTextDiffResult,
  EditingTextDiffWorkerRequest,
  EditingTextDiffWorkerResponse,
} from './editing-text-diff.types';

export interface EditingTextDiffServiceOptions {
  preferWorker?: boolean;
  workerFactory?: () => Worker;
}

interface PendingDiffRequest {
  original: string;
  modified: string;
  options: EditingTextDiffOptions;
  resolve: (result: EditingTextDiffResult) => void;
  reject: (error: unknown) => void;
}

export class EditingTextDiffService {
  private worker: Worker | null = null;
  private workerFailed = false;
  private requestId = 0;
  private readonly pendingRequests = new Map<number, PendingDiffRequest>();

  constructor(private readonly options: EditingTextDiffServiceOptions = {}) {}

  async computeDiff(
    original: string,
    modified: string,
    options: EditingTextDiffOptions,
  ): Promise<EditingTextDiffResult> {
    const worker = this.ensureWorker();
    if (!worker) {
      return computeTextDiffSync(original, modified, options);
    }

    return new Promise((resolve, reject) => {
      const id = ++this.requestId;
      this.pendingRequests.set(id, { original, modified, options, resolve, reject });
      try {
        const request: EditingTextDiffWorkerRequest = {
          id,
          type: 'computeDiff',
          payload: { original, modified, options },
        };
        worker.postMessage(request);
      } catch {
        this.pendingRequests.delete(id);
        resolve(computeTextDiffSync(original, modified, options));
      }
    });
  }

  computeDiffSync(
    original: string,
    modified: string,
    options: EditingTextDiffOptions,
  ): EditingTextDiffResult {
    return computeTextDiffSync(original, modified, options);
  }

  dispose(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.pendingRequests.clear();
  }

  private ensureWorker(): Worker | null {
    const preferWorker = this.options.preferWorker ?? true;
    if (!preferWorker || this.workerFailed || typeof Worker === 'undefined') {
      return null;
    }
    if (this.worker) {
      return this.worker;
    }

    try {
      const worker = this.options.workerFactory
        ? this.options.workerFactory()
        : new Worker(new URL('../workers/editing-diff.worker.ts', import.meta.url), { type: 'module' });
      worker.addEventListener('message', (event: MessageEvent<EditingTextDiffWorkerResponse>) => {
        const { id, result, error } = event.data;
        const pending = this.pendingRequests.get(id);
        if (!pending) {
          return;
        }
        this.pendingRequests.delete(id);
        if (error) {
          pending.resolve(computeTextDiffSync(pending.original, pending.modified, pending.options));
          return;
        }
        if (!result) {
          pending.reject(new Error('Diff worker returned no result'));
          return;
        }
        pending.resolve(result);
      });
      worker.addEventListener('error', () => {
        this.handleWorkerFailure();
      });
      this.worker = worker;
      return worker;
    } catch {
      this.workerFailed = true;
      return null;
    }
  }

  private handleWorkerFailure(): void {
    this.workerFailed = true;
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }

    const pendingRequests = [...this.pendingRequests.values()];
    this.pendingRequests.clear();
    for (const pending of pendingRequests) {
      try {
        pending.resolve(computeTextDiffSync(pending.original, pending.modified, pending.options));
      } catch (error) {
        pending.reject(error);
      }
    }
  }
}