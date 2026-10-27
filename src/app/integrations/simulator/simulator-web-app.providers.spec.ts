import { TestBed } from '@angular/core/testing';
import { ProjectService } from '../../services/domains/project/project.service';
import { provideSimulatorWebApplication, SIMULATOR_WEB_PROJECT_PUBLICATION } from './simulator-web-app.providers';
import { SIMULATOR_WEB_PRODUCT_SOURCE } from './simulator-web-product.providers';
import { SIMULATOR_WEB_PROJECT_ACTIVATION } from './simulator-web-project-activation.providers';
import type { SimulatorProjectActivationPort, SimulatorWebProjectPublicationPort } from './simulator-web-project-activation';

// Actual Angular DI boundaries with explicit source doubles. These cases do not
// open a Browser workspace, account, filesystem, Artifact, Worker or MCU.
function unselectedPort(): SimulatorProjectActivationPort {
  return {
    captureCurrentProjectActivation: () => null,
    projectActivation$: { subscribe: () => ({ unsubscribe() {} }) },
    currentProjectPath$: { subscribe: () => ({ unsubscribe() {} }) },
  };
}

describe('Simulator Web owning application activation DI', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('normal application useExisting reuses its original ProjectService without another project owner', () => {
    const original = unselectedPort();
    TestBed.configureTestingModule({ providers: [
      { provide: ProjectService, useValue: original },
      { provide: SIMULATOR_WEB_PROJECT_ACTIVATION, useExisting: ProjectService },
    ] });
    expect(TestBed.inject(SIMULATOR_WEB_PROJECT_ACTIVATION)).toBe(original);
  });

  it('uses an explicitly supplied workspace port without instantiating the desktop service', () => {
    const owningWorkspace = unselectedPort();
    TestBed.configureTestingModule({ providers: [
      { provide: ProjectService, useFactory: () => { throw new Error('Unexpected desktop project resolution.'); } },
      { provide: SIMULATOR_WEB_PROJECT_ACTIVATION, useValue: owningWorkspace },
      provideSimulatorWebApplication(),
    ] });
    expect(TestBed.inject(SIMULATOR_WEB_PROJECT_ACTIVATION)).toBe(owningWorkspace);
    expect(TestBed.inject(SIMULATOR_WEB_PRODUCT_SOURCE)).toBeNull();
  });

  it('does not read activation or manufacture publication when its configured publication is absent', () => {
    const owningWorkspace = unselectedPort();
    owningWorkspace.captureCurrentProjectActivation = () => { throw new Error('Unexpected activation read.'); };
    TestBed.configureTestingModule({ providers: [
      { provide: SIMULATOR_WEB_PROJECT_ACTIVATION, useValue: owningWorkspace },
      provideSimulatorWebApplication(),
    ] });
    expect(TestBed.inject(SIMULATOR_WEB_PROJECT_PUBLICATION)).toBeNull();
    expect(TestBed.inject(SIMULATOR_WEB_PRODUCT_SOURCE)).toBeNull();
  });

  it('keeps an unconfigured activation source unavailable even when publication is supplied', () => {
    const publication: SimulatorWebProjectPublicationPort = { async readPublication() {
      throw new Error('Missing project configuration must not read publication.');
    } };
    TestBed.configureTestingModule({ providers: [
      { provide: ProjectService, useFactory: () => { throw new Error('Unexpected desktop project resolution.'); } },
      { provide: SIMULATOR_WEB_PROJECT_PUBLICATION, useValue: publication },
      provideSimulatorWebApplication(),
    ] });
    expect(TestBed.inject(SIMULATOR_WEB_PROJECT_ACTIVATION)).toBeNull();
    expect(TestBed.inject(SIMULATOR_WEB_PRODUCT_SOURCE)).toBeNull();
  });

  it('routes configured application reads through the injected port and rejects a missing real selection', async () => {
    const owningWorkspace = unselectedPort();
    let captures = 0, publications = 0;
    owningWorkspace.captureCurrentProjectActivation = () => { captures++; return null; };
    const publication: SimulatorWebProjectPublicationPort = { async readPublication() {
      publications++; throw new Error('An unopened project cannot have a publication.');
    } };
    TestBed.configureTestingModule({ providers: [
      { provide: ProjectService, useFactory: () => { throw new Error('Unexpected desktop project resolution.'); } },
      { provide: SIMULATOR_WEB_PROJECT_ACTIVATION, useValue: owningWorkspace },
      { provide: SIMULATOR_WEB_PROJECT_PUBLICATION, useValue: publication },
      provideSimulatorWebApplication(),
    ] });
    const source = TestBed.inject(SIMULATOR_WEB_PRODUCT_SOURCE)!;
    let rejected: { code?: string } | null = null;
    try { await source.readComposition(new AbortController().signal); }
    catch (error) { rejected = error as { code?: string }; }
    expect(rejected?.code).toBe('project-unavailable');
    expect(captures).toBe(1); expect(publications).toBe(0);
    const owned = source as typeof source & { close(): Promise<void>; snapshot(): { retainedCleanupResponsibility: boolean } };
    await owned.close();
    expect(owned.snapshot().retainedCleanupResponsibility).toBeFalse();
  });
});
