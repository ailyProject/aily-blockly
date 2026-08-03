import {
  AfterViewInit,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  Input,
  OnChanges,
  OnDestroy,
} from '@angular/core';
import type { Attachment, TurnResponseTurn } from 'aily-lex/browser';

import { createElectronChatRuntimeHostTransport } from '../../core/electron-chat-runtime-host-transport';

interface UserImageAttachmentView {
  readonly key: string;
  readonly name: string;
  readonly src?: string;
  readonly unavailable: boolean;
  readonly omitted: boolean;
  readonly title: string;
}

type UserImageContentReference =
  NonNullable<TurnResponseTurn['response']['contentReferences']>[number];

@Component({
  selector: 'aily-chat-user-image-attachments',
  standalone: true,
  template: `
    <div
      class="request-image-attachments"
      aria-label="Attached images">
      @for (image of images; track image.key) {
        <div
          class="request-image-attachment"
          [class.unavailable]="image.unavailable"
          [class.omitted]="image.omitted"
          [title]="image.title"
        >
          @if (image.src) {
            <img [src]="image.src" alt="" />
          } @else {
            <i class="fa-light" [class.fa-image]="!image.unavailable" [class.fa-triangle-exclamation]="image.unavailable"></i>
          }
          <span>{{ image.name }}</span>
        </div>
      }
    </div>
  `,
  styles: [`
    :host {
      display: block;
      align-self: flex-end;
      max-width: 88%;
      min-width: 0;
      margin: 0 0 5px;
    }

    .request-image-attachments {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 5px;
      min-width: 0;
    }

    .request-image-attachment {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      max-width: 180px;
      height: 34px;
      padding: 3px 7px 3px 3px;
      border: 1px solid var(--aily-chat-xdialog-msg-divider, rgba(255, 255, 255, 0.12));
      border-radius: 5px;
      color: var(--aily-text-tertiary, #cccccc);
      background: var(--aily-chat-xdialog-bubble-bg, #292929);
      font-size: 11px;
      line-height: 16px;
      box-sizing: border-box;
    }

    .request-image-attachment img {
      width: 26px;
      height: 26px;
      flex: 0 0 26px;
      border-radius: 3px;
      object-fit: cover;
      background: rgba(255, 255, 255, 0.04);
    }

    .request-image-attachment i {
      width: 26px;
      flex: 0 0 26px;
      text-align: center;
      color: var(--aily-text-muted, #8e8e8e);
    }

    .request-image-attachment span {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .request-image-attachment.unavailable {
      color: var(--aily-chat-viewer-state-warn, #cca700);
      border-color: color-mix(in srgb, var(--aily-chat-viewer-state-warn, #cca700) 45%, transparent);
    }

    .request-image-attachment.omitted {
      opacity: 0.72;
      color: var(--aily-chat-viewer-state-warn, #cca700);
      border-color: color-mix(in srgb, var(--aily-chat-viewer-state-warn, #cca700) 45%, transparent);
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChatUserImageAttachmentsComponent implements OnChanges, AfterViewInit, OnDestroy {
  @Input() sessionId = '';
  @Input() attachments: readonly Attachment[] = [];
  @Input() omittedByModel = false;
  @Input() contentReferences: readonly UserImageContentReference[] = [];

  images: readonly UserImageAttachmentView[] = [];

  private runtimeHost = createElectronChatRuntimeHostTransport();
  private readonly resolvedSources = new Map<string, string>();
  private loadGeneration = 0;
  private destroyed = false;
  private viewInitialized = false;

  constructor(private readonly cdr: ChangeDetectorRef) {}

  ngOnChanges(): void {
    this.images = this.attachments
      .filter(attachment => attachment.type === 'image')
      .map(attachment => this.createInitialView(attachment));
    if (this.viewInitialized) {
      void this.refreshImages();
    }
  }

  ngAfterViewInit(): void {
    this.viewInitialized = true;
    void this.refreshImages();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.loadGeneration += 1;
  }

  private async refreshImages(): Promise<void> {
    const generation = ++this.loadGeneration;
    const attachments = this.attachments.filter(attachment => attachment.type === 'image');
    const initial = attachments.map(attachment => this.createInitialView(attachment));
    this.images = initial;
    this.cdr.markForCheck();

    const runtimeHost = this.runtimeHost ??= createElectronChatRuntimeHostTransport();
    if (!runtimeHost || !this.sessionId) {
      return;
    }

    const pending = attachments.map(async (attachment, index) => {
      if (initial[index]?.src || attachment.unavailable === true || !isManagedMediaRef(attachment.uri)) {
        return;
      }
      const key = attachmentKey(attachment);
      const cached = this.resolvedSources.get(key);
      if (cached) {
        this.replaceImageSource(generation, index, cached);
        return;
      }
      try {
        const media = await runtimeHost.readChatImageMedia({
          sessionId: this.sessionId,
          attachmentId: attachment.id,
          mediaRef: attachment.uri,
          mimeType: attachment.mimeType,
        });
        const src = `data:${media.mimeType};base64,${media.content}`;
        this.resolvedSources.set(key, src);
        this.replaceImageSource(generation, index, src);
      } catch {
        this.replaceImageSource(generation, index, undefined, true);
      }
    });
    await Promise.all(pending);
    if (!this.destroyed && generation === this.loadGeneration) {
      this.cdr.detectChanges();
    }
  }

  private createInitialView(attachment: Attachment): UserImageAttachmentView {
    const key = attachmentKey(attachment);
    const inlineSource = toInlineImageSource(attachment);
    const omittedReference = this.contentReferences.find(reference => (
      reference.options?.status?.kind === 'omitted'
      && matchesAttachmentReference(reference.reference, attachment)
    ));
    const omitted = this.omittedByModel || !!omittedReference;
    return {
      key,
      name: attachment.name || 'Image',
      ...(inlineSource ? { src: inlineSource } : {}),
      unavailable: attachment.unavailable === true,
      omitted,
      title: omitted
        ? `${attachment.name || 'Image'} - ${
            omittedReference?.options?.status?.description
              || 'Not included because the request model does not support images'
          }`
        : attachment.name || 'Image',
    };
  }

  private replaceImageSource(
    generation: number,
    index: number,
    src?: string,
    unavailable = false,
  ): void {
    if (this.destroyed || generation !== this.loadGeneration || !this.images[index]) {
      return;
    }
    const next = [...this.images];
    next[index] = {
      ...next[index],
      ...(src ? { src } : {}),
      unavailable,
    };
    this.images = next;
  }
}

function attachmentKey(attachment: Attachment): string {
  return [
    attachment.id ?? '',
    attachment.uri,
    attachment.mimeType ?? '',
    attachment.unavailable === true ? 'unavailable' : 'available',
  ].join('\u001f');
}

function matchesAttachmentReference(reference: string, attachment: Attachment): boolean {
  return reference === attachment.id
    || reference === attachment.name
    || reference === attachment.uri;
}

function isManagedMediaRef(uri: string): boolean {
  return /^aily-media:v1:[a-f0-9]{64}$/iu.test(uri.trim());
}

function toInlineImageSource(attachment: Attachment): string | undefined {
  const content = attachment.content?.trim();
  if (!content) {
    return undefined;
  }
  if (/^data:image\/(?:png|jpeg|gif|webp);base64,[a-z\d+/\s]+={0,2}$/iu.test(content)) {
    return content.replace(/\s/g, '');
  }
  const mimeType = attachment.mimeType?.trim().toLowerCase();
  if (!/^image\/(?:png|jpeg|gif|webp)$/u.test(mimeType ?? '')) {
    return undefined;
  }
  const base64 = content.replace(/\s/g, '');
  return /^[a-z\d+/]+={0,2}$/iu.test(base64)
    ? `data:${mimeType};base64,${base64}`
    : undefined;
}
