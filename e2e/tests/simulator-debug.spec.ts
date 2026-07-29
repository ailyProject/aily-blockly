import {
  expect,
  getMainWindow,
  navigate,
  openBlocklyProject,
  ROOT,
  test,
} from '../fixtures/electron-app';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import {
  cp,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

const ENABLED = process.env['AILY_E2E_SIMULATOR_DEBUG'] === '1';
const FIXTURE_ROOT = path.join(
  ROOT,
  'e2e',
  'fixtures',
  'projects',
  'esp32s3-debug',
);
const ARTIFACT_ROOT = path.join(ROOT, 'e2e', '.artifacts');
const PROJECT_PATH = path.join(
  ARTIFACT_ROOT,
  'esp32s3-simulator-debug',
);
const PACKAGE_SOURCE = path.resolve(
  process.env['AILY_E2E_ESP32S3_PACKAGE_SOURCE']
  || path.join(ARTIFACT_ROOT, 'esp32s3-package-source'),
);
const BLOCKLY_LIBRARIES_ROOT = path.resolve(
  process.env['AILY_E2E_BLOCKLY_LIBRARIES_ROOT']
  || path.join(ROOT, '..', 'aily-blockly-libraries'),
);
const PREPARATION_REPORT_PATH = path.join(
  ARTIFACT_ROOT,
  'simulator-debug-preparation.json',
);
const E2E_REPORT_PATH = path.resolve(
  process.env['AILY_E2E_SIMULATOR_REPORT']
  || path.join(ARTIFACT_ROOT, 'simulator-debug-report.json'),
);
const SIMULATOR_ROOT = path.resolve(
  process.env['AILY_SIMULATOR_ROOT']
  || path.join(ROOT, '..', 'aily-simulator'),
);
const BREAKPOINT_BLOCK_ID = 'debug-loop-break';
const RUN_TARGET_BLOCK_ID = 'debug-delay-block';
const EDITABLE_NUMBER_BLOCK_ID = 'debug-delay-ms';
const SIMULATOR_IFRAME_ROOT = path.join(
  SIMULATOR_ROOT,
  'dist',
  'aily-simulator',
  'browser',
);
let simulatorIframeServer: Server | null = null;
const PACKAGE_NAMES = [
  'board-xiao_esp32s3',
  'lib-core-io',
  'lib-core-logic',
  'lib-core-loop',
  'lib-core-math',
  'lib-core-serial',
  'lib-core-text',
  'lib-core-time',
  'lib-core-variables',
];

test.describe('ESP32-S3 simulator desktop debug closure', () => {
  test.skip(
    !ENABLED,
    'Requires AILY_E2E_SIMULATOR_DEBUG=1.',
  );
  test.skip(
    !existsSync(path.join(PACKAGE_SOURCE, 'node_modules', '@aily-project')),
    `ESP32-S3 package source is unavailable: ${PACKAGE_SOURCE}`,
  );
  test.skip(
    !existsSync(path.join(
      SIMULATOR_ROOT,
      '.runtime',
      'distribution',
      'aily-simulator-runtime-win32-x64',
      'aily-simulator-runtime.json',
    )),
    `Simulator runtime pack is unavailable: ${SIMULATOR_ROOT}`,
  );

  test.beforeAll(async () => {
    const simulatorIframeUrl = await startSimulatorIframeServer();
    process.env['AILY_E2E_SIMULATOR_IFRAME_URL'] = simulatorIframeUrl;
    await rm(E2E_REPORT_PATH, { force: true });
    await stageProject();
  });

  test.afterEach(async ({}, testInfo) => {
    if (testInfo.status === testInfo.expectedStatus) return;
    await writeJsonAtomic(E2E_REPORT_PATH, {
      schemaVersion: 1,
      kind: 'aily-simulator-debug-e2e-result',
      status: 'failed',
      completedAt: new Date().toISOString(),
      projectPath: PROJECT_PATH,
      preparation: await readJsonIfPresent(PREPARATION_REPORT_PATH),
      errors: testInfo.errors.map((error) => ({
        message: error.message,
        stack: error.stack,
      })),
    });
  });

  test.afterAll(async () => {
    delete process.env['AILY_E2E_SIMULATOR_IFRAME_URL'];
    await closeSimulatorIframeServer();
    await removeInsideArtifactRoot(PROJECT_PATH);
  });

  test(
    'edit -> dirty -> compile -> current -> block breakpoint -> QEMU/GDB hit',
    async ({ electronApp }) => {
      test.setTimeout(15 * 60_000);
      const win = await getMainWindow(electronApp);
      await electronApp.evaluate(({ BrowserWindow }) => {
        const mainWindow = BrowserWindow.getAllWindows().find(
          (candidate) => candidate.isVisible(),
        );
        mainWindow?.webContents.setBackgroundThrottling(false);
        mainWindow?.show();
        mainWindow?.focus();
      });
      await win.bringToFront();
      await openBlocklyProject(win, PROJECT_PATH);

      const breakpointBlock = win.locator(
        `g.blocklyDraggable[data-id="${BREAKPOINT_BLOCK_ID}"]`,
      );
      await expect(breakpointBlock).toBeVisible({ timeout: 90_000 });

      const baselineCompile = await compileAndWait(win);
      const baselineArtifact = baselineCompile.artifact;
      expect(
        baselineArtifact.debug?.sourceMapPath,
        'Baseline compile must emit a Blockly source-map.',
      ).toBeTruthy();
      await expectBreakpointMenuState(win, {
        suffix: '',
        disabled: false,
      });

      const editableField = win.locator(
        `g.blocklyDraggable[data-id="${EDITABLE_NUMBER_BLOCK_ID}"] `
        + '.blocklyEditableText',
      ).first();
      await editableField.click({ force: true });
      const htmlInput = win.locator('input.blocklyHtmlInput');
      await expect(htmlInput).toBeVisible({ timeout: 10_000 });
      await htmlInput.fill('250');
      await htmlInput.press('Enter');

      await expectBreakpointMenuState(win, {
        suffix: /工作区未编译|workspace not built/i,
        disabled: true,
      });

      const rebuiltCompile = await compileAndWait(
        win,
        baselineArtifact.artifactId,
      );
      const rebuiltArtifact = rebuiltCompile.artifact;
      expect(rebuiltArtifact.artifactId).not.toBe(
        baselineArtifact.artifactId,
      );
      expect(rebuiltArtifact.build?.source?.sha256).not.toBe(
        baselineArtifact.build?.source?.sha256,
      );
      await expectBreakpointMenuState(win, {
        suffix: '',
        disabled: false,
      });

      const menuItem = await openBreakpointMenu(win);
      await activateBreakpointMenuItem(win, menuItem);

      const debugConfiguration = await waitForDebugConfiguration(win);
      const sourceMapFile = rebuiltArtifact.files.find(
        (file: Record<string, unknown>) => file['role'] === 'source-map',
      );
      expect(debugConfiguration.breakpoints).toEqual([{
        blockId: BREAKPOINT_BLOCK_ID,
        sourceMapRevision: sourceMapFile.sha256,
        enabled: true,
      }]);
      await expect(
        breakpointBlock.locator(
          'g.aily-project-breakpoint-marker[data-state="enabled"]',
        ),
      ).toBeVisible({ timeout: 10_000 });

      const sourceSnapshotFile = rebuiltArtifact.files.find(
        (file: Record<string, unknown>) => file['role'] === 'debug-source',
      );
      expect(sourceSnapshotFile?.path).toBe(
        rebuiltArtifact.debug?.sourceSnapshotPath,
      );
      expect(sourceSnapshotFile?.sha256).toBe(
        rebuiltArtifact.build?.source?.sha256,
      );
      const runTargetBlock = win.locator(
        `g.blocklyDraggable[data-id="${RUN_TARGET_BLOCK_ID}"]`,
      );
      await expect(runTargetBlock).toBeVisible({ timeout: 30_000 });
      const runTargetOutline = runTargetBlock.locator(
        ':scope > .blocklyPath',
      ).first();
      await runTargetOutline.click({
        button: 'right',
        position: { x: 12, y: 12 },
        force: true,
      });
      const runTargetContextMenu = win.locator('.blocklyContextMenu');
      await expect(runTargetContextMenu).toBeVisible();
      await win.keyboard.press('Escape');
      await expect(runTargetContextMenu).toBeHidden();
      const iframeUart = await verifyIframeUartClosure(
        win,
        electronApp,
        rebuiltArtifact.build.source.sha256,
      );

      await runProcess(
        process.execPath,
        [
          resolveNpmCliPath(),
          'run',
          'gateway:build',
        ],
        SIMULATOR_ROOT,
        180_000,
      );
      const gdbResult = await runProcess(
        process.execPath,
        [
          path.join(
            SIMULATOR_ROOT,
            'scripts',
            'smoke-project-block-debug.mjs',
          ),
          PROJECT_PATH,
          BREAKPOINT_BLOCK_ID,
        ],
        SIMULATOR_ROOT,
        90_000,
      );
      expect(gdbResult.stdout).toContain('"status": "passed"');
      expect(gdbResult.stdout).toContain(
        `"blockId": "${BREAKPOINT_BLOCK_ID}"`,
      );

      const result = {
        schemaVersion: 1,
        kind: 'aily-simulator-debug-e2e-result',
        status: 'passed',
        completedAt: new Date().toISOString(),
        projectPath: PROJECT_PATH,
        preparation: await readJsonIfPresent(PREPARATION_REPORT_PATH),
        builder: {
          command: path.join(
            process.env['LOCALAPPDATA'] || '',
            'aily-project',
            'npm-global',
            process.platform === 'win32'
              ? 'aily-builder.cmd'
              : 'aily-builder',
          ),
          artifactId: rebuiltArtifact.artifactId,
          sourceSha256: rebuiltArtifact.build.source.sha256,
          sourceSnapshotPath: rebuiltArtifact.debug.sourceSnapshotPath,
          sourceSnapshotRole: sourceSnapshotFile.role,
        },
        compiles: {
          baseline: baselineCompile.report,
          rebuilt: rebuiltCompile.report,
        },
        dirtyTransitionVerified: true,
        currentTransitionVerified: true,
        breakpoint: debugConfiguration.breakpoints[0],
        iframeUart,
        gdb: JSON.parse(gdbResult.stdout),
      };
      await writeJsonAtomic(E2E_REPORT_PATH, result);
      console.log(JSON.stringify(result, null, 2));
    },
  );
});

async function verifyCoreIoLedButton(
  frame: import('@playwright/test').FrameLocator,
): Promise<{
  ledPinmapId: 'lib-core-io:led:generic';
  buttonPinmapId: 'lib-core-io:button:generic';
  resistorPinmapId: 'lib-core-io:resistor:generic';
  currentLimitOhms: 220;
  currentLimitAppearanceVisible: true;
  blinkObserved: true;
  buttonPressObserved: true;
  buttonHeldLedOn: true;
  buttonReleaseObserved: true;
  electricalDiagnosticsForwarded: true;
  electricalDiagnosticRecoveryObserved: true;
}> {
  const ledSurface = frame.locator(
    '[data-aily-appearance-id="aily.appearance.gpio-led"]',
  ).first();
  const buttonSurface = frame.locator(
    '[data-aily-appearance-id="aily.appearance.gpio-button"]',
  ).first();
  const resistorSurface = frame.locator(
    '[data-aily-appearance-id="aily.appearance.resistor"]',
  ).first();
  await expect(ledSurface).toBeVisible({ timeout: 30_000 });
  await expect(buttonSurface).toBeVisible({ timeout: 30_000 });
  await expect(resistorSurface).toBeVisible({ timeout: 30_000 });
  await expect(resistorSurface).toHaveAttribute(
    'data-aily-appearance-version',
    '1.0.0',
  );

  const emitter = ledSurface.locator(
    '[data-aily-simulation-view="led-emitter"]',
  );
  const cap = buttonSurface.locator(
    '[data-aily-simulation-view="button-cap"]',
  );
  const hitArea = buttonSurface.locator(
    '[data-aily-slot-id="hit-area"]',
  );
  await expect(emitter).toBeVisible({ timeout: 30_000 });
  await expect(cap).toBeVisible({ timeout: 30_000 });
  await expect(hitArea).toHaveAttribute('role', 'button');
  const electricalDiagnostics = frame.locator(
    '.simulation-electrical-diagnostics',
  );
  await expect(electricalDiagnostics).toHaveAttribute(
    'data-status',
    'info',
    { timeout: 30_000 },
  );
  const initialElectricalRevision = Number(
    await electricalDiagnostics.getAttribute('data-revision'),
  );
  expect(initialElectricalRevision).toBeGreaterThan(0);
  await expect(electricalDiagnostics.locator(
    '[data-code="ELECTRICAL_GPIO_FLOATING"]'
    + '[data-node-id="net-e2e_button_d3"]',
  )).toBeVisible();

  // Released firmware branch blinks board D2 (ESP32-S3 GPIO3). Observe a
  // complete off -> on -> off
  // cycle instead of accepting a static initial snapshot.
  await waitForLocatorAttribute(
    emitter,
    'data-aily-led-on',
    'false',
    8_000,
  );
  await waitForLocatorAttribute(
    emitter,
    'data-aily-led-on',
    'true',
    8_000,
  );
  await waitForLocatorAttribute(
    emitter,
    'data-aily-led-on',
    'false',
    8_000,
  );

  await hitArea.dispatchEvent('pointerdown', {
    button: 0,
    pointerId: 41,
  });
  await waitForLocatorAttribute(
    cap,
    'data-aily-button-pressed',
    'true',
    5_000,
  );
  await waitForLocatorAttribute(
    emitter,
    'data-aily-led-on',
    'true',
    5_000,
  );
  await expect(electricalDiagnostics).toHaveCount(0, { timeout: 5_000 });
  await pause(600);
  expect(await emitter.getAttribute('data-aily-led-on')).toBe('true');

  await hitArea.dispatchEvent('pointerup', {
    button: 0,
    pointerId: 41,
  });
  await waitForLocatorAttribute(
    cap,
    'data-aily-button-pressed',
    'false',
    5_000,
  );
  await waitForLocatorAttribute(
    emitter,
    'data-aily-led-on',
    'false',
    8_000,
  );
  await expect(electricalDiagnostics).toHaveAttribute(
    'data-status',
    'info',
    { timeout: 5_000 },
  );
  await expect.poll(async () => Number(
    await electricalDiagnostics.getAttribute('data-revision'),
  )).toBeGreaterThan(initialElectricalRevision);

  return {
    ledPinmapId: 'lib-core-io:led:generic',
    buttonPinmapId: 'lib-core-io:button:generic',
    resistorPinmapId: 'lib-core-io:resistor:generic',
    currentLimitOhms: 220,
    currentLimitAppearanceVisible: true,
    blinkObserved: true,
    buttonPressObserved: true,
    buttonHeldLedOn: true,
    buttonReleaseObserved: true,
    electricalDiagnosticsForwarded: true,
    electricalDiagnosticRecoveryObserved: true,
  };
}

async function waitForLocatorAttribute(
  locator: import('@playwright/test').Locator,
  name: string,
  expected: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastValue: string | null = null;
  while (Date.now() < deadline) {
    lastValue = await locator.getAttribute(name).catch(() => null);
    if (lastValue === expected) return;
    await pause(25);
  }
  throw new Error(
    `Timed out waiting for ${name}=${expected}; last value was ${lastValue}.`,
  );
}

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function verifyIframeUartClosure(
  win: import('@playwright/test').Page,
  electronApp: import('@playwright/test').ElectronApplication,
  expectedSourceRevision: string,
): Promise<{
  iframeUrl: string;
  outputMarker: string;
  writeStatus: string;
  runtimeControlsOwner: 'iframe';
  legacyBlocklyRuntimeUiRemoved: true;
  coreIo: {
    ledPinmapId: 'lib-core-io:led:generic';
    buttonPinmapId: 'lib-core-io:button:generic';
    resistorPinmapId: 'lib-core-io:resistor:generic';
    currentLimitOhms: 220;
    currentLimitAppearanceVisible: true;
    blinkObserved: true;
    buttonPressObserved: true;
    buttonHeldLedOn: true;
    buttonReleaseObserved: true;
  };
  debugPanelOwner: 'iframe';
  legacyBlocklyDebugUiRemoved: true;
  debugPanelCollapsible: true;
  debugPanelCollapseRoundTrip: true;
  debugBreakpointBlockId: string;
  debugStackBlockId: string;
  debugStoppedFunction: string;
  debugThreads: {
    count: number;
    labels: string[];
    selectedLabel: string;
    switchRoundTrip: boolean;
  };
  debugTasks: {
    count: number;
    ids: string[];
    labels: string[];
    includesLoopTask: true;
    readOnly: true;
  };
  debugWatch: {
    expression: 'debugCounter';
    value: string;
    type: string;
  };
  debugVariable: {
    name: 'debugCounter';
    value: string;
    type: string;
  };
  debugVariableExpansion: {
    name: 'debugLabel';
    childCount: number;
    firstChildName: string;
    firstChildType: string;
    recursiveDepth: number;
    deepestChildName: string;
    deepestChildType: string;
    paginationObserved: boolean;
  };
  debugConfigurationLifecycle: {
    functionBreakpoint: 'vTaskDelay';
    breakpointAdded: true;
    breakpointRemoved: true;
    watchRemoved: true;
    watchReadded: true;
    activeConfigurationCountAfterCleanup: 2;
  };
  debugSourceContext: {
    file: 'sketch.ino';
    revision: string;
    initialLine: number;
    initialBlockId: string;
    initialText: string;
    visibleLineCount: number;
    stepOverLine: number;
    stepOverBlockId: 'debug-delay-block';
    externalFile: string;
    externalLine: number;
    externalSourceWithheld: true;
    selectedFrameLine: number;
  };
  debugSourceGutter: {
    file: 'sketch.ino';
    line: number;
    revision: string;
    breakpointAdded: true;
    breakpointRemoved: true;
    blockCollisionProtected: true;
  };
  debugFrameSelection: {
    functionName: 'loop';
    frameLevel: number;
    variableName: 'debugCounter';
    variableValue: string;
  };
  debugRegisters: {
    firstPageName: string;
    firstPageValue: string;
    secondPageName: string;
    secondPageValue: string;
  };
  debugMemory: {
    regionId: string;
    address: string;
    length: number;
    firstLine: string;
  };
  debugStepInto: {
    functionName: string;
    location: string;
    attempts: number;
  };
  debugStepOver: {
    functionName: string;
    location: string;
    blockId: 'debug-delay-block';
    attempts: number;
  };
  debugBlockControls: {
    selectedTargetBlockId: 'debug-delay-block';
    targetPreservedWhileStopped: true;
    runToBlockId: 'debug-delay-block';
    runToLocation: string;
    temporaryBreakpointCleaned: true;
    configurationCountPreserved: true;
    stepBlockId: 'debug-delay-block';
    stepBlockLocation: string;
  };
  debugRecovery: {
    firstProcessId: number;
    recoveredProcessId: number;
    recoveryCount: number;
    automaticRestorePrevented: true;
    restorePasses: number;
    breakpointRestored: true;
    watchRestored: true;
    restoredWatchValue: string;
  };
}> {
  await navigate(win, '/simulator');
  const editor = win.locator('app-simulator-editor');
  await expect(editor).toBeVisible({ timeout: 30_000 });
  const iframeElement = editor.locator('app-iframe iframe');
  await expect(iframeElement).toHaveAttribute(
    'src',
    /^http:\/\/127\.0\.0\.1:\d+\/connection-graph\?/,
    { timeout: 30_000 },
  );
  const iframeUrl = await iframeElement.getAttribute('src') || '';
  const frame = win.frameLocator('app-simulator-editor app-iframe iframe');
  await expect(frame.locator('.simulation-uart-dock')).toBeVisible({
    timeout: 30_000,
  });
  await expect(frame.locator('.simulation-runtime-controls')).toBeVisible({
    timeout: 30_000,
  });
  const debugPanelHost = frame.locator('app-simulation-debug-panel');
  const debugPanel = debugPanelHost.locator(
    '[data-testid="simulation-debug-panel"]',
  );
  await expect(debugPanel).toBeVisible({ timeout: 30_000 });
  const selectedTarget = debugPanel.locator(
    '.project-debug .selected-block',
  );
  const debugPanelToggle = debugPanel.locator(
    '[data-testid="debug-panel-toggle"]',
  );
  const debugPanelContent = debugPanel.locator(
    '[data-testid="debug-panel-content"]',
  );
  await expect(debugPanelToggle).toHaveAttribute('aria-expanded', 'true');
  const expandedDebugPanelBox = await debugPanelHost.boundingBox();
  expect(expandedDebugPanelBox?.width || 0).toBeGreaterThan(280);
  await debugPanelToggle.click();
  await expect(debugPanelHost).toHaveAttribute('data-collapsed', 'true');
  await expect(debugPanelContent).toBeHidden();
  const collapsedDebugPanelBox = await debugPanelHost.boundingBox();
  expect(collapsedDebugPanelBox?.width || 0).toBeLessThanOrEqual(48);
  await debugPanelToggle.click();
  await expect(debugPanelHost).toHaveAttribute('data-collapsed', 'false');
  await expect(debugPanelContent).toBeVisible();
  await expect(debugPanelToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(editor.locator('.simulator-toolbar')).toHaveCount(0);
  await expect(editor.locator('.terminal-panel')).toHaveCount(0);
  await expect(editor.locator('.input-list')).toHaveCount(0);
  await expect(editor.locator('.runtime-pane')).toHaveCount(0);
  await expect(editor.locator('.debug-panel')).toHaveCount(0);

  await frame.locator(
    'button[data-operation="session.start"]',
  ).click();
  await expect(frame.locator('.simulation-runtime-state')).toHaveText(
    'running',
    {
      timeout: 120_000,
    },
  );
  await expect(frame.locator('.simulation-state')).toHaveText('running', {
    timeout: 30_000,
  });
  const output = frame.locator('.simulation-uart-output');
  await expect(output).toContainText('ESP-ROM:', { timeout: 30_000 });
  const coreIo = await verifyCoreIoLedButton(frame);

  const debugState = debugPanel.locator('.debug-state');
  await expect(debugState).toHaveText('disconnected', {
    timeout: 30_000,
  });
  await expect(selectedTarget).toContainText(RUN_TARGET_BLOCK_ID);
  await debugPanel.locator(
    'button[data-debug-operation="debug.connect"]',
  ).click();
  await expect(debugState).toHaveText('stopped', {
    timeout: 60_000,
  });
  const projectBreakpoint = debugPanel
    .locator('.project-debug .configuration-list code')
    .filter({ hasText: BREAKPOINT_BLOCK_ID });
  await expect(projectBreakpoint).toBeVisible({ timeout: 30_000 });
  await debugPanel.locator(
    'button[data-debug-operation="project.debug.configuration.apply"]',
  ).click();
  await expect(
    debugPanel.locator('.project-debug .result-list'),
  ).toContainText(/已应用|已激活/, { timeout: 30_000 });

  await debugPanel.locator(
    'button[data-debug-operation="debug.continue"]',
  ).click();
  await expect(debugPanel.locator('.debug-location')).toContainText(
    `Blockly: ${BREAKPOINT_BLOCK_ID}`,
    { timeout: 60_000 },
  );
  await expect(debugState).toHaveText('stopped', { timeout: 30_000 });
  const stoppedStackFrame = debugPanel
    .locator('.stack-list button')
    .filter({ hasText: `Blockly: ${BREAKPOINT_BLOCK_ID}` })
    .first();
  await expect(stoppedStackFrame).toBeVisible({ timeout: 30_000 });
  await expect(stoppedStackFrame).toContainText('loop');
  const threadButtons = debugPanel.locator('.thread-list button');
  const threadCount = await threadButtons.count();
  expect(threadCount).toBeGreaterThan(0);
  expect(threadCount).toBeLessThanOrEqual(128);
  const threadLabels = (await threadButtons.allInnerTexts())
    .map((label) => label.replace(/\s+/g, ' ').trim());
  expect(threadLabels).toHaveLength(threadCount);
  expect(threadLabels.every((label) => label.length > 0)).toBe(true);
  const initiallySelectedThread = debugPanel
    .locator('.thread-list button.selected')
    .first();
  await expect(initiallySelectedThread).toBeVisible();
  const initiallySelectedThreadId = await initiallySelectedThread
    .getAttribute('data-thread-id');
  expect(initiallySelectedThreadId).toMatch(/^[1-9]\d*$/);
  const selectedThreadLabel = (
    await initiallySelectedThread.innerText()
  ).replace(/\s+/g, ' ').trim();
  let threadSwitchRoundTrip = threadCount === 1;
  if (threadCount > 1) {
    const secondaryThread = debugPanel
      .locator(
        `.thread-list button:not([data-thread-id="${initiallySelectedThreadId}"])`,
      )
      .first();
    const secondaryThreadId = await secondaryThread.getAttribute(
      'data-thread-id',
    );
    expect(secondaryThreadId).toMatch(/^[1-9]\d*$/);
    await invokeIframeDebugButton(
      debugPanel,
      secondaryThread,
      'debug.thread.select',
    );
    await expect(
      debugPanel.locator(
        `.thread-list button[data-thread-id="${secondaryThreadId}"]`,
      ),
    ).toHaveClass(/selected/);
    await invokeIframeDebugButton(
      debugPanel,
      debugPanel.locator(
        `.thread-list button[data-thread-id="${initiallySelectedThreadId}"]`,
      ),
      'debug.thread.select',
    );
    await expect(
      debugPanel.locator(
        `.thread-list button[data-thread-id="${initiallySelectedThreadId}"]`,
      ),
    ).toHaveClass(/selected/);
    await expect(debugPanel.locator('.debug-location')).toContainText(
      `Blockly: ${BREAKPOINT_BLOCK_ID}`,
      { timeout: 30_000 },
    );
    threadSwitchRoundTrip = true;
  }
  const taskSnapshotCard = debugPanel.locator(
    '[data-testid="debug-task-snapshot"]',
  );
  await expect(taskSnapshotCard).toHaveAttribute(
    'data-task-availability',
    'available',
    { timeout: 30_000 },
  );
  await expect(taskSnapshotCard).toHaveAttribute('data-task-reason', 'ok');
  const taskRows = debugPanel.locator('.task-list [data-task-id]');
  await expect(taskRows.first()).toBeVisible({ timeout: 30_000 });
  const taskCount = await taskRows.count();
  expect(taskCount).toBeGreaterThan(0);
  expect(taskCount).toBeLessThanOrEqual(128);
  const taskIds = await taskRows.evaluateAll((elements) => (
    elements.map((element) => element.getAttribute('data-task-id') || '')
  ));
  expect(taskIds.every((id) => /^tcb:[0-9a-f]+$/.test(id))).toBe(true);
  const taskLabels = (await taskRows.allInnerTexts())
    .map((label) => label.replace(/\s+/g, ' ').trim());
  expect(taskLabels).toHaveLength(taskCount);
  expect(taskLabels.some((label) => label.includes('loopTask'))).toBe(true);
  await expect(debugPanel.locator('.task-list button')).toHaveCount(0);
  const stoppedFunction = (
    await debugPanel.locator('.debug-location strong').innerText()
  ).trim();
  const sourceContext = debugPanel.locator(
    '[data-testid="debug-source-context"]',
  );
  await expect(sourceContext).toHaveAttribute(
    'data-source-status',
    'available',
  );
  await expect(sourceContext).toHaveAttribute(
    'data-source-file',
    'sketch.ino',
  );
  await expect(sourceContext).toHaveAttribute(
    'data-source-revision',
    expectedSourceRevision,
  );
  const currentSourcePreview = sourceContext.locator(
    '[data-testid="debug-source-current-preview"]',
  );
  await expect(currentSourcePreview).toBeVisible();
  const sourceContextToggle = sourceContext.locator(
    '[data-testid="debug-source-context-toggle"]',
  );
  await expect(sourceContextToggle).toHaveAttribute('aria-expanded', 'false');
  await sourceContextToggle.click();
  await expect(sourceContextToggle).toHaveAttribute('aria-expanded', 'true');
  const initialSourceLine = sourceContext.locator(
    '.source-line[data-current="true"]',
  );
  await expect(initialSourceLine).toHaveCount(1);
  const initialSourceLineNumber = Number(
    await initialSourceLine.getAttribute('data-source-line'),
  );
  const initialSourceText = (
    await initialSourceLine.locator('code').innerText()
  ).trim();
  expect(initialSourceText).not.toBe('');
  const initialSourceBlockId = await sourceContext
    .locator('.source-block')
    .getAttribute('data-block-id') || '';
  expect(initialSourceBlockId).toBe(BREAKPOINT_BLOCK_ID);
  const visibleSourceLineCount = await sourceContext
    .locator('.source-line')
    .count();
  expect(visibleSourceLineCount).toBeGreaterThan(0);
  expect(visibleSourceLineCount).toBeLessThanOrEqual(21);
  const currentSourceGutter = initialSourceLine.locator(
    '.source-breakpoint-gutter',
  );
  await expect(currentSourceGutter).toHaveAttribute(
    'data-source-breakpoint-state',
    'resolved',
  );
  await expect(currentSourceGutter).toBeDisabled();
  const sourceBreakpointLine = sourceContext.locator('.source-line').filter({
    hasText: 'delay(250);',
  });
  await expect(sourceBreakpointLine).toHaveCount(1);
  const emptySourceGutter = sourceBreakpointLine.locator(
    '.source-breakpoint-gutter[data-source-breakpoint-state="none"]',
  );
  await expect(emptySourceGutter).toBeEnabled();
  const gutterSourceLine = Number(
    await emptySourceGutter.getAttribute('data-source-line'),
  );
  expect(gutterSourceLine).toBeGreaterThan(0);
  expect(Math.abs(gutterSourceLine - initialSourceLineNumber))
    .toBeLessThanOrEqual(10);
  await expect(emptySourceGutter).toHaveAttribute(
    'data-source-revision',
    expectedSourceRevision,
  );
  await invokeIframeDebugButton(
    debugPanel,
    emptySourceGutter,
    'debug.breakpoint.add',
  );
  const activeSourceGutter = sourceContext.locator(
    `.source-breakpoint-gutter[data-source-line="${gutterSourceLine}"]`,
  );
  await expect(activeSourceGutter).toHaveAttribute(
    'data-source-breakpoint-state',
    'source',
    { timeout: 30_000 },
  );
  const gutterBreakpointRow = debugPanel.locator(
    '[data-debug-breakpoint-kind="source"]',
  ).filter({ hasText: `sketch.ino:${gutterSourceLine}` });
  await expect(gutterBreakpointRow).toBeVisible({ timeout: 30_000 });
  await invokeIframeDebugButton(
    debugPanel,
    activeSourceGutter,
    'debug.breakpoint.remove',
  );
  await expect(activeSourceGutter).toHaveAttribute(
    'data-source-breakpoint-state',
    'none',
    { timeout: 30_000 },
  );
  await expect(gutterBreakpointRow).toHaveCount(0);

  const variableRow = debugPanel
    .locator('.variable-tree-row')
    .filter({ hasText: 'debugCounter' })
    .first();
  await expect(variableRow).toBeVisible({ timeout: 30_000 });
  await expect(variableRow.locator('.variable-value')).toHaveText('3');
  const variableType = (
    await variableRow.locator('small').first().innerText()
  ).trim();

  const compositeVariableRow = debugPanel
    .locator('.variable-tree-row')
    .filter({ hasText: 'debugLabel' })
    .first();
  await expect(compositeVariableRow).toBeVisible({ timeout: 30_000 });
  const variableRowsBeforeExpansion = await debugPanel
    .locator('.variable-tree-row')
    .count();
  await invokeIframeDebugButton(
    debugPanel,
    compositeVariableRow.locator('.variable-toggle'),
    'debug.variable.toggle',
  );
  await expect.poll(
    () => debugPanel.locator('.variable-tree-row').count(),
    { timeout: 30_000 },
  ).toBeGreaterThan(variableRowsBeforeExpansion);
  const expandedVariableChildren = await debugPanel
    .locator('.variable-tree-row')
    .evaluateAll((rows) => rows
      .map((row) => ({
        paddingLeft: Number.parseFloat(
          getComputedStyle(row).paddingLeft || '0',
        ),
        name: row.querySelector('code')?.textContent?.trim() || '',
        type: row.querySelector('small')?.textContent?.trim() || '',
      }))
      .filter((row) => row.paddingLeft > 6));
  expect(expandedVariableChildren.length).toBeGreaterThan(0);
  expect(expandedVariableChildren[0]?.name).not.toBe('');
  const recursivelyExpandableRowIndex = await debugPanel
    .locator('.variable-tree-row')
    .evaluateAll((rows) => rows.findIndex((row) => (
      Number.parseFloat(getComputedStyle(row).paddingLeft || '0') > 6
      && !!row.querySelector('.variable-toggle')
    )));
  expect(recursivelyExpandableRowIndex).toBeGreaterThanOrEqual(0);
  const variableRowsBeforeRecursiveExpansion = await debugPanel
    .locator('.variable-tree-row')
    .count();
  await invokeIframeDebugButton(
    debugPanel,
    debugPanel
      .locator('.variable-tree-row')
      .nth(recursivelyExpandableRowIndex)
      .locator('.variable-toggle'),
    'debug.variable.toggle',
  );
  await expect.poll(
    () => debugPanel.locator('.variable-tree-row').count(),
    { timeout: 30_000 },
  ).toBeGreaterThan(variableRowsBeforeRecursiveExpansion);
  const recursivelyExpandedVariables = await debugPanel
    .locator('.variable-tree-row')
    .evaluateAll((rows) => rows
      .map((row) => ({
        depth: Math.round((
          Number.parseFloat(getComputedStyle(row).paddingLeft || '0') - 6
        ) / 14),
        name: row.querySelector('code')?.textContent?.trim() || '',
        type: row.querySelector('small')?.textContent?.trim() || '',
      }))
      .filter((row) => row.depth >= 2)
      .sort((left, right) => right.depth - left.depth));
  expect(recursivelyExpandedVariables.length).toBeGreaterThan(0);
  expect(recursivelyExpandedVariables[0]?.name).not.toBe('');
  const deepestExpandedVariable = recursivelyExpandedVariables[0]!;
  const variablePaginationObserved = await debugPanel
    .locator('.variable-tree .load-more')
    .isVisible()
    .catch(() => false);

  const watchInput = debugPanel.locator('.watch-editor input');
  await watchInput.fill('debugCounter');
  await debugPanel.locator(
    'button[data-debug-operation="debug.watch.add"]',
  ).click();
  const watchRow = debugPanel
    .locator('.watch-list > div')
    .filter({ hasText: 'debugCounter' })
    .first();
  await expect(watchRow).toBeVisible({ timeout: 30_000 });
  await expect(watchRow.locator('span')).toHaveText('3');
  const watchValue = (await watchRow.locator('span').innerText()).trim();
  const watchType = (await watchRow.locator('small').innerText()).trim();

  const sessionConfiguration = debugPanel.locator(
    '[data-testid="debug-session-configuration"]',
  );
  const configurationRows = sessionConfiguration.locator(
    '.configuration-list > div',
  );
  await expect(configurationRows).toHaveCount(2);

  const breakpointFunctionInput = debugPanel.locator(
    '.breakpoint-editor input[placeholder="setup"]',
  );
  await breakpointFunctionInput.fill('vTaskDelay');
  await invokeIframeDebugOperation(debugPanel, 'debug.breakpoint.add');
  const functionBreakpointRow = debugPanel.locator(
    '[data-debug-breakpoint-kind="function"]',
  ).filter({ hasText: 'vTaskDelay' });
  await expect(functionBreakpointRow).toBeVisible({ timeout: 30_000 });
  await expect(configurationRows).toHaveCount(3);
  await invokeIframeDebugButton(
    debugPanel,
    functionBreakpointRow.locator(
      'button[data-debug-operation="debug.breakpoint.remove"]',
    ),
    'debug.breakpoint.remove',
  );
  await expect(functionBreakpointRow).toHaveCount(0);
  await expect(configurationRows).toHaveCount(2);

  await invokeIframeDebugButton(
    debugPanel,
    watchRow.locator(
      'button[data-debug-operation="debug.watch.remove"]',
    ),
    'debug.watch.remove',
  );
  await expect(watchRow).toHaveCount(0);
  await expect(configurationRows).toHaveCount(1);
  await watchInput.fill('debugCounter');
  await invokeIframeDebugOperation(debugPanel, 'debug.watch.add');
  await expect(watchRow).toBeVisible({ timeout: 30_000 });
  await expect(watchRow.locator('span')).toHaveText('3');
  await expect(configurationRows).toHaveCount(2);

  const registerRows = debugPanel.locator('.register-list > div');
  await expect(registerRows.first()).toBeVisible({ timeout: 30_000 });
  const firstPageRegisterName = (
    await registerRows.first().locator('code').innerText()
  ).trim();
  const firstPageRegisterValue = (
    await registerRows.first().locator('span').innerText()
  ).trim();
  const nextRegisterPage = debugPanel
    .locator('.pagination button')
    .filter({ hasText: '下一页' });
  await expect(nextRegisterPage).toBeEnabled();
  await nextRegisterPage.click();
  await expect.poll(async () => (
    await registerRows.first().locator('code').innerText()
  ).trim()).not.toBe(firstPageRegisterName);
  const secondPageRegisterName = (
    await registerRows.first().locator('code').innerText()
  ).trim();
  const secondPageRegisterValue = (
    await registerRows.first().locator('span').innerText()
  ).trim();

  const memoryRegion = debugPanel.locator(
    '.memory-editor select[aria-label="安全内存区域"]',
  );
  const memoryAddressInput = debugPanel.locator(
    '.memory-editor input[aria-label="内存地址"]',
  );
  const memoryLengthInput = debugPanel.locator(
    '.memory-editor input[aria-label="读取字节数"]',
  );
  const memoryRegionId = await memoryRegion.inputValue();
  const memoryAddress = await memoryAddressInput.inputValue();
  await memoryLengthInput.fill('16');
  await debugPanel.locator(
    'button[data-debug-operation="debug.memory.read"]',
  ).click();
  const memoryDump = debugPanel.locator('.memory-dump');
  await expect(memoryDump).toContainText(/^0x[0-9a-f]{8}/, {
    timeout: 30_000,
  });
  const memoryFirstLine = (
    await memoryDump.innerText()
  ).split(/\r?\n/, 1)[0].trimEnd();

  await expect(selectedTarget).toContainText(RUN_TARGET_BLOCK_ID);
  const configurationCountBeforeRunTo = await configurationRows.count();
  const runtimeBreakpointCountBeforeRunTo = await debugPanel
    .locator('.breakpoint-list > div')
    .count();
  await invokeIframeDebugOperation(
    debugPanel,
    'project.debug.run-to-selected',
  );
  await expect(debugState).toHaveText('stopped', { timeout: 60_000 });
  const runToLocationText = (
    await debugPanel.locator('.debug-location').innerText()
  ).trim();
  expect(runToLocationText).toContain(`Blockly: ${RUN_TARGET_BLOCK_ID}`);
  await expect(configurationRows).toHaveCount(
    configurationCountBeforeRunTo,
  );
  await expect(debugPanel.locator('.breakpoint-list > div')).toHaveCount(
    runtimeBreakpointCountBeforeRunTo,
  );
  const runToLocation = (
    await debugPanel.locator('.debug-location span').innerText()
  ).trim();

  await invokeIframeDebugOperation(debugPanel, 'debug.continue');
  await expect(debugPanel.locator('.debug-location')).toContainText(
    `Blockly: ${BREAKPOINT_BLOCK_ID}`,
    { timeout: 60_000 },
  );
  await expect(debugState).toHaveText('stopped', { timeout: 30_000 });

  await invokeIframeDebugOperation(debugPanel, 'debug.step-block');
  await expect(debugPanel.locator('.debug-location')).toContainText(
    `Blockly: ${RUN_TARGET_BLOCK_ID}`,
    { timeout: 60_000 },
  );
  await expect(debugPanel).toHaveAttribute(
    'data-busy-operation',
    '',
    { timeout: 30_000 },
  );
  await expect(debugState).toHaveText('stopped', { timeout: 30_000 });
  const stepOverLocationText = (
    await debugPanel.locator('.debug-location').innerText()
  ).trim();
  expect(stepOverLocationText).toContain(`Blockly: ${RUN_TARGET_BLOCK_ID}`);
  const stepOverAttempts = 1;
  await expect(sourceContext).toHaveAttribute(
    'data-source-status',
    'available',
  );
  const stepOverSourceLine = sourceContext.locator(
    '.source-line[data-current="true"]',
  );
  await expect(stepOverSourceLine).toHaveCount(1);
  const stepOverSourceLineNumber = Number(
    await stepOverSourceLine.getAttribute('data-source-line'),
  );
  const stepOverSourceBlockId = await sourceContext
    .locator('.source-block')
    .getAttribute('data-block-id') || '';
  expect(stepOverSourceBlockId).toBe('debug-delay-block');
  const stepOverFunction = (
    await debugPanel.locator('.debug-location strong').innerText()
  ).trim();
  const stepOverLocation = (
    await debugPanel.locator('.debug-location span').innerText()
  ).trim();

  let stepIntoAttempts = 0;
  let stepIntoFunction = 'loop';
  while (stepIntoAttempts < 8 && stepIntoFunction === 'loop') {
    stepIntoAttempts += 1;
    await invokeIframeDebugOperation(debugPanel, 'debug.step-into');
    await expect(debugState).toHaveText('stopped', { timeout: 30_000 });
    stepIntoFunction = (
      await debugPanel.locator('.debug-location strong').innerText()
    ).trim();
  }
  expect(stepIntoFunction).not.toBe('');
  expect(stepIntoFunction).not.toBe('loop');
  await expect(sourceContext).toHaveAttribute(
    'data-source-status',
    'external-source',
  );
  await expect(sourceContext.locator('.source-line')).toHaveCount(0);
  const externalSourceFile = await sourceContext.getAttribute(
    'data-source-file',
  ) || '';
  const externalSourceLine = Number(await sourceContext.getAttribute(
    'data-source-current-line',
  ));
  expect(externalSourceFile).not.toBe('');
  expect(externalSourceLine).toBeGreaterThan(0);
  const stepIntoLocation = (
    await debugPanel.locator('.debug-location span').innerText()
  ).trim();

  const loopStackFrame = debugPanel
    .locator('.stack-list button')
    .filter({ hasText: /\bloop\b/ })
    .first();
  await expect(loopStackFrame).toBeVisible({ timeout: 30_000 });
  const loopFrameLabel = (await loopStackFrame.innerText()).trim();
  const loopFrameLevel = Number(/^#(\d+)/.exec(loopFrameLabel)?.[1]);
  expect(loopFrameLevel).toBeGreaterThan(0);
  await invokeIframeDebugButton(
    debugPanel,
    loopStackFrame,
    'debug.frame.select',
  );
  await expect(loopStackFrame).toHaveClass(/selected/);
  const selectedFrameVariable = debugPanel
    .locator('.variable-tree-row')
    .filter({ hasText: 'debugCounter' })
    .first();
  await expect(selectedFrameVariable).toBeVisible({ timeout: 30_000 });
  await expect(
    selectedFrameVariable.locator('.variable-value'),
  ).toHaveText('3');
  await expect(sourceContext).toHaveAttribute(
    'data-source-status',
    'available',
  );
  const selectedFrameSourceLine = Number(
    await sourceContext.getAttribute('data-source-current-line'),
  );
  expect(selectedFrameSourceLine).toBeGreaterThan(0);

  const electronUserDataPath = await electronApp.evaluate(
    ({ app }) => app.getPath('userData'),
  );
  const firstProcessId = await waitForManagedQemuProcess(
    electronUserDataPath,
  );
  expect(firstProcessId).toBeGreaterThan(0);
  await expect(configurationRows).toHaveCount(2);
  await expect(
    sessionConfiguration.locator('.configuration-list > div.pending'),
  ).toHaveCount(0);

  process.kill(firstProcessId);
  await expect(frame.locator('.simulation-runtime-state')).toHaveText(
    'crashed',
    { timeout: 30_000 },
  );
  await expect(debugState).toHaveText('disconnected', {
    timeout: 30_000,
  });
  const restoreConfigurationButton = debugPanel.locator(
    'button[data-debug-operation="debug.configuration.restore"]',
  );
  await expect(restoreConfigurationButton).toBeVisible({
    timeout: 30_000,
  });
  await expect(
    sessionConfiguration.locator('.configuration-list > div.pending'),
  ).toHaveCount(2);

  const recoverButton = frame.locator(
    'button[data-operation="session.recover"]',
  );
  await expect(recoverButton).toBeEnabled({ timeout: 30_000 });
  await recoverButton.click();
  await expect(frame.locator('.simulation-runtime-state')).toHaveText(
    'running',
    { timeout: 60_000 },
  );
  const recoveredProcessId = await waitForManagedQemuProcess(
    electronUserDataPath,
    firstProcessId,
  );
  expect(recoveredProcessId).toBeGreaterThan(0);
  expect(recoveredProcessId).not.toBe(firstProcessId);

  await invokeIframeDebugButton(
    debugPanel,
    debugPanel.locator(
      'button[data-debug-operation="debug.connect"]',
    ),
    'debug.connect',
    60_000,
  );
  await expect(debugState).toHaveText('stopped', { timeout: 30_000 });
  await expect(restoreConfigurationButton).toBeVisible();
  await expect(
    sessionConfiguration.locator('.configuration-list > div.pending'),
  ).toHaveCount(2);

  let restorePasses = 1;
  await invokeIframeDebugButton(
    debugPanel,
    restoreConfigurationButton,
    'debug.configuration.restore',
  );
  await expect(configurationRows.first()).not.toHaveClass(/pending/);
  const pendingAfterFirstRestore = await debugPanel
    .locator(
      '[data-testid="debug-session-configuration"] '
      + '.configuration-list > div.pending',
    )
    .count();
  expect(pendingAfterFirstRestore).toBeLessThanOrEqual(1);

  await invokeIframeDebugOperation(debugPanel, 'debug.continue');
  await expect(debugPanel.locator('.debug-location')).toContainText(
    `Blockly: ${BREAKPOINT_BLOCK_ID}`,
    { timeout: 60_000 },
  );
  await expect(debugState).toHaveText('stopped', { timeout: 30_000 });

  if (pendingAfterFirstRestore > 0) {
    restorePasses += 1;
    await invokeIframeDebugButton(
      debugPanel,
      restoreConfigurationButton,
      'debug.configuration.restore',
    );
  }
  await expect(
    sessionConfiguration.locator('.configuration-list > div.pending'),
  ).toHaveCount(0);
  await expect(restoreConfigurationButton).toHaveCount(0);
  const restoredWatchRow = debugPanel
    .locator('.watch-list > div')
    .filter({ hasText: 'debugCounter' })
    .first();
  await expect(restoredWatchRow).toBeVisible({ timeout: 30_000 });
  await expect(restoredWatchRow.locator('span')).toHaveText('3');
  const restoredWatchValue = (
    await restoredWatchRow.locator('span').innerText()
  ).trim();

  await invokeIframeDebugButton(
    debugPanel,
    debugPanel.locator(
      'button[data-debug-operation="debug.disconnect"]',
    ),
    'debug.disconnect',
  );
  await expect(debugState).toHaveText('disconnected', {
    timeout: 30_000,
  });

  await frame.locator('input[name="simulationUartInputText"]').fill('A');
  await frame.locator('select[name="simulationUartLineEnding"]')
    .selectOption('none');
  await frame.locator('.simulation-uart-input button[type="submit"]').click();
  const writeStatus = frame.locator('.simulation-uart-input small');
  await expect(writeStatus).toContainText('已写入 UART0', {
    timeout: 30_000,
  });
  const writeStatusText = await writeStatus.innerText();

  await frame.locator(
    'button[data-operation="session.stop"]',
  ).click();
  await expect(frame.locator('.simulation-runtime-state')).toHaveText(
    'stopped',
    {
      timeout: 30_000,
    },
  );
  return {
    iframeUrl,
    outputMarker: 'ESP-ROM:',
    writeStatus: writeStatusText,
    runtimeControlsOwner: 'iframe',
    legacyBlocklyRuntimeUiRemoved: true,
    coreIo,
    debugPanelOwner: 'iframe',
    legacyBlocklyDebugUiRemoved: true,
    debugPanelCollapsible: true,
    debugPanelCollapseRoundTrip: true,
    debugBreakpointBlockId: BREAKPOINT_BLOCK_ID,
    debugStackBlockId: BREAKPOINT_BLOCK_ID,
    debugStoppedFunction: stoppedFunction,
    debugThreads: {
      count: threadCount,
      labels: threadLabels,
      selectedLabel: selectedThreadLabel,
      switchRoundTrip: threadSwitchRoundTrip,
    },
    debugTasks: {
      count: taskCount,
      ids: taskIds,
      labels: taskLabels,
      includesLoopTask: true,
      readOnly: true,
    },
    debugWatch: {
      expression: 'debugCounter',
      value: watchValue,
      type: watchType,
    },
    debugVariable: {
      name: 'debugCounter',
      value: '3',
      type: variableType,
    },
    debugVariableExpansion: {
      name: 'debugLabel',
      childCount: expandedVariableChildren.length,
      firstChildName: expandedVariableChildren[0]!.name,
      firstChildType: expandedVariableChildren[0]!.type,
      recursiveDepth: deepestExpandedVariable.depth,
      deepestChildName: deepestExpandedVariable.name,
      deepestChildType: deepestExpandedVariable.type,
      paginationObserved: variablePaginationObserved,
    },
    debugConfigurationLifecycle: {
      functionBreakpoint: 'vTaskDelay',
      breakpointAdded: true,
      breakpointRemoved: true,
      watchRemoved: true,
      watchReadded: true,
      activeConfigurationCountAfterCleanup: 2,
    },
    debugSourceContext: {
      file: 'sketch.ino',
      revision: expectedSourceRevision,
      initialLine: initialSourceLineNumber,
      initialBlockId: initialSourceBlockId,
      initialText: initialSourceText,
      visibleLineCount: visibleSourceLineCount,
      stepOverLine: stepOverSourceLineNumber,
      stepOverBlockId: 'debug-delay-block',
      externalFile: externalSourceFile,
      externalLine: externalSourceLine,
      externalSourceWithheld: true,
      selectedFrameLine: selectedFrameSourceLine,
    },
    debugSourceGutter: {
      file: 'sketch.ino',
      line: gutterSourceLine,
      revision: expectedSourceRevision,
      breakpointAdded: true,
      breakpointRemoved: true,
      blockCollisionProtected: true,
    },
    debugFrameSelection: {
      functionName: 'loop',
      frameLevel: loopFrameLevel,
      variableName: 'debugCounter',
      variableValue: '3',
    },
    debugRegisters: {
      firstPageName: firstPageRegisterName,
      firstPageValue: firstPageRegisterValue,
      secondPageName: secondPageRegisterName,
      secondPageValue: secondPageRegisterValue,
    },
    debugMemory: {
      regionId: memoryRegionId,
      address: memoryAddress,
      length: 16,
      firstLine: memoryFirstLine,
    },
    debugStepInto: {
      functionName: stepIntoFunction,
      location: stepIntoLocation,
      attempts: stepIntoAttempts,
    },
    debugStepOver: {
      functionName: stepOverFunction,
      location: stepOverLocation,
      blockId: 'debug-delay-block',
      attempts: stepOverAttempts,
    },
    debugBlockControls: {
      selectedTargetBlockId: 'debug-delay-block',
      targetPreservedWhileStopped: true,
      runToBlockId: 'debug-delay-block',
      runToLocation,
      temporaryBreakpointCleaned: true,
      configurationCountPreserved: true,
      stepBlockId: 'debug-delay-block',
      stepBlockLocation: stepOverLocation,
    },
    debugRecovery: {
      firstProcessId,
      recoveredProcessId,
      recoveryCount: 1,
      automaticRestorePrevented: true,
      restorePasses,
      breakpointRestored: true,
      watchRestored: true,
      restoredWatchValue,
    },
  };
}

async function invokeIframeDebugOperation(
  debugPanel: import('@playwright/test').Locator,
  operation: string,
): Promise<void> {
  const selector = operation === 'debug.breakpoint.add'
    ? `.breakpoint-editor button[data-debug-operation="${operation}"]`
    : `button[data-debug-operation="${operation}"]`;
  await invokeIframeDebugButton(
    debugPanel,
    debugPanel.locator(selector),
    operation,
  );
}

async function invokeIframeDebugButton(
  debugPanel: import('@playwright/test').Locator,
  button: import('@playwright/test').Locator,
  operation: string,
  timeout = 30_000,
): Promise<void> {
  await button.click();
  if (await debugPanel.getAttribute('data-busy-operation') !== operation) {
    await expect(debugPanel).toHaveAttribute(
      'data-busy-operation',
      operation,
      { timeout: 1_000 },
    ).catch(() => undefined);
  }
  await expect(debugPanel).toHaveAttribute(
    'data-busy-operation',
    '',
    { timeout },
  );
}

async function waitForManagedQemuProcess(
  electronUserDataPath: string,
  excludedProcessId = 0,
  timeout = 30_000,
): Promise<number> {
  const deadline = Date.now() + timeout;
  let observed: number[] = [];
  while (Date.now() < deadline) {
    observed = await listManagedQemuProcessIds(electronUserDataPath);
    const processId = observed.find(
      (candidate) => candidate !== excludedProcessId,
    );
    if (processId) return processId;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    'Timed out waiting for the Electron test instance QEMU process. '
    + `Observed process ids: ${JSON.stringify(observed)}.`,
  );
}

async function listManagedQemuProcessIds(
  electronUserDataPath: string,
): Promise<number[]> {
  const sessionRoot = path.join(
    electronUserDataPath,
    'simulator',
    'sessions',
  );
  const escapedRoot = sessionRoot.replace(/'/g, "''");
  const script = [
    `$sessionRoot = '${escapedRoot}'`,
    'Get-CimInstance Win32_Process | Where-Object {'
      + " $_.Name -like 'qemu-system-*'"
      + ' -and $_.CommandLine'
      + ' -and $_.CommandLine.Contains($sessionRoot)'
      + ' } | ForEach-Object { $_.ProcessId }',
  ].join('\n');
  const encodedScript = Buffer.from(script, 'utf16le').toString('base64');
  const result = await runProcess(
    'powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      encodedScript,
    ],
    ROOT,
    10_000,
  );
  return result.stdout
    .split(/\r?\n/)
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isSafeInteger(value) && value >= 1);
}

async function startSimulatorIframeServer(): Promise<string> {
  const indexPath = path.join(SIMULATOR_IFRAME_ROOT, 'index.html');
  if (!existsSync(indexPath)) {
    throw new Error(
      `Simulator iframe build is unavailable: ${SIMULATOR_IFRAME_ROOT}`,
    );
  }
  simulatorIframeServer = createServer((request, response) => {
    void serveSimulatorIframeFile(request.url || '/', response).catch(
      (error) => {
        response.statusCode = 500;
        response.setHeader('Content-Type', 'text/plain; charset=utf-8');
        response.end(error instanceof Error ? error.message : String(error));
      },
    );
  });
  await new Promise<void>((resolve, reject) => {
    simulatorIframeServer!.once('error', reject);
    simulatorIframeServer!.listen(0, '127.0.0.1', () => resolve());
  });
  const address = simulatorIframeServer.address();
  if (!address || typeof address === 'string') {
    throw new Error('Simulator iframe server did not bind a TCP port.');
  }
  return `http://127.0.0.1:${address.port}/connection-graph`;
}

async function closeSimulatorIframeServer(): Promise<void> {
  const server = simulatorIframeServer;
  simulatorIframeServer = null;
  if (!server) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function serveSimulatorIframeFile(
  requestUrl: string,
  response: import('node:http').ServerResponse,
): Promise<void> {
  let pathname: string;
  try {
    pathname = decodeURIComponent(
      new URL(requestUrl, 'http://127.0.0.1').pathname,
    );
  } catch {
    response.statusCode = 400;
    response.end('Invalid URL');
    return;
  }
  const relativePath = pathname === '/' ? 'index.html' : pathname.slice(1);
  let filePath = path.resolve(SIMULATOR_IFRAME_ROOT, relativePath);
  const rootPrefix = `${path.resolve(SIMULATOR_IFRAME_ROOT)}${path.sep}`;
  if (
    filePath !== path.resolve(SIMULATOR_IFRAME_ROOT)
    && !filePath.startsWith(rootPrefix)
  ) {
    response.statusCode = 403;
    response.end('Forbidden');
    return;
  }
  try {
    if (!(await stat(filePath)).isFile()) {
      filePath = path.join(SIMULATOR_IFRAME_ROOT, 'index.html');
    }
  } catch {
    filePath = path.join(SIMULATOR_IFRAME_ROOT, 'index.html');
  }
  const extension = path.extname(filePath).toLowerCase();
  response.statusCode = 200;
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Type', contentTypeFor(extension));
  response.end(await readFile(filePath));
}

function contentTypeFor(extension: string): string {
  return ({
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
  } as Record<string, string>)[extension]
    || 'application/octet-stream';
}

async function stageProject(): Promise<void> {
  await removeInsideArtifactRoot(PROJECT_PATH);
  await mkdir(ARTIFACT_ROOT, { recursive: true });
  await cp(FIXTURE_ROOT, PROJECT_PATH, {
    recursive: true,
    force: true,
  });

  const sourceScope = path.join(
    PACKAGE_SOURCE,
    'node_modules',
    '@aily-project',
  );
  const targetScope = path.join(
    PROJECT_PATH,
    'node_modules',
    '@aily-project',
  );
  await mkdir(targetScope, { recursive: true });
  for (const packageName of PACKAGE_NAMES) {
    const localLibrarySource = path.join(
      BLOCKLY_LIBRARIES_ROOT,
      packageName === 'lib-core-io' ? 'core-io' : '__not-local__',
    );
    const source = packageName === 'lib-core-io'
      && existsSync(path.join(localLibrarySource, 'pinmaps', 'pinmap_catalog.json'))
        ? localLibrarySource
        : path.join(sourceScope, packageName);
    if (!existsSync(source)) {
      throw new Error(`Required fixture package is unavailable: ${source}`);
    }
    await cp(source, path.join(targetScope, packageName), {
      recursive: true,
      force: true,
      dereference: true,
    });
  }
}

async function compileAndWait(
  win: import('@playwright/test').Page,
  previousArtifactId = '',
): Promise<{ artifact: any; report: any }> {
  await win.keyboard.press('Escape').catch(() => {});
  const compileButton = win.locator(
    'app-header app-act-btn[data-action="compile"]',
  );
  await expect(compileButton).toBeVisible({ timeout: 30_000 });
  await compileButton.click();

  const deadline = Date.now() + 8 * 60_000;
  while (Date.now() < deadline) {
    const artifact = await readJsonIfPresent(
      path.join(
        PROJECT_PATH,
        '.build',
        'aily-artifact-manifest.json',
      ),
    );
    const report = await readJsonIfPresent(
      path.join(
        PROJECT_PATH,
        '.build',
        'aily-builder-compile-report.json',
      ),
    );
    if (
      artifact?.artifactId
      && artifact.artifactId !== previousArtifactId
      && artifact.debug?.sourceMapPath
      && report?.status === 'passed'
    ) {
      return { artifact, report };
    }

    const notificationText = await win
      .locator('app-notification')
      .allInnerTexts()
      .catch(() => []);
    if (
      notificationText.some(
        (text) => /编译失败|compilation failed|compile failed/i.test(text),
      )
    ) {
      throw new Error(
        `Blockly compile failed: ${notificationText.join(' | ')}`,
      );
    }
    await win.waitForTimeout(500);
  }
  throw new Error('Timed out waiting for a new Blockly Artifact.');
}

async function expectBreakpointMenuState(
  win: import('@playwright/test').Page,
  expected: {
    suffix: string | RegExp;
    disabled: boolean;
  },
): Promise<void> {
  await expect.poll(
    async () => {
      const item = await openBreakpointMenu(win);
      const snapshot = {
        text: (await item.innerText()).trim(),
        disabled: await item.evaluate(
          (element) => element.classList.contains(
            'blocklyMenuItemDisabled',
          ),
        ),
      };
      await win.keyboard.press('Escape');
      return snapshot;
    },
    {
      timeout: 30_000,
      intervals: [100, 250, 500],
    },
  ).toEqual({
    text: expected.suffix
      ? expect.stringMatching(expected.suffix)
      : expect.not.stringMatching(
        /工作区未编译|workspace not built|正在核对|checking build|请先编译|build required/i,
      ),
    disabled: expected.disabled,
  });
}

async function openBreakpointMenu(
  win: import('@playwright/test').Page,
) {
  await win.keyboard.press('Escape').catch(() => {});
  const block = win.locator(
    `g.blocklyDraggable[data-id="${BREAKPOINT_BLOCK_ID}"]`,
  );
  const blockOutline = block.locator(':scope > .blocklyPath').first();
  await expect(blockOutline).toBeVisible({ timeout: 5_000 });
  await blockOutline.click({
    button: 'right',
    position: { x: 12, y: 12 },
    force: true,
  });
  const item = win
    .locator('.blocklyContextMenu .blocklyMenuItem')
    .filter({
      hasText: /添加仿真断点|重新绑定仿真断点|Add simulation breakpoint|Rebind simulation breakpoint/i,
    })
    .first();
  await expect(item).toBeVisible({ timeout: 5_000 });
  return item;
}

async function activateBreakpointMenuItem(
  win: import('@playwright/test').Page,
  item: import('@playwright/test').Locator,
): Promise<void> {
  const menu = win.locator('.blocklyContextMenu');
  const itemId = await item.getAttribute('id');
  expect(itemId).toBeTruthy();
  await expect(item).toHaveAttribute('aria-disabled', 'false');

  await menu.press('Home');
  const itemCount = await menu.locator('.blocklyMenuItem').count();
  for (let index = 0; index < itemCount; index += 1) {
    const highlightedId = await menu
      .locator('.blocklyMenuItemHighlight')
      .getAttribute('id')
      .catch(() => null);
    if (highlightedId === itemId) break;
    await menu.press('ArrowDown');
  }

  await expect(item).toHaveClass(/blocklyMenuItemHighlight/);
  await menu.press('Enter');
  await expect(item).toBeHidden({ timeout: 5_000 });
  await win.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => setTimeout(resolve, 0));
  }));
}

