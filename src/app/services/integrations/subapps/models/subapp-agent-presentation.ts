import type { ChildToolAgentDefinition } from '../../../../configs/tool.config';
import type { SubappActivityPresentation } from '../subapp-activity.service';

export type SubappAgentUiMode = 'none' | 'window';

export interface ResolvedSubappAgentPresentation {
  uiMode: SubappAgentUiMode;
  activityPresentation?: SubappActivityPresentation;
}

export function resolveSubappAgentPresentation(
  params: Record<string, unknown>,
  definition: ChildToolAgentDefinition,
  activeMode?: 'window',
): ResolvedSubappAgentPresentation {
  const presentation = definition.presentation;
  const condition = presentation?.when;
  // `when` is the presentation eligibility boundary, including for explicit
  // presentUi values. A cleanup/status call must never reopen a child surface
  // merely because the model repeated the open-call arguments.
  if (condition && !condition.values.some(value => value === params[condition.param])) {
    return { uiMode: 'none' };
  }

  if (Object.prototype.hasOwnProperty.call(params, 'presentUi')) {
    const explicitMode = params['presentUi'];
    if (explicitMode === true && presentation) {
      return resolveDeclaredPresentation(presentation);
    }
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

  // A visible independent window is an authoritative host surface choice.
  // Do not let a later semantic open that omitted presentUi re-apply the
  // manifest's Dock default and create a second UI for the shared runtime.
  if (activeMode === 'window' && presentation) {
    return {
      uiMode: 'window',
      activityPresentation: copyPresentation(definition.presentation, 'window'),
    };
  }

  if (!presentation) return { uiMode: 'none' };

  return resolveDeclaredPresentation(presentation);
}

function resolveDeclaredPresentation(
  presentation: NonNullable<ChildToolAgentDefinition['presentation']>,
): ResolvedSubappAgentPresentation {
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
