import { Injectable } from '@angular/core';
import * as Blockly from 'blockly';
import {
  ArduinoGenerator,
  createArduinoGenerator,
} from '../components/blockly/generators/arduino/arduino';
import {
  MicroPythonGenerator,
  createMicroPythonGenerator,
} from '../components/blockly/generators/micropython/micropython';
import {
  PythonGenerator,
  createPythonGenerator,
} from '../components/blockly/generators/python/python';
import {
  prepareBlocklyProjectDataForCodeGeneration,
  wrapProjectDataGeneratorFunctions,
} from '@domain/project/public-api';

export type BlocklyGeneratorMode = 'arduino' | 'micropython' | 'python';
export type ProjectGenerator = ArduinoGenerator | MicroPythonGenerator | PythonGenerator;

export interface GeneratorRuntimeContext {
  mode: BlocklyGeneratorMode;
  projectPath?: string;
  boardConfig?: unknown;
  packageJson?: unknown;
  projectService?: unknown;
  getWorkspace: () => Blockly.WorkspaceSvg | null;
}

export interface GeneratorLoadResult {
  filePath: string;
  arduinoBlockTypes: string[];
  micropythonBlockTypes: string[];
  pythonBlockTypes: string[];
  globalNames: string[];
}

interface PropertySurfaceSnapshot {
  target: object;
  descriptors: PropertyDescriptorMap;
}

interface RegistrySnapshot {
  extensionSurface?: PropertySurfaceSnapshot;
  propertySurfaces: PropertySurfaceSnapshot[];
  registryTypeMap?: Record<string, PropertyDescriptorMap>;
  contextMenuItems?: Map<string, unknown>;
}

interface RuntimeResources {
  timeouts: Set<number>;
  intervals: Set<number>;
  animationFrames: Set<number>;
  idleCallbacks: Set<number>;
  workspaceListeners: Map<Blockly.Workspace, Set<(event: any) => void>>;
  workspaceFacades: WeakMap<Blockly.Workspace, Blockly.Workspace>;
}

interface RuntimeSession {
  id: string;
  epoch: number;
  active: boolean;
  context: GeneratorRuntimeContext;
  iframe: HTMLIFrameElement;
  realmWindow: Window;
  generator: ProjectGenerator;
  registrySnapshot: RegistrySnapshot;
  resources: RuntimeResources;
  loadedPaths: Set<string>;
}

let activeProjectGenerator: ProjectGenerator | null = null;

export function getActiveProjectGenerator(): ProjectGenerator | null {
  return activeProjectGenerator;
}

/**
 * Cross the asynchronous Project Data barrier while retaining the identity of
 * the project-scoped generator that requested it. A project switch/rebuild can
 * replace the active iframe during any await, so callers must not prepare data
 * first and then look up the global active generator a second time.
 */
export async function runWithPreparedActiveProjectGenerator<T>(
  workspace: Blockly.Workspace,
  operation: (generator: ProjectGenerator) => T,
  projectValue?: unknown,
): Promise<T> {
  const generator = activeProjectGenerator;
  if (!generator) {
    throw new Error('Blockly generator runtime is not active');
  }

  await prepareBlocklyProjectDataForCodeGeneration(workspace, projectValue);
  if (activeProjectGenerator !== generator) {
    throw new Error('Blockly generator runtime changed while Project Data was being prepared');
  }

  // Keep workspaceToCode(), generated artifacts, and mutable source maps in one
  // synchronous runtime-owned phase. The callback must not return a Promise.
  const result = operation(generator);
  if (result && typeof (result as any)?.then === 'function') {
    throw new Error('Active Blockly generator operation must remain synchronous');
  }
  return result;
}

function cloneRuntimeValue<T>(value: T): T {
  if (value === undefined || value === null) {
    return value;
  }
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value);
    } catch {
      // Fall back for values containing functions or host objects.
    }
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

function createSessionId(epoch: number): string {
  const randomPart = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
  return `blockly-runtime-${epoch}-${randomPart}`;
}

@Injectable({ providedIn: 'root' })
export class BlocklyGeneratorRuntimeService {
  private epoch = 0;
  private session: RuntimeSession | null = null;

