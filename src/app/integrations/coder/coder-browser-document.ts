import { captureCoderBrowserEmbedConfiguration, type CoderBrowserEmbedConfiguration } from './coder-browser-embed.providers';
import type { BrowserProjectDocumentService } from '../project/browser-project-document.service';
import type { BrowserProjectDocumentClient } from '../project/browser-project-document-host';
import type { SimulatorCapturedProjectActivation, SimulatorProjectActivationPort } from '../simulator/simulator-web-project-activation';

/** Structural view of the original independently delivered bridge. Artifact
 * DTOs are still admitted by the Simulator's original validators. */
export interface CoderBrowserDocumentClient extends BrowserProjectDocumentClient<SimulatorProjectActivationPort> {
  capture(signal?: AbortSignal): Promise<SimulatorCapturedProjectActivation | null>;
  readSceneHead(signal?: AbortSignal): Promise<Uint8Array>;
  openArtifact(signal?: AbortSignal): Promise<{
    readonly metadata: unknown;
    readRange(path: string, offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array>;
    close(): Promise<void>;
  }>;
}

export interface OpenCoderBrowserDocumentOptions {
  readonly documents: Pick<BrowserProjectDocumentService, 'openDocument'>;
  readonly configuration: CoderBrowserEmbedConfiguration;
  readonly window?: Window;
}

/** Shared production connection. Both the desktop Frame's Browser branch and
 * the small Web entry borrow the same application-owned document. */
export function openCoderBrowserDocument(options: OpenCoderBrowserDocumentOptions) {
  const hostWindow = options.window ?? window;
  const deployment = captureCoderBrowserEmbedConfiguration(options.configuration, hostWindow.location.origin);
  const host = options.documents.openDocument(deployment.editorURL, async (childWindow, signal) => {
    const module = await import(/* @vite-ignore */ deployment.bridgeModuleURL) as {
      createBrowserProjectPortClient(options: { window: Window; childWindow: Window; expectedChildOrigin: string }): CoderBrowserDocumentClient;
    };
    signal.throwIfAborted();
    if (typeof module.createBrowserProjectPortClient !== 'function') {
      throw new TypeError('Browser project bridge module is unavailable.');
    }
    const client = module.createBrowserProjectPortClient({ window: hostWindow, childWindow,
      expectedChildOrigin: new URL(deployment.editorURL).origin });
    // The application host adopts this exact client before awaiting readiness.
    return client;
  });
  host.frame.title = 'Aily Coder';
  return Object.freeze({ deployment, host });
}

/** No reconnection or registry is introduced for a late joining caller. */
export function captureCurrentCoderBrowserDocumentClient(
  documents: Pick<BrowserProjectDocumentService, 'captureCurrentClient'>,
): CoderBrowserDocumentClient | null {
  const client = documents.captureCurrentClient();
  if (!client) return null;
  const candidate = client as Partial<CoderBrowserDocumentClient>;
  if (typeof candidate.capture !== 'function' || typeof candidate.readSceneHead !== 'function'
    || typeof candidate.openArtifact !== 'function') throw new TypeError('The original document is not a Coder Browser project source.');
  return candidate as CoderBrowserDocumentClient;
}
