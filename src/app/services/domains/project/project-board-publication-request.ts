import { readProjectSaveInput, readProjectSaveRequest, type ProjectSaveInput, type ProjectSaveRequest } from './project-save-receipts';

/** Bind a trusted board caller's actual intent to the existing native save ID.
 * Neither a caller-supplied digest nor a later board/catalog state is authority. */
export function boardPublicationRequest(input: ProjectSaveInput, value?: unknown): ProjectSaveRequest {
  const expected = readProjectSaveInput(input)!;
  if (value === undefined) return { version: 2, requestId: `pub2-${crypto.randomUUID()}`, operation: 'project_save', input: expected };
  const request = readProjectSaveRequest(value);
  if (request.version !== 2 || request.operation !== 'project_save'
    || JSON.stringify(request.input) !== JSON.stringify(expected)) {
    throw Object.assign(new Error('The original publication request does not match this board operation.'), { code: 'PROJECT_SAVE_RECEIPT_INVALID' });
  }
  return request;
}
