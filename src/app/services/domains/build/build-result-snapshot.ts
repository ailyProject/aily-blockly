export interface BuildCheckpoint {
  startedAt?: number;
  inputCapturedAt?: number;
}

export interface BuildResultSnapshot {
  version: 1;
  projectPath: string;
  finishedAt: number;
  success: boolean;
  state: string;
  source: 'manual' | 'ai' | 'system';
  checkpoint?: BuildCheckpoint;
  previousCheckpoint?: BuildCheckpoint;
  message: string;
  fullStdErr: string;
}

/** Retain the actual completed build result independently of the rolling log. */
export function persistBuildResult(
  projectPath: string,
  success: boolean,
  result?: { state?: string; text?: string; fullStdErr?: string },
  error?: { state?: string; text?: string; message?: string; fullStdErr?: string },
  checkpoint?: BuildCheckpoint,
  source: BuildResultSnapshot['source'] = 'system',
): void {
  const snapshot: BuildResultSnapshot = {
    version: 1,
    projectPath,
    finishedAt: Date.now(),
    success,
    state: result?.state || error?.state || (success ? 'done' : 'error'),
    source,
    ...(checkpoint?.startedAt ? { checkpoint } : {}),
    message: result?.text || error?.text || error?.message || '',
    fullStdErr: result?.fullStdErr || error?.fullStdErr || '',
  };

  try {
    const directory = window['path'].join(projectPath, '.log', 'compile');
    const destination = window['path'].join(directory, 'latest-result.json');
    const temporary = `${destination}.tmp`;
    if (window['fs'].existsSync(destination)) {
      try {
        const previous = JSON.parse(window['fs'].readFileSync(destination, 'utf8'));
        if (previous?.checkpoint?.startedAt) snapshot.previousCheckpoint = previous.checkpoint;
      } catch {
        // A missing/corrupt previous result cannot invalidate this build result.
      }
    }
    window['fs'].mkdirSync(directory, { recursive: true });
    window['fs'].writeFileSync(temporary, JSON.stringify(snapshot), 'utf8');
    window['fs'].renameSync(temporary, destination);
  } catch (error) {
    console.warn('Failed to retain the completed build result:', error);
  }
}
