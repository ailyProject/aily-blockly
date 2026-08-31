export const RECENT_PROJECTS_STORAGE_LIMIT = 20;
export const GUIDE_RECENT_PROJECTS_LIMIT = 6;

export interface RecentProject {
  name: string;
  path: string;
  nickname?: string;
}

export function addRecentProject(
  projects: readonly RecentProject[],
  project: RecentProject,
): RecentProject[] {
  return [
    project,
    ...projects.filter((item) => item.path !== project.path),
  ].slice(0, RECENT_PROJECTS_STORAGE_LIMIT);
}

export function removeRecentProject(
  projects: readonly RecentProject[],
  path: string,
): RecentProject[] {
  return projects.filter((item) => item.path !== path);
}

export function getGuideRecentProjects(
  projects: readonly RecentProject[],
): RecentProject[] {
  return projects.slice(0, GUIDE_RECENT_PROJECTS_LIMIT);
}