  activate(context: GeneratorRuntimeContext): ProjectGenerator {
    this.destroy();

    const epoch = ++this.epoch;
    const sessionId = createSessionId(epoch);
    const iframe = document.createElement('iframe');
    iframe.hidden = true;
    iframe.tabIndex = -1;
    iframe.setAttribute('aria-hidden', 'true');
    iframe.setAttribute('data-blockly-generator-runtime', sessionId);
    document.body.appendChild(iframe);

    const realmWindow = iframe.contentWindow;
    if (!realmWindow) {
      iframe.remove();
      throw new Error('Unable to create Blockly generator runtime realm');
    }

    // 模式只在会话创建处决策一次，保证同一项目不会同时持有 Python 与 Arduino 生成器状态。
    const generator = context.mode === 'python'
      ? createPythonGenerator()
      : context.mode === 'micropython'
        ? createMicroPythonGenerator()
        : createArduinoGenerator();
    const session: RuntimeSession = {
      id: sessionId,
      epoch,
      active: true,
      context,
      iframe,
      realmWindow,
      generator,
      registrySnapshot: this.captureHostState(),
      resources: {
        timeouts: new Set<number>(),
        intervals: new Set<number>(),
        animationFrames: new Set<number>(),
        idleCallbacks: new Set<number>(),
        workspaceListeners: new Map<Blockly.Workspace, Set<(event: any) => void>>(),
        workspaceFacades: new WeakMap<Blockly.Workspace, Blockly.Workspace>(),
      },
      loadedPaths: new Set<string>(),
    };

    this.session = session;
    activeProjectGenerator = generator;
    this.installRealmBridge(session);
    return generator;
  }

  getActiveGenerator(): ProjectGenerator | null {
    return this.session?.active ? this.session.generator : null;
  }

  rebuild(
    context: Partial<Omit<GeneratorRuntimeContext, 'mode' | 'getWorkspace'>> = {},
  ): ProjectGenerator {
    const currentContext = this.requireActiveSession().context;
    return this.activate({ ...currentContext, ...context });
  }

  isActive(): boolean {
    return !!this.session?.active;
  }

  /**
   * Refreshes the host-owned Blockly message values in the active runtime
   * checkpoint without adopting project-library message keys.
   *
   * Blockly locale changes happen outside the project generator iframe. The
   * checkpoint must follow those host changes so a later runtime rebuild does
   * not restore an older locale. Only keys that already belong to the host
   * checkpoint are updated; generator-owned additions are still removed when
   * the runtime is destroyed.
   */
  refreshBlocklyMessageSnapshot(): void {
    const session = this.session;
    if (!session?.active) {
      return;
    }

    const messageSurface = session.registrySnapshot.propertySurfaces
      .find((surface) => surface.target === Blockly.Msg);
    if (!messageSurface) {
      return;
    }

    for (const key of Object.keys(messageSurface.descriptors)) {
      const descriptor = Object.getOwnPropertyDescriptor(Blockly.Msg, key);
      if (descriptor) {
        messageSurface.descriptors[key] = descriptor;
      }
    }
  }

  updateContext(context: Partial<Omit<GeneratorRuntimeContext, 'mode' | 'getWorkspace'>>): void {
    const session = this.requireActiveSession();
    session.context = { ...session.context, ...context };
    this.publishContextToRealm(session);
  }

  updateBoardConfig(boardConfig: unknown): void {
    this.updateContext({ boardConfig });
  }

  markReady(projectPath?: string): void {
    const session = this.requireActiveSession();
    session.iframe.setAttribute('data-runtime-ready', 'true');
    session.iframe.setAttribute('data-runtime-project-path', projectPath || session.context.projectPath || '');
  }

  setLibraryI18n(packageName: string, value: unknown): void {
    const session = this.requireActiveSession();
    const realm = session.realmWindow as unknown as Record<string, any>;
    realm['__BLOCKLY_LIB_I18N__'][packageName] = cloneRuntimeValue(value);
  }

  loadGenerator(filePath: string, source: string): GeneratorLoadResult {
    const session = this.requireActiveSession();
    if (session.loadedPaths.has(filePath)) {
      return this.describeLoadedGenerator(session, filePath, []);
    }

    const globalsBefore = new Set(Reflect.ownKeys(session.realmWindow).map(String));
    let scriptError: ErrorEvent | null = null;
    const errorHandler = (event: ErrorEvent) => {
      scriptError = event;
      event.preventDefault();
    };
    session.realmWindow.addEventListener('error', errorHandler);

    try {
      const script = session.realmWindow.document.createElement('script');
      script.type = 'text/javascript';
      script.setAttribute('data-generator-path', filePath);
      const normalizedPath = filePath.replace(/\\/g, '/').replace(/[\r\n]/g, '');
      const safeSourceUrl = normalizedPath.startsWith('/')
        ? `file://${normalizedPath}`
        : `file:///${normalizedPath}`;
      script.textContent = `${source}\n//# sourceURL=${safeSourceUrl}`;
      session.realmWindow.document.head.appendChild(script);
    } finally {
      session.realmWindow.removeEventListener('error', errorHandler);
    }

    if (scriptError) {
      const captured = scriptError as ErrorEvent;
      this.markFailed(session);
      const detail = captured.error?.stack || captured.message || 'Unknown generator error';
      throw new Error(`Generator loading failed: ${filePath}\n${detail}`);
    }

    session.loadedPaths.add(filePath);
    const globalNames = Reflect.ownKeys(session.realmWindow)
      .map(String)
      .filter((name) => !globalsBefore.has(name));
    const result = this.describeLoadedGenerator(session, filePath, globalNames);

    // Generator scripts now live in the project iframe, so Project Data's
    // legacy-field projection must be installed at this runtime boundary. This
    // keeps read-only libraries working even when callers/loaders evolve.
    wrapProjectDataGeneratorFunctions(session.generator, [
      ...result.arduinoBlockTypes,
      ...result.micropythonBlockTypes,
      ...result.pythonBlockTypes,
    ]);
    return result;
  }

