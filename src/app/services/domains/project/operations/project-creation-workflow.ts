import type { NewProjectData } from '../../../../types/project-new';

export type ProjectCreationMode = 'blockly' | 'coder';

export type ProjectCreationBlockedReason = 'path-exists' | 'invalid-path';

export type ProjectCreationWorkflowResult =
  | { status: 'blocked'; reason: ProjectCreationBlockedReason }
  | { status: 'failed'; error?: unknown }
  | { status: 'created' };

export interface ProjectCreationTemplateSelection {
  name: string;
  nickname?: string;
  description?: string;
}

export interface ProjectCreationTemplateProject extends ProjectCreationTemplateSelection {
  is_template?: boolean;
  archive_url?: string;
}

export interface ProjectCreationTemplatePage {
  list: ProjectCreationTemplateProject[];
  total: number;
}

export interface ProjectCreationWorkflowRequest {
  mode: ProjectCreationMode;
  project: NewProjectData;
  templateSelected?: boolean;
  selectedTemplate?: ProjectCreationTemplateSelection | null;
}

/**
 * UI and integration boundary for the project-creation operation.
 *
 * The workflow deliberately knows nothing about Angular, CloudService, window
 * presentation, or navigation. Main-page and child-window callers keep those
 * differences behind these callbacks.
 */
export interface ProjectCreationWorkflowPorts {
  validate(): Promise<ProjectCreationBlockedReason | null>;
  onCreating(mode: ProjectCreationMode): void;
  recordBoardUsage(boardName: string): void;
  listTemplateProjects(page: number, pageSize: number): Promise<ProjectCreationTemplatePage>;
  resolveTemplateArchiveUrl(project: ProjectCreationTemplateProject): string;
  downloadTemplateArchive(archiveUrl: string): Promise<string>;
  cleanupExtractedFiles(extractPath: string): void;
  createProject(mode: ProjectCreationMode): Promise<boolean>;
  createProjectFromTemplate(extractPath: string): Promise<boolean>;
  onCreated(mode: ProjectCreationMode): Promise<void> | void;
  onFailed(mode: ProjectCreationMode): void;
  reportError(error: unknown): void;
}

const TEMPLATE_PAGE_SIZE = 100;

async function findSelectedTemplateProject(
  selectedTemplate: ProjectCreationTemplateSelection,
  listTemplateProjects: ProjectCreationWorkflowPorts['listTemplateProjects'],
): Promise<ProjectCreationTemplateProject> {
  let page = 1;
  let total = 0;

  do {
    const result = await listTemplateProjects(page, TEMPLATE_PAGE_SIZE);
    const projects = Array.isArray(result?.list) ? result.list : [];
    total = Number(result?.total || 0);

    const matchedProject = projects.find(project => (
      project?.is_template === true
      && project?.name === selectedTemplate.name
      && (project?.nickname || '') === (selectedTemplate.nickname || '')
      && (project?.description || '') === (selectedTemplate.description || '')
    ));

    if (matchedProject) {
      return matchedProject;
    }

    page += 1;
  } while ((page - 1) * TEMPLATE_PAGE_SIZE < total);

  throw new Error('未找到所选模板项目');
}

/**
 * Runs the shared, presentation-independent project creation sequence.
 *
 * Board usage remains recorded when creation starts (including failed
 * attempts), matching the existing behavior of both entry points. Extracted
 * template files are always cleaned after a download, even if creation fails.
 */
export async function runProjectCreationWorkflow(
  request: ProjectCreationWorkflowRequest,
  ports: ProjectCreationWorkflowPorts,
): Promise<ProjectCreationWorkflowResult> {
  const blockedReason = await ports.validate();
  if (blockedReason) {
    return { status: 'blocked', reason: blockedReason };
  }

  ports.onCreating(request.mode);
  ports.recordBoardUsage(request.project.board.name);

  let extractPath = '';
  let created = false;
  let creationError: unknown;
  let creationThrew = false;
  try {
    const shouldUseTemplate = request.mode === 'blockly'
      && (request.templateSelected ?? !!request.selectedTemplate);
    if (shouldUseTemplate) {
      if (!request.selectedTemplate) {
        throw new Error('未找到所选模板的归档文件');
      }
      const templateProject = await findSelectedTemplateProject(
        request.selectedTemplate,
        ports.listTemplateProjects,
      );
      const archiveUrl = ports.resolveTemplateArchiveUrl(templateProject);
      if (!archiveUrl) {
        throw new Error('未找到所选模板的归档文件');
      }
      extractPath = await ports.downloadTemplateArchive(archiveUrl);
      created = await ports.createProjectFromTemplate(extractPath);
    } else {
      created = await ports.createProject(request.mode);
    }
  } catch (error) {
    creationThrew = true;
    creationError = error;
    ports.reportError(error);
  } finally {
    if (extractPath) {
      ports.cleanupExtractedFiles(extractPath);
    }
  }

  if (creationThrew) {
    ports.onFailed(request.mode);
    return { status: 'failed', error: creationError };
  }

  if (!created) {
    ports.onFailed(request.mode);
    return { status: 'failed' };
  }

  try {
    await ports.onCreated(request.mode);
    return { status: 'created' };
  } catch (error) {
    ports.reportError(error);
    ports.onFailed(request.mode);
    return { status: 'failed', error };
  }
}
