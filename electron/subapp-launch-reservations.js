'use strict';

const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { performance } = require('node:perf_hooks');
const { fault } = require('./subapp-download');

function createSubappLaunchReservations({ dispatchTimeoutMs = 20000, runtimeGraceMs = 20000 } = {}) {
  const reservations = new Map();
  const starting = new Map();
  const expired = () => fault('SUBAPP_LAUNCH_EXPIRED', 'Subapp launch expired. Open the subapp again to retry.');

  async function prepare(owner, id, select) {
    const token = randomUUID();
    const controller = new AbortController();
    const { signal } = controller;
    let config, lockForDispatch, releaseSelection, stopStream, timer;
    let deadline = Infinity;
    const releaseLock = () => {
      const release = releaseSelection;
      releaseSelection = undefined;
      try { release?.(); }
      catch (error) { console.warn('[subapp-manager] launch lock release failed:', id, error.message); }
    };
    const dispose = (reason, registered = false) => {
      reservations.delete(token);
      if (starting.get(id) === token) starting.delete(id);
      clearTimeout(timer);
      owner.removeListener('destroyed', ownerGone);
      owner.removeListener('render-process-gone', ownerGone);
      owner.removeListener('did-start-navigation', onNavigation);
      controller.abort(reason);
      try {
        if (!registered) stopStream?.();
      } finally {
        releaseLock();
      }
    };
    const ownerGone = () => dispose(fault('SUBAPP_LAUNCH_OWNER_CLOSED', 'Subapp launch owner closed.'));
    const onNavigation = (_event, _url, inPlace, isMainFrame) => {
      if (isMainFrame && !inPlace) ownerGone();
    };
    const expire = () => {
      console.warn('[subapp-manager] launch expired:', id, stopStream ? 'runtime startup' : 'dispatch');
      dispose(expired());
    };
    const arm = (milliseconds) => {
      clearTimeout(timer);
      deadline = performance.now() + milliseconds;
      timer = setTimeout(expire, milliseconds);
      timer.unref();
    };
    const reservation = {
      owner,
      get config() { return config; },
      streamId: null,
      spawned: false,
      finish: dispose,
      canBeSuperseded() { return Boolean(lockForDispatch) && this.streamId === null; },
      assertActive() {
        if (performance.now() >= deadline) expire();
        signal.throwIfAborted();
      },
      bind(streamId, stop) {
        this.streamId = streamId;
        stopStream = stop;
        return {
          ...(lockForDispatch ? { waitForDispatch: async commandSignal => {
            const dispatchSignal = commandSignal ? AbortSignal.any([signal, commandSignal]) : signal;
            dispatchSignal.throwIfAborted();
            const release = await lockForDispatch(dispatchSignal);
            if (typeof release !== 'function') throw new Error('Subapp dispatch lock did not return a release function.');
            releaseSelection = release;
            try {
              this.assertActive();
              dispatchSignal.throwIfAborted();
            } catch (error) {
              releaseLock();
              throw error;
            }
          } } : {}),
          spawned: () => {
            this.spawned = true;
            // The command supervisor owns the exact stream and the running process
            // now protects its files. Readiness and health IPC never hold this lock.
            releaseLock();
            arm((config.startupTimeoutMs || 8000) + runtimeGraceMs);
          },
        };
      },
    };

    owner.once('destroyed', ownerGone);
    owner.once('render-process-gone', ownerGone);
    owner.on('did-start-navigation', onNavigation);
    try {
      if (owner.isDestroyed()) ownerGone();
      // A modern reservation waiting for the renderer owns no package lease.
      // A newer request may replace it, while dispatching and running starts stay serialized.
      while (starting.has(id)) {
        signal.throwIfAborted();
        const previous = reservations.get(starting.get(id));
        if (previous?.canBeSuperseded()) {
          previous.finish(fault('SUBAPP_LAUNCH_SUPERSEDED', 'A newer request opened this subapp.'));
          break;
        }
        await delay(50, undefined, { signal });
      }
      signal.throwIfAborted();
      starting.set(id, token);
      ({ config, release: releaseSelection, lockForDispatch } = await select(signal));
      signal.throwIfAborted();
      if (lockForDispatch) releaseLock();
      else arm(dispatchTimeoutMs);
      signal.throwIfAborted();
      reservations.set(token, reservation);
      return { config, token };
    } catch (error) {
      dispose(error);
      throw signal.reason;
    }
  }

  function active(token, owner) {
    const reservation = reservations.get(token);
    if (!reservation || reservation.owner !== owner) throw expired();
    reservation.assertActive();
    return reservation;
  }

  function bindCommand(token, owner, streamId, options, stop) {
    const reservation = active(token, owner);
    const { config } = reservation;
    if (reservation.streamId || options.command !== 'node'
      || options.cwd !== config.packagePath
      || options.args?.[0] !== path.join(config.packagePath, config.entry || 'index.js')
      || options.env?.AILY_CHILD_TOOL_ID !== config.id) throw expired();
    return { id: config.id, ...reservation.bind(streamId, stop) };
  }

  function checkRegistration(token, owner, payload) {
    const reservation = active(token, owner);
    if (!reservation.spawned || reservation.streamId !== payload.streamId
      || reservation.config.id !== payload.toolId
      || reservation.config.packagePath !== payload.hostInfo?.packagePath) throw expired();
    return () => reservation.finish(undefined, true);
  }

  function finish(token, owner) {
    const reservation = reservations.get(token);
    if (reservation?.owner === owner) reservation.finish(expired());
  }

  return { prepare, bindCommand, checkRegistration, finish };
}

module.exports = { createSubappLaunchReservations, subappLaunches: createSubappLaunchReservations() };
