import { DestroyRef, Injectable, inject } from '@angular/core';
import { BrowserProjectInputService } from './browser-project-input.service';
import { createBrowserProjectDocumentHost, type BrowserProjectDocumentClient } from './browser-project-document-host';
import type { SimulatorProjectActivationPort } from '../simulator/simulator-web-project-activation';

type ProjectDocumentHost = ReturnType<typeof createBrowserProjectDocumentHost<SimulatorProjectActivationPort>>;

/** Application-owned original document. Editors borrow a presentation, never
 * the project lifetime. No project/file registry or authorization is created. */
@Injectable({ providedIn: 'root' })
export class BrowserProjectDocumentService {
  private readonly closeWaitMs = 3000;
  private readonly input = inject(BrowserProjectInputService);
  private current: { url: string; owner: AbortController; host: ProjectDocumentHost;
    connection: { client: BrowserProjectDocumentClient<SimulatorProjectActivationPort> | null } } | null = null;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      void this.closeDocument().catch(error => console.error('Browser project document cleanup remains unconfirmed', error));
    });
  }

  openDocument(url: string, connect: (child: Window, signal: AbortSignal) =>
    BrowserProjectDocumentClient<SimulatorProjectActivationPort> | Promise<BrowserProjectDocumentClient<SimulatorProjectActivationPort>>): ProjectDocumentHost {
    if (this.current) {
      if (this.current.url !== url || this.current.host.snapshot().closeRequested) {
        throw new Error('Close the original Browser project document before opening a replacement.');
      }
      return this.current.host;
    }
    const owner = new AbortController();
    const connection: { client: BrowserProjectDocumentClient<SimulatorProjectActivationPort> | null } = { client: null };
    const host = createBrowserProjectDocumentHost({ window, document, url, owner: owner.signal,
      connect: async (child, signal) => {
        const client = await connect(child, signal);
        // Borrow only this original connection. The host retains its existing
        // late-adoption/close responsibility, including an ended owner.
        connection.client = client;
        return client;
      },
      bind: (port, signal) => this.input.bind(port, signal),
      onError: error => console.error('Browser project document owner ended or cleanup remains unconfirmed', error),
    });
    this.current = { url, owner, host, connection };
    return host;
  }

  /** Same-document trusted composition may borrow the original capability.
   * It must await ready; ending the owner immediately stops further borrowing. */
  captureCurrentClient(): BrowserProjectDocumentClient<SimulatorProjectActivationPort> | null {
    const current = this.current;
    return !current || current.owner.signal.aborted || current.host.snapshot().closeRequested
      ? null : current.connection.client;
  }

  async closeDocument(): Promise<void> {
    const original = this.current;
    if (!original) return;
    original.owner.abort(new DOMException('The application closed the original Browser project document.', 'AbortError'));
    // Both the root service and existing cleanup holder keep the exact host on
    // failure. A removed frame does not settle its original business close.
    const originalClose = this.input.retainCleanup(original.host);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Bound only the caller's wait. The original close and exact owner stay
      // retained after timeout; no synthetic ACK, cancellation or replacement.
      await Promise.race([originalClose, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Original Browser project cleanup remains unconfirmed after the caller close budget.')), this.closeWaitMs);
      })]);
    } finally { clearTimeout(timer); }
    if (this.current === original) this.current = null;
  }

  snapshot() {
    return { document: this.current?.host.snapshot() ?? null, cleanup: this.input.snapshot(), closeWaitMs: this.closeWaitMs };
  }
}
