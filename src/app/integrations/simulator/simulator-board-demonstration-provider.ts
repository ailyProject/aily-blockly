import { SimulatorHostProviderOperationError } from '@aily-project/simulator-host-sdk';
import { validateSceneDemonstrationScript, splitDemonstrationCircuits } from '@aily-project/simulator-protocol/scene';
import { verifySceneEditorDocumentV2Revisions } from '@aily-project/scene-model';

import type { SimulatorHostBoardDemonstrationRead, SimulatorHostBoardDemonstrationWrite,
  SimulatorHostBoardDemonstrationSnapshot, SimulatorSubappHostArtifactChunkRequestV1 } from '@aily-project/simulator-protocol/host';
import { SimulatorProjectArtifactCallbackAuthority, type SimulatorProjectArtifactFilePort } from './simulator-project-artifact-callback-authority';

type BoardPackage = { id: string; path: string; demoPath: string; name: string; version: string };

/** Simulator-owned course resources; native paths stay inside Host callbacks. */
export class SimulatorBoardDemonstrationProvider {
  private readonly artifacts = new Map<string, SimulatorProjectArtifactCallbackAuthority>();
  private board: BoardPackage | null = null;

  constructor(private readonly options: {
    projectIdentity: string;
    projectRoot: string;
    workspaceIdentity: string;
    files: SimulatorProjectArtifactFilePort;

    readBoard(signal: AbortSignal): Promise<BoardPackage>;
    assertCurrent(): void;
    compile(board: BoardPackage, graphSemanticRevision: string, signal: AbortSignal, program?: string): Promise<string>;
  }) {}

