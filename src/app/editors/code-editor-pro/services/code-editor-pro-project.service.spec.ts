import { CodeEditorProProjectService } from './code-editor-pro-project.service';

describe('CodeEditorProProjectService host paths', () => {
  const projectPath = '/Users/Dev/Documents/Coder-Project';
  let service: CodeEditorProProjectService, handlers: Map<string, (action?: any) => any>, project: any, bridge: any;

  beforeEach(() => {
    handlers = new Map();
    const actions = { listen: (name: string, handler: (action?: any) => any) => handlers.set(name, handler), unlisten: () => undefined };
    project = {
      currentProjectPath: projectPath,
      hasUnsavedLibraryChanges: jasmine.createSpy('libraryStatus').and.resolveTo(false),
      saveLibraryChanges: jasmine.createSpy('librarySave').and.resolveTo(),
      isAilyCodeProject: jasmine.createSpy('isAilyCodeProject').and.returnValue(true),
    };
    const buildInfo = { updateCodeHash: jasmine.createSpy('updateCodeHash').and.resolveTo() };
    service = new CodeEditorProProjectService(actions as any, project, buildInfo as any);
    service.init();
    bridge = { saveAll: jasmine.createSpy('saveAll').and.resolveTo({ ok: true }), hasUnsavedChanges: jasmine.createSpy('dirty').and.resolveTo(false) };
    service.registerPersistenceBridge(projectPath, bridge);
  });

  it('checks unsaved libraries with the registered path spelling', async () => {
    expect(await handlers.get('project-check-unsaved')!()).toEqual({ hasUnsavedChanges: false });
    expect(project.hasUnsavedLibraryChanges).toHaveBeenCalledOnceWith(projectPath);
  });

  it('saves every open project with the registered path spelling', async () => {
    await service.saveAllOpenProjects();
    expect(bridge.saveAll).toHaveBeenCalledTimes(1);
    expect(project.saveLibraryChanges).toHaveBeenCalledOnceWith(projectPath);
    expect(project.isAilyCodeProject).toHaveBeenCalledOnceWith(projectPath);
  });

  it('matches a differently cased request but publishes with the registered path', async () => {
    await service.saveAll(projectPath.toLowerCase() + '/');
    expect(project.saveLibraryChanges).toHaveBeenCalledOnceWith(projectPath);
  });
});