  invokeGlobal<T = unknown>(name: string, ...args: unknown[]): T | undefined {
    const session = this.requireActiveSession();
    const candidate = (session.realmWindow as unknown as Record<string, unknown>)[name];
    if (typeof candidate !== 'function') {
      return undefined;
    }
    const bridgedArgs = args.map((value) => value instanceof Blockly.Workspace
      ? this.getWorkspaceFacade(session, value)
      : value);
    return Reflect.apply(candidate as (...values: unknown[]) => T, session.realmWindow, bridgedArgs);
  }

  destroy(): void {
    const session = this.session;
    if (!session) {
      return;
    }

    session.active = false;
    this.clearResources(session);
    this.restoreHostState(session.registrySnapshot);
    session.loadedPaths.clear();
    session.iframe.remove();
    if (activeProjectGenerator === session.generator) {
      activeProjectGenerator = null;
    }
    this.session = null;
  }

  private requireActiveSession(): RuntimeSession {
    if (!this.session?.active) {
      throw new Error('Blockly generator runtime is not active');
    }
    return this.session;
  }

  private isCurrent(session: RuntimeSession): boolean {
    return this.session === session && session.active && this.session.epoch === session.epoch;
  }

  private markFailed(session: RuntimeSession): void {
    session.active = false;
    this.clearResources(session);
  }

  private installRealmBridge(session: RuntimeSession): void {
    const realm = session.realmWindow as unknown as Record<string, any>;
    const blocklyFacade = new Proxy(Object.create(null), {
      get: (_target, key) => {
        if (!this.isCurrent(session)) {
          throw new Error(`Blockly generator session ${session.id} is inactive`);
        }
        if (key === 'getMainWorkspace') {
          return () => {
            const workspace = session.context.getWorkspace();
            return workspace ? this.getWorkspaceFacade(session, workspace) : null;
          };
        }
        return Reflect.get(Blockly, key);
      },
      has: (_target, key) => Reflect.has(Blockly, key),
      ownKeys: () => Reflect.ownKeys(Blockly),
      getOwnPropertyDescriptor: (_target, key) => {
        const descriptor = Reflect.getOwnPropertyDescriptor(Blockly, key);
        return descriptor ? { ...descriptor, configurable: true } : undefined;
      },
    });

    realm['Blockly'] = blocklyFacade;
    realm['global'] = session.realmWindow;
    // 库脚本仅能看到当前模式的生成器全局，阻止 Linux/Python 与 Arduino handler 交叉注册。
    realm['Arduino'] = session.context.mode === 'arduino' ? session.generator : undefined;
    realm['MPY'] = session.context.mode === 'micropython' ? session.generator : undefined;
    realm['MicropPython'] = session.context.mode === 'micropython' ? session.generator : undefined;
    realm['Python'] = session.context.mode === 'python' ? session.generator : undefined;
    realm['pinyinPro'] = (globalThis as Record<string, unknown>)['pinyinPro'];
    realm['__BLOCKLY_LIB_I18N__'] = Object.create(null);

    this.installTimerBridge(session, realm);
    this.publishContextToRealm(session);
  }

  private publishContextToRealm(session: RuntimeSession): void {
    const realm = session.realmWindow as unknown as Record<string, any>;
    realm['boardConfig'] = cloneRuntimeValue(session.context.boardConfig);
    realm['packageJson'] = cloneRuntimeValue(session.context.packageJson);
    realm['projectService'] = this.createProjectServiceFacade(session);
  }

