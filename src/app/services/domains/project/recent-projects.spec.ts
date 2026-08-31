import {
  RECENT_PROJECTS_STORAGE_LIMIT,
  addRecentProject,
  getGuideRecentProjects,
  removeRecentProject,
} from './recent-projects';

describe('Recent projects', () => {
  const projects = Array.from({ length: 20 }, (_, index) => ({
    name: `Project ${index + 1}`,
    path: `/projects/${index + 1}`,
  }));

  it('stores at most 20 projects', () => {
    const result = addRecentProject(projects, {
      name: 'Newest project',
      path: '/projects/newest',
    });

    expect(result.length).toBe(RECENT_PROJECTS_STORAGE_LIMIT);
    expect(result[0].path).toBe('/projects/newest');
    expect(result.at(-1)?.path).toBe('/projects/19');
  });

  it('moves an existing project to the front without duplicating it', () => {
    const result = addRecentProject(projects, projects[9]);

    expect(result[0].path).toBe('/projects/10');
    expect(result.filter((project) => project.path === '/projects/10').length).toBe(1);
  });

  it('keeps the guide limited to the newest 6 projects', () => {
    expect(getGuideRecentProjects(projects).map((project) => project.path)).toEqual([
      '/projects/1',
      '/projects/2',
      '/projects/3',
      '/projects/4',
      '/projects/5',
      '/projects/6',
    ]);
  });

  it('removes a project whose path is no longer available', () => {
    const result = removeRecentProject(projects, '/projects/10');

    expect(result.some((project) => project.path === '/projects/10')).toBeFalse();
    expect(result.length).toBe(19);
  });
});
