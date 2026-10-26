import { SimulatorHostProviderOperationError } from '@aily-project/simulator-host-sdk';
import { validateSceneDemonstrationScript } from '@aily-project/simulator-protocol/scene';
import { verifySceneEditorDocumentV2Revisions } from '@aily-project/scene-model';

import type { SimulatorHostBoardDemonstrationRead, SimulatorHostBoardDemonstrationWrite,
  SimulatorHostBoardDemonstrationSnapshot, SimulatorSubappHostArtifactChunkRequestV1 } from '@aily-project/simulator-protocol/host';
import { SimulatorProjectArtifactCallbackAuthority, type SimulatorProjectArtifactFilePort } from './simulator-project-artifact-callback-authority';

type BoardPackage = { path: string; name: string; version: string };

/** Fixed board-package files only; native paths never leave the Host callbacks. */
export class SimulatorBoardDemonstrationProvider {
  private artifacts: SimulatorProjectArtifactCallbackAuthority | null = null;
  private board: BoardPackage | null = null;

  constructor(private readonly options: {
    projectIdentity: string;
    workspaceIdentity: string;
    files: SimulatorProjectArtifactFilePort;

    readBoard(): Promise<BoardPackage>;
    assertCurrent(): void;
    compile(board: BoardPackage, graphSemanticRevision: string, signal: AbortSignal): Promise<string>;
  }) {}

  async read(request: SimulatorHostBoardDemonstrationRead, signal: AbortSignal): Promise<SimulatorHostBoardDemonstrationSnapshot> {
    this.requireProject(request.projectIdentity, signal);

    const board = await this.options.readBoard();
    const { files } = this.options;

    if (this.board?.path !== board.path || this.board.name !== board.name || this.board.version !== board.version) {
      this.artifacts?.close();

      this.artifacts = null;

      this.board = board;
    }

    const bytes = await this.readFile('demo_script.json', 256 * 1024, signal);
    const script = validateSceneDemonstrationScript(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));

    const document = await verifySceneEditorDocumentV2Revisions(JSON.parse(new TextDecoder('utf-8', { fatal: true })
      .decode(await this.readFile('demo/circuit.json', 2 * 1024 * 1024, signal))));

    const sourceCode = new TextDecoder('utf-8', { fatal: true }).decode(await this.readFile('demo/sketch.ino', 64 * 1024, signal));

    this.requireProject(request.projectIdentity, signal);

    return { schemaVersion: 1, kind: 'aily-board-demonstration-snapshot', projectIdentity: request.projectIdentity,
      boardPackageName: board.name, boardPackageVersion: board.version, revision: await digest(bytes), script, document, sourceCode, artifact: null };
  }

  async compile(request: SimulatorHostBoardDemonstrationRead, signal: AbortSignal): Promise<SimulatorHostBoardDemonstrationSnapshot> {
    const snapshot = await this.read(request, signal);
    const root = await this.options.compile(this.board!, snapshot.document.graphSemanticRevision, signal);

    this.requireProject(request.projectIdentity, signal);
    this.artifacts?.close();

    this.artifacts = new SimulatorProjectArtifactCallbackAuthority({ projectRoot: root,
      projectIdentity: this.options.projectIdentity, workspaceIdentity: this.options.workspaceIdentity, files: this.options.files });

    const artifact = await this.artifacts.callbacks.readArtifact({ projectIdentity: request.projectIdentity, artifactRevision: null }, signal);

    if (artifact.artifact.build.graph?.graphSemanticRevision !== snapshot.document.graphSemanticRevision) {
      throw new SimulatorHostProviderOperationError('conflict', 'Compiled demonstration and circuit differ.');
    }

    return { ...snapshot, artifact };
  }

  async write(request: SimulatorHostBoardDemonstrationWrite, signal: AbortSignal): Promise<SimulatorHostBoardDemonstrationSnapshot> {
    const current = await this.read(request, signal);

    if (current.boardPackageName !== request.boardPackageName || current.revision !== request.expectedRevision
      || current.script.boardCatalogId !== request.script.boardCatalogId) throw new SimulatorHostProviderOperationError('conflict');

    const script = validateSceneDemonstrationScript(request.script);
    const bytes = await this.readFile('demo_script.json', 256 * 1024, signal);

    if (await digest(bytes) !== current.revision) throw new SimulatorHostProviderOperationError('conflict');

    const saved = await this.options.files.replaceFileAtomic(this.board!.path, 'demo_script.json', bytes,
      new TextEncoder().encode(`${JSON.stringify(script, null, 2)}\n`), signal);

    if (!saved) throw new SimulatorHostProviderOperationError('conflict');

    return this.read(request, signal);
  }

  hasArtifactReference(reference: string): boolean {
    return this.artifacts?.hasArtifactReference(reference) ?? false;
  }

  readArtifactChunk(request: SimulatorSubappHostArtifactChunkRequestV1, signal: AbortSignal) {
    this.requireProject(request.projectIdentity, signal);

    if (!this.artifacts) throw new SimulatorHostProviderOperationError('operation-failed');

    return this.artifacts.callbacks.readArtifactChunk(request, signal);
  }

  close(): void {
    this.artifacts?.close();

    this.artifacts = null;
    this.board = null;
  }

  private requireProject(projectIdentity: string, signal: AbortSignal): void {
    signal.throwIfAborted();
    this.options.assertCurrent();

    if (projectIdentity !== this.options.projectIdentity) throw new SimulatorHostProviderOperationError('conflict');
  }

  private async readFile(relativePath: string, maximum: number, signal: AbortSignal): Promise<Uint8Array> {
    const path = this.options.files.join(this.board!.path, relativePath);
    const stat = await this.options.files.lstat(path, signal);

    if (!stat.isFile || stat.isSymbolicLink || stat.size > maximum) throw new SimulatorHostProviderOperationError('operation-failed');

    return this.options.files.readFile(path, signal);
  }
}

async function digest(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))))
    .map(value => value.toString(16).padStart(2, '0')).join('');
}