  private createProjectServiceFacade(session: RuntimeSession): unknown {
    const service = session.context.projectService as Record<string, unknown> | undefined;
    if (!service) {
      return undefined;
    }
    return new Proxy(Object.create(null), {
      get: (_target, key) => {
        if (!this.isCurrent(session)) {
          throw new Error(`Blockly generator session ${session.id} is inactive`);
        }
        const value = service[key as string];
        if (typeof value !== 'function') {
          return value;
        }
        return (...args: unknown[]) => {
          if (!this.isCurrent(session)) {
            return undefined;
          }
          return Reflect.apply(value as (...values: unknown[]) => unknown, service, args);
        };
      },
    });
  }

  private installTimerBridge(session: RuntimeSession, realm: Record<string, any>): void {
    realm['setTimeout'] = (callback: (...args: unknown[]) => void, delay = 0, ...args: unknown[]) => {
      const id = window.setTimeout(() => {
        session.resources.timeouts.delete(id);
        if (this.isCurrent(session)) {
          callback(...args);
        }
      }, delay);
      session.resources.timeouts.add(id);
      return id;
    };
    realm['clearTimeout'] = (id: number) => {
      session.resources.timeouts.delete(id);
      window.clearTimeout(id);
    };
    realm['setInterval'] = (callback: (...args: unknown[]) => void, delay = 0, ...args: unknown[]) => {
      const id = window.setInterval(() => {
        if (this.isCurrent(session)) {
          callback(...args);
        }
      }, delay);
      session.resources.intervals.add(id);
      return id;
    };
    realm['clearInterval'] = (id: number) => {
      session.resources.intervals.delete(id);
      window.clearInterval(id);
    };
    realm['requestAnimationFrame'] = (callback: FrameRequestCallback) => {
      const id = window.requestAnimationFrame((time) => {
        session.resources.animationFrames.delete(id);
        if (this.isCurrent(session)) {
          callback(time);
        }
      });
      session.resources.animationFrames.add(id);
      return id;
    };
    realm['cancelAnimationFrame'] = (id: number) => {
      session.resources.animationFrames.delete(id);
      window.cancelAnimationFrame(id);
    };

    const requestIdle = (window as any).requestIdleCallback as ((callback: IdleRequestCallback) => number) | undefined;
    const cancelIdle = (window as any).cancelIdleCallback as ((id: number) => void) | undefined;
    if (requestIdle) {
      realm['requestIdleCallback'] = (callback: IdleRequestCallback) => {
        const id = requestIdle((deadline) => {
          session.resources.idleCallbacks.delete(id);
          if (this.isCurrent(session)) {
            callback(deadline);
          }
        });
        session.resources.idleCallbacks.add(id);
        return id;
      };
      realm['cancelIdleCallback'] = (id: number) => {
        session.resources.idleCallbacks.delete(id);
        cancelIdle?.(id);
      };
    }
    realm['queueMicrotask'] = (callback: () => void) => {
      window.queueMicrotask(() => {
        if (this.isCurrent(session)) {
          callback();
        }
      });
    };
  }

