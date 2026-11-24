import { ProjectService } from '@domain/project/public-api';
import { UiService } from '@core/app-shell/public-api';
import { ProjectApplicationAdapter } from '../project/project-application.adapter';
import { BoardSelectorDialogComponent } from '../../main-window/components/board-selector-dialog/board-selector-dialog.component';

describe('Coder missing board selection', () => {
  let project: any, ui: any, adapter: any, manifest: any, originalFs: any;

  beforeEach(() => {
    originalFs = window['fs'];
    window['fs'] = { existsSync: () => false };
    manifest = { type: 'coder', arduinoSketch: true, entry: 'Blink.ino', dependencies: {}, boardDependencies: {} };
    project = Object.create(ProjectService.prototype);
    project.currentProjectPathSubject = { value: '/project' };
    project.configService = { isCoderProduct: () => true };
    project.isAilyCodeProject = () => true;
    project.getPackageJson = jasmine.createSpy('manifest').and.callFake(async () => manifest);
    project.messageService = { warning: jasmine.createSpy('warning') };
    ui = Object.create(UiService.prototype);
    ui.injector = { get: () => project };
    ui.configService = { getBoardListForSelector: () => [{ name: 'Arduino UNO' }] };
    Object.defineProperty(ui, 'modal', { value: { openModals: [], create: jasmine.createSpy('modal') } });
    adapter = Object.create(ProjectApplicationAdapter.prototype);
    adapter.projectService = project;
    adapter.uiService = ui;
    project.injector = { get: () => adapter };
  });

  afterEach(() => { window['fs'] = originalFs; });

  it('shows the prompt and the real board selector through the application adapter without changing project metadata', async () => {
    const before = JSON.stringify(manifest);
    expect(await project.ensureCoderBoardSelected()).toBeFalse();
    expect(project.messageService.warning).toHaveBeenCalledOnceWith('请先选择开发板，再编译或上传 Arduino 工程。');
    expect(ui.modal.create).toHaveBeenCalledOnceWith(jasmine.objectContaining({
      nzContent: BoardSelectorDialogComponent,
      nzData: { boardList: [{ name: 'Arduino UNO' }], isAilyCode: true },
    }));
    expect(JSON.stringify(manifest)).toBe(before);

    manifest.dependencies['@aily-project/board-arduino_uno'] = '1.8.6';
    expect(await project.ensureCoderBoardSelected()).toBeTrue();
    expect(ui.modal.create).toHaveBeenCalledTimes(1);
    expect(project.messageService.warning).toHaveBeenCalledTimes(1);
  });

  it('recognizes a saved boardDependencies target without prompting again', async () => {
    manifest.boardDependencies['@aily-project/board-arduino_uno'] = '1.8.6';
    expect(await project.ensureCoderBoardSelected()).toBeTrue();
    expect(ui.modal.create).not.toHaveBeenCalled();
  });

  for (const coderProduct of [true, false]) {
    it(`preserves Blockly behavior in ${coderProduct ? 'Coder software' : 'Blockly software'}`, async () => {
      project.configService.isCoderProduct = () => coderProduct;
      project.isAilyCodeProject = () => !coderProduct;
      expect(await project.ensureCoderBoardSelected()).toBeTrue();
      expect(project.getPackageJson).not.toHaveBeenCalled();
      expect(ui.modal.create).not.toHaveBeenCalled();
      expect(project.messageService.warning).not.toHaveBeenCalled();
    });
  }

  it('does not open another selector when the Coder selector is already visible', async () => {
    ui.modal.openModals = [{ getContentComponent: () => Object.create(BoardSelectorDialogComponent.prototype) }];
    expect(await project.ensureCoderBoardSelected()).toBeFalse();
    expect(ui.modal.create).not.toHaveBeenCalled();
  });

  it('drops a delayed missing-board result after the active project changes', async () => {
    project.getBoardModule = async () => { project.currentProjectPathSubject.value = '/other'; return undefined; };
    expect(await project.ensureCoderBoardSelected()).toBeFalse();
    expect(ui.modal.create).not.toHaveBeenCalled();
    expect(project.messageService.warning).not.toHaveBeenCalled();
  });

  it('does not open a selector for the wrong project after board catalog loading', async () => {
    ui.configService.getBoardListForSelector = () => [];
    ui.configService.loadBoardList = async () => { project.currentProjectPathSubject.value = '/other'; return []; };
    expect(await project.ensureCoderBoardSelected()).toBeFalse();
    expect(ui.modal.create).not.toHaveBeenCalled();
  });

  it('keeps a background project request from selecting the active project board', async () => {
    project.getCoderProjectContext = () => ({ getBoardModule: async () => undefined, captureCurrentProjectGuard: () => () => true });
    expect(await project.ensureCoderBoardSelected('/background')).toBeFalse();
    expect(ui.modal.create).not.toHaveBeenCalled();
  });
});
