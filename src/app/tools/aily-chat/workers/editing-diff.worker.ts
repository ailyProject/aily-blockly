/// <reference lib="webworker" />

import { computeTextDiffSync } from '../services/editing-text-diff.core';
import type {
  EditingTextDiffWorkerRequest,
  EditingTextDiffWorkerResponse,
} from '../services/editing-text-diff.types';

addEventListener('message', (event: MessageEvent<EditingTextDiffWorkerRequest>) => {
  const { id, type, payload } = event.data;
  const respond = (response: EditingTextDiffWorkerResponse) => {
    postMessage(response);
  };

  try {
    if (type !== 'computeDiff') {
      respond({ id, type: 'computeDiff', error: `Unsupported worker message: ${type}` });
      return;
    }

    const result = computeTextDiffSync(payload.original, payload.modified, payload.options);
    respond({ id, type: 'computeDiff', result });
  } catch (error) {
    respond({
      id,
      type: 'computeDiff',
      error: error instanceof Error ? error.message : String(error),
    });
  }
});