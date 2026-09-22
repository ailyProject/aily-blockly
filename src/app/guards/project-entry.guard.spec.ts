import { fakeAsync, TestBed, tick } from '@angular/core/testing';
import { convertToParamMap, Router } from '@angular/router';
import { ProjectService } from '@domain/project/public-api';
import { projectEntryGuard } from './project-entry.guard';

describe('project deep-link entry', () => {
  function setup(currentProjectPath: string) {
    const project = { currentProjectPath, projectOpen: jasmine.createSpy('projectOpen').and.resolveTo(false) };
    const router = { createUrlTree: jasmine.createSpy('createUrlTree').and.returnValue('guide') };
    TestBed.configureTestingModule({ providers: [
      { provide: ProjectService, useValue: project },
      { provide: Router, useValue: router },
    ] });
    const run = (path: string) => TestBed.runInInjectionContext(() => projectEntryGuard(
      { queryParamMap: convertToParamMap({ path }) } as any, {} as any,
    ));
    return { project, router, run };
  }

  it('routes cold-start project paths through the shared opener without losing characters', () => {
    const { router, run } = setup('');
    const path = '/项目/a & b #';
    expect(run(path)).toBe('guide' as any);
    expect(router.createUrlTree).toHaveBeenCalledWith(['/main/guide'], { queryParams: { openProject: path } });
  });

  it('keeps an existing editor mounted while the shared opener decides whether to reject a deep link', fakeAsync(() => {
    const { project, router, run } = setup('/current');
    expect(run('/other')).toBeFalse();
    expect(project.projectOpen).not.toHaveBeenCalled();
    tick();
    expect(project.projectOpen).toHaveBeenCalledWith('/other');
    expect(project.currentProjectPath).toBe('/current');
    expect(router.createUrlTree).not.toHaveBeenCalled();
  }));

  it('allows the shared opener to activate the project it has validated', () => {
    const { project, run } = setup('/current');
    expect(run('/current')).toBeTrue();
    expect(project.projectOpen).not.toHaveBeenCalled();
  });
});
