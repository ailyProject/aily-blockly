import { TestBed } from '@angular/core/testing';
import { ProjectService } from '@domain/project/public-api';
import { SimulatorHostProviderProductService } from './simulator-host-provider-product.service';
import { BLOCKLY_SIMULATOR_WEB_DEPLOYMENT, provideBlocklySimulatorWebProject } from './blockly-simulator-web.providers';
import { SIMULATOR_WEB_PROJECT_ACTIVATION } from './simulator-web-project-activation.providers';
import { SIMULATOR_WEB_PROJECT_PUBLICATION } from './simulator-web-app.providers';
import type { SimulatorProjectActivationPort } from './simulator-web-project-activation';
import { BlocklyService } from '../../editors/blockly-editor/services/blockly.service';

// Actual provider composition with explicit originals as DI doubles. These
// cases do not claim to instantiate the desktop graph or open a product UI.
function originalProject(): SimulatorProjectActivationPort {
  return { captureCurrentProjectActivation: () => null,
    projectActivation$: { subscribe: () => ({ unsubscribe() {} }) },
    currentProjectPath$: { subscribe: () => ({ unsubscribe() {} }) } };
}

describe('Blockly Simulator Web original project DI', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('keeps absent trusted deployment null without constructing the original Host provider', () => {
    TestBed.configureTestingModule({ providers: [provideBlocklySimulatorWebProject(),
      { provide: SimulatorHostProviderProductService, useFactory: () => { throw new Error('Unexpected Host provider construction.'); } },
    ] });
    expect(TestBed.inject(BLOCKLY_SIMULATOR_WEB_DEPLOYMENT)).toBeNull();
    expect(TestBed.inject(SIMULATOR_WEB_PROJECT_PUBLICATION)).toBeNull();
  });

  it('the actual provider factory accepts activation bound to the owning ProjectService instance', async () => {
    const project = originalProject();
    let opens = 0;
    TestBed.configureTestingModule({ providers: [provideBlocklySimulatorWebProject(),
      { provide: ProjectService, useValue: project },
      { provide: SIMULATOR_WEB_PROJECT_ACTIVATION, useExisting: ProjectService },
      { provide: BLOCKLY_SIMULATOR_WEB_DEPLOYMENT, useValue: { async readStartup() { throw new Error('No project was selected.'); } } },
      { provide: SimulatorHostProviderProductService, useValue: { async openCurrentProjectScope() { opens++; return null; } } },
      { provide: BlocklyService, useValue: { async waitForReusableGeneratedCode() { throw new Error('No scope selected.'); } } },
    ] });
    expect(TestBed.inject(SIMULATOR_WEB_PROJECT_ACTIVATION)).toBe(project);
    expect(TestBed.inject(SIMULATOR_WEB_PROJECT_ACTIVATION)).toBe(TestBed.inject(ProjectService));
    const publication = TestBed.inject(SIMULATOR_WEB_PROJECT_PUBLICATION)!;
    let rejected: { code?: string } | null = null;
    try { await publication.readPublication('/normally-opened', new AbortController().signal); }
    catch (error) { rejected = error as { code?: string }; }
    expect(rejected?.code).toBe('project-unavailable'); expect(opens).toBe(1);
  });

  it('does not pair another Browser owner with the desktop Blockly file authority', () => {
    TestBed.configureTestingModule({ providers: [provideBlocklySimulatorWebProject(),
      { provide: ProjectService, useValue: originalProject() },
      { provide: SIMULATOR_WEB_PROJECT_ACTIVATION, useValue: originalProject() },
      { provide: BLOCKLY_SIMULATOR_WEB_DEPLOYMENT, useValue: { async readStartup() { throw new Error('Wrong owner.'); } } },
      { provide: SimulatorHostProviderProductService, useFactory: () => { throw new Error('Unexpected desktop Host construction.'); } },
    ] });
    expect(TestBed.inject(SIMULATOR_WEB_PROJECT_PUBLICATION)).toBeNull();
  });
});
