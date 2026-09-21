import { canonicalJsonStringify } from '@domain/project/project-data/public-api';

/** Shared by host transactions and the independent native realm; no project services. */
export function absJson(value: unknown): string { return canonicalJsonStringify(value); }