  async read(request: SimulatorHostBoardDemonstrationRead, signal: AbortSignal): Promise<SimulatorHostBoardDemonstrationSnapshot> {
    this.requireProject(request.projectIdentity, signal);

    const board = await this.options.readBoard(signal);

    if (this.board?.path !== board.path || this.board.demoPath !== board.demoPath
      || this.board.name !== board.name || this.board.version !== board.version) {
      this.closeArtifacts();
      this.board = board;
    }

    const bytes = await this.readScriptOverride(signal) ?? await this.readFile('demo_script.json', 256 * 1024, signal);
    const script = validateSceneDemonstrationScript(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    const lesson = request.lessonId ? script.lessons.find(item => item.id === request.lessonId) : script.lessons[0];

    if (!lesson) throw new SimulatorHostProviderOperationError('conflict', 'Demonstration lesson does not exist.');

    const directory = lesson.program ? `programs/${lesson.program}` : '.';

    const document = await verifySceneEditorDocumentV2Revisions(JSON.parse(new TextDecoder('utf-8', { fatal: true })
      .decode(await this.readFile(`${directory}/circuit.json`, 2 * 1024 * 1024, signal))));

    const sourceCode = new TextDecoder('utf-8', { fatal: true }).decode(await this.readFile(`${directory}/sketch.ino`, 64 * 1024, signal));

    const circuits = lesson.members ? await splitDemonstrationCircuits(document, lesson.members.map(member => member.boardInstanceId)) : [];
    const members = lesson.members ? await Promise.all(lesson.members.map(async (member, index) => ({
      id: member.id, document: circuits[index]!, artifact: null,
      sourceCode: new TextDecoder('utf-8', { fatal: true }).decode(await this.readFile(`programs/${member.program}/sketch.ino`, 64 * 1024, signal)),
    }))) : undefined;

    this.requireProject(request.projectIdentity, signal);

    return { ...(members ? { members } : {}), schemaVersion: 1, kind: 'aily-board-demonstration-snapshot', projectIdentity: request.projectIdentity,
      boardPackageName: board.name, boardPackageVersion: board.version, lessonId: lesson.id, revision: await digest(bytes), script, document, sourceCode, artifact: null };
  }

  async compile(request: SimulatorHostBoardDemonstrationRead, signal: AbortSignal): Promise<SimulatorHostBoardDemonstrationSnapshot> {
    const snapshot = await this.read(request, signal);
    const lesson = snapshot.script.lessons.find(lesson => lesson.id === snapshot.lessonId)!;

    this.closeArtifacts();

    const compile = async (document: typeof snapshot.document, program?: string) => {
      const root = await this.options.compile(this.board!, document.graphSemanticRevision, signal, program);

      this.requireProject(request.projectIdentity, signal);

      const authority = new SimulatorProjectArtifactCallbackAuthority({ projectRoot: root,
        projectIdentity: this.options.projectIdentity, workspaceIdentity: this.options.workspaceIdentity, files: this.options.files });

      this.artifacts.set(root, authority);

      const artifact = await authority.callbacks.readArtifact({ projectIdentity: request.projectIdentity, artifactRevision: null }, signal);

      if (artifact.artifact.build.graph?.graphSemanticRevision !== document.graphSemanticRevision) {
        throw new SimulatorHostProviderOperationError('conflict', 'Compiled demonstration and circuit differ.');
      }

      return artifact;
    };

    if (snapshot.members && lesson.members) {
      for (const member of snapshot.members) {
        member.artifact = await compile(member.document, lesson.members.find(item => item.id === member.id)!.program);
      }

      return snapshot;
    }

    return { ...snapshot, artifact: await compile(snapshot.document, lesson.program) };
  }

  async write(request: SimulatorHostBoardDemonstrationWrite, signal: AbortSignal): Promise<SimulatorHostBoardDemonstrationSnapshot> {
    const current = await this.read(request, signal);

    if (current.boardPackageName !== request.boardPackageName || current.revision !== request.expectedRevision
      || current.script.boardCatalogId !== request.script.boardCatalogId) throw new SimulatorHostProviderOperationError('conflict');

    const script = validateSceneDemonstrationScript(request.script);
    const override = await this.readScriptOverride(signal);
    const bytes = override ?? await this.readFile('demo_script.json', 256 * 1024, signal);

    if (await digest(bytes) !== current.revision) throw new SimulatorHostProviderOperationError('conflict');

    const saved = await this.options.files.replaceFileAtomic(this.options.projectRoot, this.scriptOverridePath(), override,
      new TextEncoder().encode(`${JSON.stringify(script, null, 2)}\n`), signal);

    if (!saved) throw new SimulatorHostProviderOperationError('conflict');

    return this.read(request, signal);
  }

  hasArtifactReference(reference: string): boolean {
    return [...this.artifacts.values()].some(authority => authority.hasArtifactReference(reference));
  }

  readArtifactChunk(request: SimulatorSubappHostArtifactChunkRequestV1, signal: AbortSignal) {
    this.requireProject(request.projectIdentity, signal);

    const authority = [...this.artifacts.values()].find(authority => authority.hasArtifactReference(request.artifactReference));

    if (!authority) throw new SimulatorHostProviderOperationError('operation-failed');

    return authority.callbacks.readArtifactChunk(request, signal);
  }

  close(): void {
    this.closeArtifacts();
    this.board = null;
  }

  private closeArtifacts(): void {
    for (const authority of this.artifacts.values()) authority.close();

    this.artifacts.clear();
  }

  private requireProject(projectIdentity: string, signal: AbortSignal): void {
    signal.throwIfAborted();
    this.options.assertCurrent();

    if (projectIdentity !== this.options.projectIdentity) throw new SimulatorHostProviderOperationError('conflict');
  }

  private scriptOverridePath(): string {
    return `.aily/simulator/demonstrations/${this.board!.id}/demo_script.json`;
  }

  private async readScriptOverride(signal: AbortSignal): Promise<Uint8Array | null> {
    try {
      return await this.readFile(this.scriptOverridePath(), 256 * 1024, signal, this.options.projectRoot);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;

      throw error;
    }
  }

  private async readFile(relativePath: string, maximum: number, signal: AbortSignal, root = this.board!.demoPath): Promise<Uint8Array> {
    const path = this.options.files.join(root, relativePath);
    const stat = await this.options.files.lstat(path, signal);

    if (!stat.isFile || stat.isSymbolicLink || stat.size > maximum) throw new SimulatorHostProviderOperationError('operation-failed');

    return this.options.files.readFile(path, signal);
  }
}

async function digest(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))))
    .map(value => value.toString(16).padStart(2, '0')).join('');
}
