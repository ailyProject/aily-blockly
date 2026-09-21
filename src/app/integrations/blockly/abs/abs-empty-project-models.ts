import type { AbsAbiWorkspace, AbsProjection } from './abs-state';
import { readAbsSyntax } from './abs-syntax';
import { walkAbsRawSyntax } from './abs-syntax-binding';

const keysWithin = (value: object, keys: string[]) => Object.keys(value).every(key => keys.includes(key));
const skeletonTypes = new Set(['arduino_global', 'arduino_setup', 'arduino_loop']);

/** Empty Arduino skeletons cannot own library models. Unknown blocks/serializers
 * and nonempty other pages make that proof unavailable; they are never GC'd here.
 * Run only in a changed candidate, not on read/export and not on the live canvas.
 */
export function retireEmptyProjectModels(baseline: AbsProjection, candidate: AbsAbiWorkspace, source: string): string[] {
  const emptyWorkspace = (workspace: any): boolean => !!workspace &&
    keysWithin(workspace, ['blocks', 'variables']) && !!workspace.blocks &&
    keysWithin(workspace.blocks, ['blocks', 'languageVersion']) && Array.isArray(workspace.blocks.blocks) &&
    workspace.blocks.blocks.every((block: any) => block && skeletonTypes.has(block.type) &&
      keysWithin(block, ['id', 'type', 'x', 'y', 'deletable', 'movable', 'editable', 'collapsed', 'inputs', 'fields']) &&
      !Object.keys(block.fields ?? {}).length && !Object.keys(block.inputs ?? {}).length);
  const document: any = baseline.document;
  if (!emptyWorkspace(baseline.workspace) || baseline.contracts.symbolTables?.length) return [];
  // Only the native, protected blank sketch is a reset boundary. An arbitrary
  // empty workspace may intentionally hold standalone user-created models.
  const roots = baseline.workspace.blocks.blocks;
  if (roots.length !== 3 || new Set(roots.map(block => block.type)).size !== 3 ||
    roots.some(block => block['deletable'] !== false)) return [];
  if (![...walkAbsRawSyntax(readAbsSyntax(source))].some(({ node }) => !skeletonTypes.has(node.type))) return [];
  if (Array.isArray(document?.pages)) {
    if (!document.pages.length || !document.sharedModel ||
      !keysWithin(document, ['$ailyProjectData', 'schemaVersion', 'activePageId', 'openedPageIds', 'pages', 'sharedModel']) ||
      document.$ailyProjectData && (!keysWithin(document.$ailyProjectData, ['schemaVersion', 'mode']) ||
        document.$ailyProjectData.schemaVersion !== 1 || document.$ailyProjectData.mode !== 'external-only') ||
      !keysWithin(document.sharedModel, ['variables', 'procedureBlocks']) || document.sharedModel.procedureBlocks?.length ||
      document.pages.some((page: any) => !keysWithin(page, ['id', 'title', 'content', 'viewState']) || !emptyWorkspace(page.content))) return [];
  } else if (!emptyWorkspace(document)) return [];
  const models = candidate['variables'];
  if (!Array.isArray(models)) return [];
  // An opaque model may refer to another model; retain the whole table in that case.
  if (models.some(model => !model || !keysWithin(model, ['id', 'name', 'type']))) return [];
  const retired = models.filter(model => model && keysWithin(model, ['id', 'name', 'type']) &&
    typeof model.id === 'string' && typeof model.name === 'string' &&
    (model.type === undefined || typeof model.type === 'string'));
  const ids = new Set(retired.map(model => model.id));
  candidate['variables'] = models.filter(model => !ids.has(model?.id));
  return [...ids];
}
