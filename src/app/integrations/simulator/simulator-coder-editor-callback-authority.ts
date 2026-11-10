import { listArtifactDebugSourceSnapshots, type SimulationArtifact } from '@aily-project/simulator-protocol/artifact';
import type { SimulatorEditorHostProviderAdapterOptions } from '@aily-project/simulator-host-sdk';
import type {
  SimulatorSubappDebugLocationHintEvent,
  SimulatorSubappHostEditorSourceLocationRevealV1,
} from '@aily-project/simulator-protocol/host';

type Stop = SimulatorSubappDebugLocationHintEvent;

interface CoderSourceLocationOptions {
  readArtifact(artifactRevision: string): Promise<SimulationArtifact>;
  editorPath(artifactPath: string): string;
  show(path: string, line: number, sha256: string, focus: boolean): Promise<boolean>;
  clear(): void;
}

/** The Subapp supplies a hint. The current project and Artifact authorize the source. */
export class SimulatorCoderEditorCallbackAuthority {
  readonly callbacks: SimulatorEditorHostProviderAdapterOptions;
  private readonly sequences = new Map<string, number>();
  private candidate: Stop | null = null;
  private stop: Stop | null = null;
  private closed = false;

  constructor(private readonly options: CoderSourceLocationOptions) {
    this.callbacks = {
      publishDebugLocation: event => this.publish(event),
      revealSourceLocation: request => this.reveal(request),
    };
  }

  close(): void {
    this.closed = true;
    this.sequences.clear();
    this.candidate = null;
    this.clear();
  }

  private clear(): void {
    if (!this.stop) return;
    this.stop = null;
    this.options.clear();
  }

  private async publish(event: Stop): Promise<'applied' | 'ignored'> {
    if (this.closed || event.sceneId !== 'main') return 'ignored';
    const previous = this.sequences.get(event.launchId);
    if (previous !== undefined ? event.sequence <= previous : this.sequences.size >= 32) return 'ignored';
    this.sequences.set(event.launchId, event.sequence);
    if (this.candidate?.launchId === event.launchId) this.candidate = null;
    if (this.stop?.launchId === event.launchId) this.clear();
    if (event.status === 'clear') {
      return 'applied';
    }
    if (!event.artifactRevision || !event.sourceRevision || !event.location) return 'ignored';
    this.candidate = event;
    try {
      const source = await this.resolve(event);
      if (this.candidate !== event || !source) return 'ignored';
      this.clear();
      this.stop = event;
      return await this.options.show(source.path, source.line, source.sha256, false) && this.stop === event
        ? 'applied' : 'ignored';
    } catch {
      if (this.stop === event) this.clear();
      return 'ignored';
    } finally {
      if (this.candidate === event) this.candidate = null;
    }
  }

  private async reveal(request: SimulatorSubappHostEditorSourceLocationRevealV1): Promise<'revealed' | 'ignored'> {
    const stop = this.stop;
    if (!stop || stop.launchId !== request.launchId || stop.sessionId !== request.sessionId
      || stop.sceneId !== request.sceneId || stop.sceneRevision !== request.sceneRevision
      || stop.artifactRevision !== request.artifactRevision || stop.sourceRevision !== request.sourceRevision
      || stop.location?.file !== request.location.file || stop.location.line !== request.location.line) {
      return 'ignored';
    }
    try {
      const source = await this.resolve(stop);
      if (this.stop !== stop || !source) return 'ignored';
      return await this.options.show(source.path, source.line, source.sha256, request.focus) && this.stop === stop
        ? 'revealed' : 'ignored';
    } catch {
      if (this.stop === stop) this.clear();
      return 'ignored';
    }
  }

  private async resolve(stop: Stop) {
    const { artifactRevision, sourceRevision, location } = stop;
    if (!artifactRevision || !sourceRevision || !location) return null;
    const artifact = await this.options.readArtifact(artifactRevision);
    const snapshot = listArtifactDebugSourceSnapshots(artifact).find(source => source.sourcePath === location.file);
    if (!snapshot || !artifact.files.some(file => file.role === 'debug-source'
      && file.path === snapshot.snapshotPath && file.sha256 === sourceRevision)) return null;
    return { path: this.options.editorPath(snapshot.sourcePath), line: location.line, sha256: sourceRevision };
  }
}
