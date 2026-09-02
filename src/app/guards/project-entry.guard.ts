import { inject } from '@angular/core';
import { Router, type CanActivateFn } from '@angular/router';
import { ProjectService } from '@domain/project/public-api';

/** Deep links must enter through projectOpen so they cannot bypass mode/lock checks. */
export const projectEntryGuard: CanActivateFn = (route) => {
  const project = inject(ProjectService);
  const router = inject(Router);
  const projectPath = route.queryParamMap.get('path');
  if (projectPath && project.currentProjectPath === projectPath) return true;
  if (projectPath && project.currentProjectPath) {
    // Finish cancelling this navigation before projectOpen performs its own navigation.
    // In particular, a rejected deep link must not destroy the current editor.
    setTimeout(() => {
      void project.projectOpen(projectPath).catch(error => console.error('Project deep link failed:', error));
    });
    return false;
  }
  return router.createUrlTree(['/main/guide'], {
    queryParams: projectPath ? { openProject: projectPath } : {},
  });
};
