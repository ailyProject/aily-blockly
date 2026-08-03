import type { Attachment } from 'aily-lex/browser';

export type ChatImageOrigin = 'file' | 'clipboard' | 'tool';
export type ChatImageDetail = 'auto' | 'low' | 'high';
export type ChatImageMimeType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

export const CHAT_IMAGE_MULTIMODAL_CONTRACT_VERSION = 'aily.chat.image-wire.v1';

export type ChatImageAttachmentCapabilityStatus = 'supported' | 'unsupported' | 'unknown';

export interface ChatImageAttachmentCapabilitySource {
  readonly inputModalities?: readonly string[] | null;
  readonly maxInputImages?: number | null;
  readonly isCustom?: boolean;
}

export interface ChatImageAttachmentCapabilities {
  readonly status: ChatImageAttachmentCapabilityStatus;
  readonly canAcquireImages: boolean;
  readonly maxInputImages?: number;
}

/**
 * Mirrors VS Code's attachment-capability plus selected-model vision gate.
 * Unknown capability remains explicit, but cannot enable acquisition: VS Code
 * exposes image actions only when the selected model declares vision support.
 * Existing drafts are preserved separately and may be projected as omitted.
 */
export function resolveChatImageAttachmentCapabilities(
  source: ChatImageAttachmentCapabilitySource | null | undefined,
): ChatImageAttachmentCapabilities {
  const inputModalities = Array.isArray(source?.inputModalities)
    ? source.inputModalities
      .map(value => typeof value === 'string' ? value.trim().toLowerCase() : '')
      .filter(Boolean)
    : undefined;
  const maxInputImages = typeof source?.maxInputImages === 'number'
    && Number.isFinite(source.maxInputImages)
    ? Math.max(0, Math.floor(source.maxInputImages))
    : undefined;

  if (inputModalities) {
    const supported = inputModalities.includes('image') && maxInputImages !== 0;
    return {
      status: supported ? 'supported' : 'unsupported',
      canAcquireImages: supported,
      ...(supported && maxInputImages !== undefined ? { maxInputImages } : {}),
    };
  }

  if (source?.isCustom === true) {
    return {
      status: 'unsupported',
      canAcquireImages: false,
    };
  }

  return {
    status: 'unknown',
    canAcquireImages: false,
    ...(maxInputImages !== undefined ? { maxInputImages } : {}),
  };
}

export interface ChatImageAttachmentDraft {
  readonly id: string;
  readonly type: 'image';
  readonly name: string;
  readonly origin: ChatImageOrigin;
  readonly source:
    | { readonly kind: 'local-file'; readonly uri: string }
    | { readonly kind: 'inline-base64'; readonly data: string }
    | { readonly kind: 'managed-ref'; readonly mediaRef: string };
  readonly mimeType?: ChatImageMimeType;
  readonly detail?: ChatImageDetail;
  readonly width?: number;
  readonly height?: number;
  readonly byteLength?: number;
  readonly sha256?: string;
}

const IMAGE_EXTENSION_MIME_TYPES: Readonly<Record<string, ChatImageMimeType>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

export function getSupportedImageMimeTypeFromPath(filePath: string | null | undefined): ChatImageMimeType | undefined {
  const normalized = typeof filePath === 'string' ? filePath.trim().toLowerCase() : '';
  const extension = Object.keys(IMAGE_EXTENSION_MIME_TYPES).find(candidate => normalized.endsWith(candidate));
  return extension ? IMAGE_EXTENSION_MIME_TYPES[extension] : undefined;
}

export function cloneChatImageAttachmentDraft(
  draft: ChatImageAttachmentDraft,
): ChatImageAttachmentDraft {
  return {
    ...draft,
    source: { ...draft.source },
  };
}

export function buildTurnRequestImageAttachment(
  draft: ChatImageAttachmentDraft,
): {
  readonly id: string;
  readonly type: 'image';
  readonly name: string;
  readonly uri: string;
  readonly mimeType?: ChatImageMimeType;
  readonly content?: string;
  readonly detail?: ChatImageDetail;
} {
  const source = draft.source;
  const uri = source.kind === 'local-file'
    ? source.uri
    : source.kind === 'managed-ref'
      ? source.mediaRef
      : `aily-chat-image:${draft.id}`;

  return {
    id: draft.id,
    type: 'image',
    name: draft.name,
    uri,
    ...(draft.mimeType ? { mimeType: draft.mimeType } : {}),
    ...(source.kind === 'inline-base64' ? { content: source.data } : {}),
    ...(draft.detail ? { detail: draft.detail } : {}),
  };
}

export function restoreTurnRequestImageAttachmentDrafts(
  attachments: readonly Attachment[] | null | undefined,
): ChatImageAttachmentDraft[] {
  const restored: ChatImageAttachmentDraft[] = [];
  for (const attachment of attachments ?? []) {
    if (attachment.type !== 'image' || attachment.unavailable === true) {
      continue;
    }
    const source = restoreImageSource(attachment);
    if (!source) {
      continue;
    }
    const mimeType = normalizeSupportedImageMimeType(attachment.mimeType);
    restored.push({
      id: attachment.id?.trim() || `restored-image:${attachment.uri.trim()}`,
      type: 'image',
      name: attachment.name || 'Image',
      origin: 'file',
      source,
      ...(mimeType ? { mimeType } : {}),
      ...(attachment.detail ? { detail: attachment.detail } : {}),
    });
  }
  return restored;
}

function restoreImageSource(
  attachment: Attachment,
): ChatImageAttachmentDraft['source'] | null {
  const uri = attachment.uri?.trim();
  if (/^aily-media:v1:[a-f0-9]{64}$/iu.test(uri)) {
    return { kind: 'managed-ref', mediaRef: uri };
  }
  const content = attachment.content?.trim();
  if (content) {
    return {
      kind: 'inline-base64',
      data: content.replace(/^data:[^;,]+;base64,/iu, '').replace(/\s/g, ''),
    };
  }
  return null;
}

function normalizeSupportedImageMimeType(
  mimeType: string | null | undefined,
): ChatImageMimeType | undefined {
  const normalized = mimeType?.trim().toLowerCase() === 'image/jpg'
    ? 'image/jpeg'
    : mimeType?.trim().toLowerCase();
  return normalized === 'image/png'
    || normalized === 'image/jpeg'
    || normalized === 'image/gif'
    || normalized === 'image/webp'
    ? normalized
    : undefined;
}
