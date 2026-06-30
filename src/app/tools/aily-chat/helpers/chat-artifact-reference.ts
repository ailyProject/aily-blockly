import type { IAilyHostAPI } from '../core/host-api';

import { resolveBlocklyMemoryPublicPath } from './chat-memory-host';

export interface BlocklyArtifactReferenceOptions {
  readonly cwd?: string;
  readonly sessionId?: string;
}

export interface BlocklyArtifactReferenceTarget {
  readonly absolutePath: string;
  readonly displayPath: string;
}

export function resolveBlocklyArtifactReferenceTarget(
  host: Pick<IAilyHostAPI, 'path' | 'project'>,
  reference: string,
  options: BlocklyArtifactReferenceOptions = {},
): BlocklyArtifactReferenceTarget | undefined {
  if (!host?.path?.join || !host.path.isAbsolute) {
    return undefined;
  }

  const normalizedReference = normalizeReference(reference);
  if (!normalizedReference) {
    return undefined;
  }

  const memoryPath = resolveBlocklyMemoryPublicPath(host, options.cwd, options.sessionId, normalizedReference);
  if (memoryPath) {
    return toReferenceTarget(host, memoryPath);
  }

  const decodedFilePath = decodeFileUri(normalizedReference);
  if (decodedFilePath) {
    return toReferenceTarget(host, decodedFilePath);
  }

  const workspacePath = resolveWorkspaceReference(host, normalizedReference, options.cwd);
  if (workspacePath) {
    return toReferenceTarget(host, workspacePath);
  }

  if (host.path.isAbsolute(normalizedReference)) {
    return toReferenceTarget(host, normalizedReference);
  }

  return undefined;
}

export function getBlocklyArtifactReferenceLabel(
  host: Pick<IAilyHostAPI, 'path' | 'project'>,
  reference: string,
  options: BlocklyArtifactReferenceOptions = {},
): string {
  return resolveBlocklyArtifactReferenceTarget(host, reference, options)?.displayPath
    ?? normalizeReference(reference)
    ?? reference;
}

function resolveWorkspaceReference(
  host: Pick<IAilyHostAPI, 'path' | 'project'>,
  reference: string,
  cwd?: string,
): string | undefined {
  if (reference !== '/workspace' && !reference.startsWith('/workspace/')) {
    return undefined;
  }

  const workspaceRoot = cwd || host.project?.currentProjectPath || host.project?.projectRootPath || '';
  if (!workspaceRoot) {
    return undefined;
  }

  if (reference === '/workspace') {
    return workspaceRoot;
  }

  const relativePath = reference.slice('/workspace/'.length);
  return relativePath ? host.path.join(workspaceRoot, relativePath) : workspaceRoot;
}

function decodeFileUri(reference: string): string | undefined {
  if (!/^file:\/\//i.test(reference)) {
    return undefined;
  }

  try {
    const withoutScheme = decodeURIComponent(reference.replace(/^file:\/\//i, ''));
    if (!withoutScheme) {
      return undefined;
    }

    return withoutScheme.match(/^\/[A-Za-z]:\//)
      ? withoutScheme.slice(1)
      : withoutScheme;
  } catch {
    return undefined;
  }
}

function toReferenceTarget(
  host: Pick<IAilyHostAPI, 'path'>,
  absolutePath: string,
): BlocklyArtifactReferenceTarget {
  const normalized = host.path.normalize?.(absolutePath) ?? absolutePath;
  return {
    absolutePath: normalized,
    displayPath: normalized.replace(/\\/g, '/'),
  };
}

function normalizeReference(reference: string): string | undefined {
  const normalized = typeof reference === 'string' ? reference.trim() : '';
  return normalized.length > 0 ? normalized : undefined;
}