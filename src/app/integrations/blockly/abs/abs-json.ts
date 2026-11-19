import { canonicalProjectJsonStringify } from '@domain/project/project-document-json';

/** Shared by host transactions and the independent native realm; no project services. */
export function absJson(value: unknown): string { return canonicalProjectJsonStringify(value); }
