import type { ChildToolAgentDefinition } from '../configs/tool.config';
import type { SubappActivityPresentation } from './subapp-activity.service';

export type SubappAgentUiMode = 'none' | 'window';

export interface ResolvedSubappAgentPresentation {
  uiMode: SubappAgentUiMode;
  activityPresentation?: SubappActivityPresentation;
}

export function resolveSubappAgentPresentation(
  params: Record<string, unknown>,
  definition: ChildToolAgentDefinition,
): ResolvedSubappAgentPresentation {
  if (Object.prototype.hasOwnProperty.call(params, 'presentUi')) {
    const explicitMode = params['presentUi'];
    if (explicitMode === 'window') {
      return {
        uiMode: 'window',
        activityPresentation: copyPresentation(definition.presentation, 'window'),
      };
    }
    if (explicitMode === 'embedded') {
      return {
        uiMode: 'none',
        activityPresentation: dockPresentation(definition.presentation, true),
      };
    }
    return { uiMode: 'none' };
  }

  const presentation = definition.presentation;
  if (!presentation) return { uiMode: 'none' };

  const condition = presentation.when;
  if (condition && !condition.values.some(value => value === params[condition.param])) {
    return { uiMode: 'none' };
  }

  if (presentation.mode === 'window') {
    return {
      uiMode: 'window',
      activityPresentation: copyPresentation(presentation, 'window'),
    };
  }
  if (presentation.mode === 'embedded') {
    return {
      uiMode: 'none',
      activityPresentation: dockPresentation(presentation, true),
    };
  }
  return {
    uiMode: 'none',
    activityPresentation: dockPresentation(presentation, false),
  };
}

function dockPresentation(
  presentation: ChildToolAgentDefinition['presentation'],
  defaultAutoOpen: boolean,
): SubappActivityPresentation {
  return {
    mode: 'dock',
    ...(typeof presentation?.surface === 'string' ? { surface: presentation.surface } : {}),
    ...(presentation?.autoOpen
      ? { autoOpen: presentation.autoOpen }
      : defaultAutoOpen
        ? { autoOpen: 'always' as const }
        : {}),
  };
}

function copyPresentation(
  presentation: ChildToolAgentDefinition['presentation'],
  mode: 'window',
): SubappActivityPresentation {
  return {
    mode,
    ...(typeof presentation?.surface === 'string' ? { surface: presentation.surface } : {}),
    ...(presentation?.autoOpen ? { autoOpen: presentation.autoOpen } : {}),
  };
}