  private getWorkspaceFacade(session: RuntimeSession, workspace: Blockly.Workspace): Blockly.Workspace {
    const existing = session.resources.workspaceFacades.get(workspace);
    if (existing) {
      return existing;
    }

    const facade = new Proxy(workspace, {
      get: (target, key) => {
        if (key === 'addChangeListener') {
          return (listener: (event: any) => void) => {
            if (!this.isCurrent(session)) {
              return listener;
            }
            let listeners = session.resources.workspaceListeners.get(target);
            if (!listeners) {
              listeners = new Set<(event: any) => void>();
              session.resources.workspaceListeners.set(target, listeners);
            }
            listeners.add(listener);
            return target.addChangeListener(listener);
          };
        }
        if (key === 'removeChangeListener') {
          return (listener: (event: any) => void) => {
            session.resources.workspaceListeners.get(target)?.delete(listener);
            return target.removeChangeListener(listener);
          };
        }

        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
      set: (target, key, value) => Reflect.set(target, key, value, target),
    });
    session.resources.workspaceFacades.set(workspace, facade);
    session.resources.workspaceListeners.set(workspace, new Set());
    return facade;
  }

  private clearResources(session: RuntimeSession): void {
    session.resources.timeouts.forEach((id) => window.clearTimeout(id));
    session.resources.intervals.forEach((id) => window.clearInterval(id));
    session.resources.animationFrames.forEach((id) => window.cancelAnimationFrame(id));
    const cancelIdle = (window as any).cancelIdleCallback as ((id: number) => void) | undefined;
    session.resources.idleCallbacks.forEach((id) => cancelIdle?.(id));
    session.resources.timeouts.clear();
    session.resources.intervals.clear();
    session.resources.animationFrames.clear();
    session.resources.idleCallbacks.clear();
    session.resources.workspaceListeners.forEach((trackedListeners, workspace) => {
      trackedListeners.forEach((listener) => workspace.removeChangeListener(listener));

      // Block extensions can register listeners through parent-side Blockly
      // methods and bypass the facade. Remove any callback whose Function Realm
      // belongs to the retiring iframe before that Realm becomes inactive.
      const listeners = (workspace as any).listeners;
      if (Array.isArray(listeners)) {
        const RealmFunction = (session.realmWindow as any).Function;
        [...listeners].forEach((listener) => {
          if (typeof listener === 'function' && RealmFunction && listener instanceof RealmFunction) {
            workspace.removeChangeListener(listener);
          }
        });
      }
    });
    session.resources.workspaceListeners.clear();
  }

  private captureHostState(): RegistrySnapshot {
    const extensions = (Blockly.Extensions as any).TEST_ONLY?.allExtensions as object | undefined;
    const typeMap = (Blockly.registry as any).TEST_ONLY?.typeMap as Record<string, object> | undefined;
    const registeredItems = (Blockly.ContextMenuRegistry as any).registry?.registeredItems as Map<string, unknown> | undefined;
    const prototypes = [
      (Blockly.Field as any)?.prototype,
      (Blockly.FieldDropdown as any)?.prototype,
      (Blockly.Block as any)?.prototype,
      (Blockly.BlockSvg as any)?.prototype,
      (Blockly.Workspace as any)?.prototype,
      (Blockly.WorkspaceSvg as any)?.prototype,
    ].filter((value): value is object => !!value);

    const registryTypeMap = typeMap
      ? Object.fromEntries(Object.entries(typeMap).map(([type, bucket]) => [type, Object.getOwnPropertyDescriptors(bucket)]))
      : undefined;

    return {
      extensionSurface: extensions ? this.captureSurface(extensions) : undefined,
      propertySurfaces: [Blockly.Blocks, Blockly.Msg, ...prototypes].map((target) => this.captureSurface(target)),
      registryTypeMap,
      contextMenuItems: registeredItems ? new Map(registeredItems) : undefined,
    };
  }

  private captureSurface(target: object): PropertySurfaceSnapshot {
    return { target, descriptors: Object.getOwnPropertyDescriptors(target) };
  }

  private restoreHostState(snapshot: RegistrySnapshot): void {
    for (const surface of snapshot.propertySurfaces) {
      this.restoreSurface(surface);
    }
    if (snapshot.extensionSurface) {
      this.restoreSurface(snapshot.extensionSurface);
    }

    const typeMap = (Blockly.registry as any).TEST_ONLY?.typeMap as Record<string, object> | undefined;
    if (typeMap && snapshot.registryTypeMap) {
      for (const type of Object.keys(typeMap)) {
        if (!(type in snapshot.registryTypeMap)) {
          delete typeMap[type];
        }
      }
      for (const [type, descriptors] of Object.entries(snapshot.registryTypeMap)) {
        const bucket = typeMap[type] || (typeMap[type] = Object.create(null));
        this.restoreSurface({ target: bucket, descriptors });
      }
    }

    const registeredItems = (Blockly.ContextMenuRegistry as any).registry?.registeredItems as Map<string, unknown> | undefined;
    if (registeredItems && snapshot.contextMenuItems) {
      registeredItems.clear();
      snapshot.contextMenuItems.forEach((value, key) => registeredItems.set(key, value));
    }
  }

  private restoreSurface(surface: PropertySurfaceSnapshot): void {
    const expectedKeys = new Set(Reflect.ownKeys(surface.descriptors));
    for (const key of Reflect.ownKeys(surface.target)) {
      if (!expectedKeys.has(key)) {
        Reflect.deleteProperty(surface.target, key);
      }
    }
    Object.defineProperties(surface.target, surface.descriptors);
  }

  private describeLoadedGenerator(
    session: RuntimeSession,
    filePath: string,
    globalNames: string[],
  ): GeneratorLoadResult {
    const arduino = (session.realmWindow as any).Arduino;
    const micropython = (session.realmWindow as any).MPY || (session.realmWindow as any).MicropPython;
    const python = (session.realmWindow as any).Python;
    return {
      filePath,
      arduinoBlockTypes: arduino?.forBlock ? Object.keys(arduino.forBlock) : [],
      micropythonBlockTypes: micropython?.forBlock ? Object.keys(micropython.forBlock) : [],
      pythonBlockTypes: python?.forBlock ? Object.keys(python.forBlock) : [],
      globalNames,
    };
  }
}