async function waitForDebugConfiguration(
  win: import('@playwright/test').Page,
): Promise<any> {
  const debugPath = path.join(PROJECT_PATH, 'aily-debug.json');
  const deadline = Date.now() + 10_000;
  let lastConfiguration: any = null;
  while (Date.now() < deadline) {
    const configuration = await readJsonIfPresent(debugPath);
    if (configuration) lastConfiguration = configuration;
    if (
      configuration?.breakpoints?.some(
        (breakpoint: Record<string, unknown>) => (
          breakpoint['blockId'] === BREAKPOINT_BLOCK_ID
        ),
      )
    ) {
      return configuration;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const warnings = await win
    .locator('.ant-message, app-notification')
    .allInnerTexts()
    .catch(() => []);
  throw new Error(
    'Timed out waiting for aily-debug.json.'
    + `${lastConfiguration
      ? ` Actual configuration: ${JSON.stringify(lastConfiguration)}.`
      : ''}`
    + `${warnings.length ? ` UI messages: ${warnings.join(' | ')}` : ''}`,
  );
}

async function readJsonIfPresent(filePath: string): Promise<any | null> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

async function removeInsideArtifactRoot(target: string): Promise<void> {
  const resolvedRoot = path.resolve(ARTIFACT_ROOT);
  const resolvedTarget = path.resolve(target);
  if (
    resolvedTarget === resolvedRoot
    || !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)
  ) {
    throw new Error(`Refusing to remove unsafe E2E path: ${resolvedTarget}`);
  }
  await rm(resolvedTarget, { recursive: true, force: true });
}

async function writeJsonAtomic(
  filePath: string,
  value: unknown,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(
    temporaryPath,
    `${JSON.stringify(value, null, 2)}\n`,
    'utf8',
  );
  await rm(filePath, { force: true });
  await rename(temporaryPath, filePath);
}

async function runProcess(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(
        `${command} ${args.join(' ')} timed out after ${timeoutMs}ms.`,
      ));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(
        `${command} ${args.join(' ')} exited with ${String(code)}`
        + `${signal ? ` (${signal})` : ''}:\n${stderr || stdout}`,
      ));
    });
  });
}

function resolveNpmCliPath(): string {
  const npmExecPath = process.env['npm_execpath'];
  if (npmExecPath && existsSync(npmExecPath)) return npmExecPath;
  const bundledNpmCli = path.join(
    path.dirname(process.execPath),
    'node_modules',
    'npm',
    'bin',
    'npm-cli.js',
  );
  if (existsSync(bundledNpmCli)) return bundledNpmCli;
  throw new Error(
    `Unable to resolve npm CLI beside Node: ${process.execPath}`,
  );
}
