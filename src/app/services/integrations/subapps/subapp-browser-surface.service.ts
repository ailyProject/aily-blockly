import { Injectable } from '@angular/core';
import { getChildToolConfig } from '../../../configs/tool.config';
import { ChildToolProcessService, type ChildToolHostInfo } from './child-tool-process.service';
import { SubappOwnerGuard } from './models/subapp-owner-guard';

export interface SubappBrowserSurfaceBounds { x: number; y: number; width: number; height: number; }
export interface SubappBrowserSurfaceGeometry { bounds: SubappBrowserSurfaceBounds; visible: boolean; }
export interface SubappBrowserSurfaceReady {
  hostInfo: ChildToolHostInfo; ownerSessionId: string; runtimeId: string; connectionId: string;
}
export interface SubappBrowserSurfaceHandle {
  readonly ownerSessionId: string;
  readonly ready: Promise<SubappBrowserSurfaceReady>;
  update(geometry: SubappBrowserSurfaceGeometry): Promise<void>;
  close(): Promise<Record<string, unknown>>;
}
interface SurfaceRecord {
  toolId: string; ownerSessionId: string; processAcquired: boolean; ownerTracked: boolean;
  runtimeId?: string; connectionId?: string; viewClosed: boolean; ownerReleased: boolean; closing: boolean;
  starting: Promise<SubappBrowserSurfaceReady>; updating: Promise<void>; cleanup?: Promise<Record<string, unknown>>;
  receipt?: Record<string, unknown>;
}

/** Owns only presentation resources. It neither creates MCU sessions nor owns
 * Agent work. Failed cleanup stays registered for an explicit retry. */
@Injectable({ providedIn: 'root' })
export class SubappBrowserSurfaceService {
  private readonly guard = new SubappOwnerGuard();
  private readonly surfaces = new Map<string, SurfaceRecord>();

  constructor(private readonly processService: ChildToolProcessService) {}

  open(toolId: string, geometry: SubappBrowserSurfaceGeometry): SubappBrowserSurfaceHandle {
    const config = getChildToolConfig(toolId);
    if (!config?.runtime?.browserExecution || !config.ui?.surfaces?.['full']?.entry) {
      throw new Error('The Subapp does not declare a full Browser execution surface');
    }
    const ownerSessionId = `ui-${crypto.randomUUID()}`;
    const record: SurfaceRecord = { toolId, ownerSessionId, processAcquired: false, ownerTracked: false,
      closing: false, viewClosed: false, ownerReleased: false, starting: undefined!, updating: Promise.resolve() };
    this.surfaces.set(ownerSessionId, record);
    const current = () => { if (record.closing) throw new Error('Browser surface closed during startup'); };
    record.starting = Promise.resolve().then(async () => {
      current(); const hostInfo = await this.processService.acquire(toolId); record.processAcquired = true; current();
      record.ownerTracked = true; await this.guard.track(toolId, ownerSessionId); current();
      const bound = await this.guard.browserExecution(toolId, ownerSessionId);
      record.runtimeId = bound.browserExecution.endpoint.runtimeId; current();
      const view = await this.guard.browserView('openView', toolId, ownerSessionId, {
        runtimeId: record.runtimeId, surface: 'full', presentation: 'embedded', ...geometry,
      });
      if (view['executionId'] !== record.runtimeId || typeof view['connectionId'] !== 'string'
        || !/^[a-f0-9-]{36}$/.test(view['connectionId'])
        || view['presentation'] !== 'embedded') throw new Error('Invalid embedded Browser View identity');
      record.connectionId = view['connectionId']; current();
      return { hostInfo, ownerSessionId, runtimeId: record.runtimeId, connectionId: record.connectionId };
    });
    const ready = record.starting.catch(async error => {
      try { await this.close(record); } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Browser surface startup and cleanup remain unconfirmed');
      }
      throw error;
    });
    return { ownerSessionId, ready,
      update: value => this.update(record, value), close: () => this.close(record) };
  }

  /** Explicit recovery keeps the original owner/Runtime identities. */
  retryClose(ownerSessionId: string): Promise<Record<string, unknown>> {
    const record = this.surfaces.get(ownerSessionId);
    return record ? this.close(record) : Promise.resolve({ released: true });
  }

  private update(record: SurfaceRecord, geometry: SubappBrowserSurfaceGeometry): Promise<void> {
    if (record.closing) return Promise.resolve();
    const pending = record.updating.catch(() => undefined).then(async () => {
      if (record.closing) return;
      await record.starting; if (record.closing) return;
      const result = await this.guard.browserView('updateView', record.toolId, record.ownerSessionId, {
        runtimeId: record.runtimeId, connectionId: record.connectionId, ...geometry,
      });
      if (result['updated'] !== true) throw new Error('Browser View geometry was not accepted');
    });
    record.updating = pending; return pending;
  }

  private close(record: SurfaceRecord): Promise<Record<string, unknown>> {
    record.closing = true;
    if (record.receipt) return Promise.resolve(record.receipt);
    if (record.cleanup) return record.cleanup;
    const pending = Promise.resolve().then(async () => {
      await record.starting.catch(() => undefined); await record.updating.catch(() => undefined);
      if (record.connectionId && !record.viewClosed) {
        const detached = await this.guard.browserView('closeView', record.toolId, record.ownerSessionId, {
          runtimeId: record.runtimeId, connectionId: record.connectionId,
        });
        if (detached['detached'] !== true || detached['physicalClosed'] !== true) throw new Error('Browser View close remains unconfirmed');
        record.viewClosed = true;
      }
      let receipt: Record<string, unknown> = { released: true };
      if (record.ownerTracked && !record.ownerReleased) {
        if (record.runtimeId) {
          receipt = await this.guard.browserView('release', record.toolId, record.ownerSessionId, { runtimeId: record.runtimeId });
          if (receipt['released'] !== true || !Number.isSafeInteger(receipt['refCount']) || Number(receipt['refCount']) < 0
            || (receipt['refCount'] === 0 && (receipt['acknowledged'] !== true || receipt['physicalClosed'] !== true))) {
            throw new Error('Browser execution owner cleanup remains unconfirmed');
          }
        } else {
          // Acquisition may have reached Main without returning an endpoint.
          // The original Supervisor still joins its registered cleanup callbacks.
          await this.guard.release(record.toolId, record.ownerSessionId);
        }
        record.ownerReleased = true;
      }
      if (record.processAcquired) { await this.processService.release(record.toolId); record.processAcquired = false; }
      if (this.surfaces.get(record.ownerSessionId) === record) this.surfaces.delete(record.ownerSessionId);
      record.receipt = receipt;
      return receipt;
    }).finally(() => { if (record.cleanup === pending) record.cleanup = undefined; });
    record.cleanup = pending; return pending;
  }
}
