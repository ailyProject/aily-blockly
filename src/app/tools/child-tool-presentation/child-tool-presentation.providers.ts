import { InjectionToken, type Type } from '@angular/core';
import type { ChildToolWebAppMetadata } from './child-tool-web-apps';

export interface ChildToolPresentationInputs {
  readonly toolId: string;
  readonly active: boolean;
}

export interface ChildToolWebPresentation {
  readonly app?: ChildToolWebAppMetadata;
  load(): Promise<Type<unknown>>;
  inputs?(context: ChildToolPresentationInputs): Record<string, unknown>;
}

/** Application composition supplies static presentation descriptors. A page or
 * project document cannot select executable modules or a desktop fallback. */
export const CHILD_TOOL_WEB_PRESENTATIONS = new InjectionToken<Readonly<Record<string, ChildToolWebPresentation>>>(
  'CHILD_TOOL_WEB_PRESENTATIONS', { providedIn: 'root', factory: () => Object.freeze({}) });

export const CHILD_TOOL_PRESENTATION_PLATFORM = new InjectionToken<'native' | 'web'>(
  'CHILD_TOOL_PRESENTATION_PLATFORM', { providedIn: 'root', factory: () => 'web' });

/** Per-tool choices come from trusted application composition. Unspecified
 * tools retain the environment's existing presentation and lifecycle. */
export const CHILD_TOOL_PRESENTATION_OVERRIDES = new InjectionToken<Readonly<Record<string, 'native' | 'web'>>>(
  'CHILD_TOOL_PRESENTATION_OVERRIDES', { providedIn: 'root', factory: () => Object.freeze({}) });

/** The application supplies the original desktop component lazily, keeping the
 * Browser presentation entry independent of the installed runtime closure. */
export const CHILD_TOOL_NATIVE_PRESENTATION = new InjectionToken<(() => Promise<Type<unknown>>) | null>(
  'CHILD_TOOL_NATIVE_PRESENTATION', { providedIn: 'root', factory: () => null });
