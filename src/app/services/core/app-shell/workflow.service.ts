import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';

export enum ProcessState {
  IDLE = 'IDLE',
  INSTALLING = 'INSTALLING',
  BUILDING = 'BUILDING',
  UPLOADING = 'UPLOADING',
  ERROR = 'ERROR'
}

@Injectable({
  providedIn: 'root'
})
export class WorkflowService {
  private _state = new BehaviorSubject<ProcessState>(ProcessState.IDLE);
  public state$ = this._state.asObservable();

  private _error = new BehaviorSubject<string | null>(null);
  public error$ = this._error.asObservable();

  constructor() {}

  get currentState(): ProcessState {
    return this._state.value;
  }

  // IDLE -> INSTALLING
  startInstall(): boolean {
    if (this.currentState === ProcessState.IDLE || this.currentState === ProcessState.ERROR) {
      this._error.next(null);
      this._state.next(ProcessState.INSTALLING);
      return true;
    } else {
      console.warn(`Cannot start install from state: ${this.currentState}`);
      return false;
    }
  }

  // INSTALLING -> IDLE or ERROR
  finishInstall(success: boolean, errorMsg?: string) {
    if (this.currentState === ProcessState.INSTALLING) {
      if (success) {
        this._state.next(ProcessState.IDLE);
      } else {
        this._error.next(errorMsg || 'Installation failed');
        this._state.next(ProcessState.ERROR);
      }
    } else {
      console.warn(`Cannot finish install from state: ${this.currentState}`);
    }
  }

  // IDLE -> BUILDING
  startBuild(): boolean {
    if (this.currentState === ProcessState.IDLE || this.currentState === ProcessState.ERROR) {
      this._error.next(null);
      this._state.next(ProcessState.BUILDING);
      return true;
    } else {
      console.warn(`Cannot start build from state: ${this.currentState}`);
      return false;
    }
  }

  // BUILDING -> IDLE or ERROR
  finishBuild(success: boolean, errorMsg?: string) {
    if (this.currentState === ProcessState.BUILDING) {
      if (success) {
        this._state.next(ProcessState.IDLE);
      } else {
        this._error.next(errorMsg || 'Build failed');
        this._state.next(ProcessState.ERROR);
      }
    } else {
      console.warn(`Cannot finish build from state: ${this.currentState}`);
    }
  }

  // IDLE -> UPLOADING
  startUpload(): boolean {
    if (this.currentState === ProcessState.IDLE || this.currentState === ProcessState.ERROR) {
      this._error.next(null);
      this._state.next(ProcessState.UPLOADING);
      return true;
    } else {
      console.warn(`Cannot start upload from state: ${this.currentState}`);
      return false;
    }
  }

  // UPLOADING -> IDLE or ERROR
  finishUpload(success: boolean, errorMsg?: string) {
    if (this.currentState === ProcessState.UPLOADING) {
      if (success) {
        this._state.next(ProcessState.IDLE);
      } else {
        this._error.next(errorMsg || 'Upload failed');
        this._state.next(ProcessState.ERROR);
      }
    } else {
      console.warn(`Cannot finish upload from state: ${this.currentState}`);
    }
  }

  // ERROR -> IDLE
  reset() {
    if (this.currentState === ProcessState.ERROR) {
      this._error.next(null);
      this._state.next(ProcessState.IDLE);
    } else {
      console.warn(`Cannot reset from state: ${this.currentState}`);
    }
  }
}
