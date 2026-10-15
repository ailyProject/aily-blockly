import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const reportPath = path.resolve(
  process.argv[2]
  || path.join('e2e', '.artifacts', 'simulator-debug-report.json'),
);
const report = JSON.parse(await readFile(reportPath, 'utf8'));
const failures = [];

assertEqual(report.schemaVersion, 1, 'schemaVersion');
assertEqual(
  report.kind,
  'aily-simulator-debug-e2e-result',
  'kind',
);
assertEqual(report.status, 'passed', 'status');
assertSha256(report.builder?.artifactId, 'builder.artifactId');
assertSha256(report.builder?.sourceSha256, 'builder.sourceSha256');
assertEqual(
  report.builder?.sourceSnapshotPath,
  'aily-debug-source.txt',
  'Builder source snapshot path',
);
assertEqual(
  report.builder?.sourceSnapshotRole,
  'debug-source',
  'Builder source snapshot Artifact role',
);
assertEqual(report.compiles?.baseline?.status, 'passed', 'baseline compile');
assertEqual(report.compiles?.rebuilt?.status, 'passed', 'rebuilt compile');
assertTrue(
  Number(
    report.compiles?.rebuilt?.archiveCloudCache?.localHits || 0,
  ) + Number(
    report.compiles?.rebuilt?.archiveCloudCache?.remoteHits || 0,
  ) >= 1,
  'rebuilt compile must reuse archive cloud cache',
);
assertEqual(
  report.iframeUart?.runtimeControlsOwner,
  'iframe',
  'runtime controls owner',
);
assertEqual(
  report.iframeUart?.debugPanelOwner,
  'iframe',
  'debug panel owner',
);
assertEqual(
  report.iframeUart?.legacyBlocklyRuntimeUiRemoved,
  true,
  'legacy Blockly runtime UI removal',
);
assertEqual(
  report.iframeUart?.coreIo?.ledPinmapId,
  'lib-core-io:led:generic',
  'core IO LED pinmap identity',
);
assertEqual(
  report.iframeUart?.coreIo?.buttonPinmapId,
  'lib-core-io:button:generic',
  'core IO Button pinmap identity',
);
assertEqual(
  report.iframeUart?.coreIo?.resistorPinmapId,
  'lib-core-io:resistor:generic',
  'core IO Resistor pinmap identity',
);
assertEqual(
  report.iframeUart?.coreIo?.currentLimitOhms,
  220,
  'explicit LED current-limit resistance',
);
assertEqual(
  report.iframeUart?.coreIo?.currentLimitAppearanceVisible,
  true,
  'explicit resistor appearance',
);
assertEqual(
  report.iframeUart?.coreIo?.blinkObserved,
  true,
  'QEMU-driven LED blink cycle',
);
assertEqual(
  report.iframeUart?.coreIo?.buttonPressObserved,
  true,
  'Button press view/action round trip',
);
assertEqual(
  report.iframeUart?.coreIo?.buttonHeldLedOn,
  true,
  'Button-controlled LED hold',
);
assertEqual(
  report.iframeUart?.coreIo?.buttonReleaseObserved,
  true,
  'Button release view/action round trip',
);
assertEqual(
  report.iframeUart?.coreIo?.electricalDiagnosticsForwarded,
  true,
  'electrical diagnostics Host-to-iframe forwarding',
);
assertEqual(
  report.iframeUart?.coreIo?.electricalDiagnosticRecoveryObserved,
  true,
  'electrical diagnostic revision and recovery',
);
assertEqual(
  report.iframeUart?.legacyBlocklyDebugUiRemoved,
  true,
  'legacy Blockly debug UI removal',
);
assertEqual(
  report.iframeUart?.debugPanelCollapsible,
  true,
  'iframe debug panel collapse control',
);
assertEqual(
  report.iframeUart?.debugPanelCollapseRoundTrip,
  true,
  'iframe debug panel collapse round trip',
);
assertEqual(report.gdb?.status, 'passed', 'GDB status');
assertEqual(
  report.gdb?.artifactId,
  report.builder?.artifactId,
  'Builder/GDB Artifact identity',
);
assertEqual(
  report.iframeUart?.debugBreakpointBlockId,
  report.breakpoint?.blockId,
  'iframe/project breakpoint identity',
);
assertEqual(
  report.iframeUart?.debugStackBlockId,
  report.breakpoint?.blockId,
  'iframe stack/project breakpoint identity',
);
assertEqual(
  report.gdb?.blockId,
  report.breakpoint?.blockId,
  'GDB/project breakpoint identity',
);
assertEqual(
  report.gdb?.frame?.blockId,
  report.breakpoint?.blockId,
  'GDB frame/project breakpoint identity',
);
assertEqual(
  report.gdb?.stackTop?.blockId,
  report.breakpoint?.blockId,
  'GDB stack/project breakpoint identity',
);
assertEqual(
  report.gdb?.sourceMapRevision,
  report.breakpoint?.sourceMapRevision,
  'GDB/project source-map revision',
);
assertEqual(
  report.iframeUart?.debugStoppedFunction,
  report.gdb?.frame?.functionName,
  'iframe/GDB stopped function',
);
assertTrue(
  Number.isSafeInteger(report.iframeUart?.debugThreads?.count)
    && report.iframeUart.debugThreads.count >= 1
    && report.iframeUart.debugThreads.count <= 128,
  'iframe GDB thread count',
);
assertTrue(
  Array.isArray(report.iframeUart?.debugThreads?.labels)
    && report.iframeUart.debugThreads.labels.length
      === report.iframeUart.debugThreads.count
    && report.iframeUart.debugThreads.labels.every(
      (label) => typeof label === 'string' && label.trim().length > 0,
    ),
  'iframe GDB thread labels',
);
assertNonEmpty(
  report.iframeUart?.debugThreads?.selectedLabel,
  'iframe selected GDB thread label',
);
assertEqual(
  report.iframeUart?.debugThreads?.switchRoundTrip,
  true,
  'iframe GDB thread switch round trip',
);
assertTrue(
  Number.isSafeInteger(report.iframeUart?.debugTasks?.count)
    && report.iframeUart.debugTasks.count >= 1
    && report.iframeUart.debugTasks.count <= 128,
  'iframe FreeRTOS task count',
);
assertTrue(
  Array.isArray(report.iframeUart?.debugTasks?.ids)
    && report.iframeUart.debugTasks.ids.length
      === report.iframeUart.debugTasks.count
    && report.iframeUart.debugTasks.ids.every(
      (id) => typeof id === 'string' && /^tcb:[0-9a-f]+$/.test(id),
    ),
  'iframe bounded FreeRTOS task identities',
);
assertTrue(
  Array.isArray(report.iframeUart?.debugTasks?.labels)
    && report.iframeUart.debugTasks.labels.length
      === report.iframeUart.debugTasks.count
    && report.iframeUart.debugTasks.labels.every(
      (label) => typeof label === 'string' && label.trim().length > 0,
    ),
  'iframe FreeRTOS task labels',
);
assertEqual(
  report.iframeUart?.debugTasks?.includesLoopTask,
  true,
  'iframe Arduino loop task awareness',
);
assertEqual(
  report.iframeUart?.debugTasks?.readOnly,
  true,
  'iframe FreeRTOS tasks remain read-only',
);
assertEqual(
  report.iframeUart?.debugWatch?.expression,
  'debugCounter',
  'iframe watch expression',
);
assertEqual(
  report.iframeUart?.debugWatch?.value,
  '3',
  'iframe watch value',
);
assertNonEmpty(
  report.iframeUart?.debugWatch?.type,
  'iframe watch type',
);
assertEqual(
  report.iframeUart?.debugVariable?.name,
  'debugCounter',
  'iframe variable name',
);
assertEqual(
  report.iframeUart?.debugVariable?.value,
  '3',
  'iframe variable value',
);
assertNonEmpty(
  report.iframeUart?.debugVariable?.type,
  'iframe variable type',
);
assertEqual(
  report.iframeUart?.debugVariableExpansion?.name,
  'debugLabel',
  'expanded variable name',
);
assertTrue(
  Number.isSafeInteger(
    report.iframeUart?.debugVariableExpansion?.childCount,
  )
    && report.iframeUart.debugVariableExpansion.childCount >= 1,
  'expanded variable child count',
);
assertNonEmpty(
  report.iframeUart?.debugVariableExpansion?.firstChildName,
  'expanded variable first child name',
);
assertNonEmpty(
  report.iframeUart?.debugVariableExpansion?.firstChildType,
  'expanded variable first child type',
);
assertTrue(
  Number.isSafeInteger(
    report.iframeUart?.debugVariableExpansion?.recursiveDepth,
  )
    && report.iframeUart.debugVariableExpansion.recursiveDepth >= 2,
  'expanded variable recursive depth',
);
assertNonEmpty(
  report.iframeUart?.debugVariableExpansion?.deepestChildName,
  'expanded variable deepest child name',
);
assertNonEmpty(
  report.iframeUart?.debugVariableExpansion?.deepestChildType,
  'expanded variable deepest child type',
);
assertTrue(
  typeof report.iframeUart?.debugVariableExpansion
    ?.paginationObserved === 'boolean',
  'expanded variable pagination observation',
);
assertEqual(
  report.iframeUart?.debugConfigurationLifecycle?.functionBreakpoint,
  'vTaskDelay',
  'temporary function breakpoint target',
);
assertEqual(
  report.iframeUart?.debugConfigurationLifecycle?.breakpointAdded,
  true,
  'temporary function breakpoint addition',
);
assertEqual(
  report.iframeUart?.debugConfigurationLifecycle?.breakpointRemoved,
  true,
  'temporary function breakpoint removal',
);
assertEqual(
  report.iframeUart?.debugConfigurationLifecycle?.watchRemoved,
  true,
  'watch removal',
);
assertEqual(
  report.iframeUart?.debugConfigurationLifecycle?.watchReadded,
  true,
  'watch re-addition',
);
assertEqual(
  report.iframeUart?.debugConfigurationLifecycle
    ?.activeConfigurationCountAfterCleanup,
  2,
  'active session configuration count after cleanup',
);
assertEqual(
  report.iframeUart?.debugSourceContext?.file,
  'sketch.ino',
  'iframe source context file',
);
assertEqual(
  report.iframeUart?.debugSourceContext?.revision,
  report.builder?.sourceSha256,
  'iframe/Artifact source revision',
);
assertEqual(
  report.iframeUart?.debugSourceContext?.initialLine,
  report.gdb?.frame?.location?.line,
  'iframe/GDB initial source line',
);
assertEqual(
  report.iframeUart?.debugSourceContext?.initialBlockId,
  report.breakpoint?.blockId,
  'iframe/project initial source block',
);
assertNonEmpty(
  report.iframeUart?.debugSourceContext?.initialText,
  'iframe initial source text',
);
assertTrue(
  Number.isSafeInteger(
    report.iframeUart?.debugSourceContext?.visibleLineCount,
  )
    && report.iframeUart.debugSourceContext.visibleLineCount >= 1
    && report.iframeUart.debugSourceContext.visibleLineCount <= 21,
  'bounded iframe source context line count',
);
const stepOverSourceLine = Number(
  /:(\d+)$/.exec(report.iframeUart?.debugStepOver?.location || '')?.[1],
);
assertEqual(
  report.iframeUart?.debugSourceContext?.stepOverLine,
  stepOverSourceLine,
  'iframe/step-over source line',
);
assertEqual(
  report.iframeUart?.debugSourceContext?.stepOverBlockId,
  'debug-delay-block',
  'iframe step-over source block',
);
assertTrue(
  typeof report.iframeUart?.debugSourceContext?.externalFile === 'string'
    && report.iframeUart.debugSourceContext.externalFile.length >= 1
    && !path.posix.isAbsolute(
      report.iframeUart.debugSourceContext.externalFile,
    )
    && !path.win32.isAbsolute(
      report.iframeUart.debugSourceContext.externalFile,
    ),
  'external source relative file',
);
assertTrue(
  Number.isSafeInteger(
    report.iframeUart?.debugSourceContext?.externalLine,
  )
    && report.iframeUart.debugSourceContext.externalLine >= 1,
  'external source line',
);
assertEqual(
  report.iframeUart?.debugSourceContext?.externalSourceWithheld,
  true,
  'external source contents withheld',
);
assertTrue(
  Number.isSafeInteger(
    report.iframeUart?.debugSourceContext?.selectedFrameLine,
  )
    && report.iframeUart.debugSourceContext.selectedFrameLine >= 1,
  'selected frame source line',
);
assertEqual(
  report.iframeUart?.debugSourceGutter?.file,
  'sketch.ino',
  'source gutter file',
);
assertEqual(
  report.iframeUart?.debugSourceGutter?.revision,
  report.builder?.sourceSha256,
  'source gutter Artifact revision',
);
assertTrue(
  Number.isSafeInteger(report.iframeUart?.debugSourceGutter?.line)
    && report.iframeUart.debugSourceGutter.line >= 1
    && Math.abs(
      report.iframeUart.debugSourceGutter.line
      - report.iframeUart.debugSourceContext.initialLine
    ) <= 10,
  'source gutter line is inside the visible Artifact window',
);
assertEqual(
  report.iframeUart?.debugSourceGutter?.breakpointAdded,
  true,
  'source gutter breakpoint addition',
);
assertEqual(
  report.iframeUart?.debugSourceGutter?.breakpointRemoved,
  true,
  'source gutter breakpoint removal',
);
assertEqual(
  report.iframeUart?.debugSourceGutter?.blockCollisionProtected,
  true,
  'source gutter does not duplicate a resolved block breakpoint',
);
assertEqual(
  report.iframeUart?.debugFrameSelection?.functionName,
  'loop',
  'selected stack frame function',
);
assertTrue(
  Number.isSafeInteger(
    report.iframeUart?.debugFrameSelection?.frameLevel,
  )
    && report.iframeUart.debugFrameSelection.frameLevel >= 1,
  'selected stack frame level',
);
assertEqual(
  report.iframeUart?.debugFrameSelection?.variableName,
  'debugCounter',
  'selected stack frame variable name',
);
assertEqual(
  report.iframeUart?.debugFrameSelection?.variableValue,
  '3',
  'selected stack frame variable value',
);
assertNonEmpty(
  report.iframeUart?.debugRegisters?.firstPageName,
  'first register page name',
);
assertNonEmpty(
  report.iframeUart?.debugRegisters?.firstPageValue,
  'first register page value',
);
assertNonEmpty(
  report.iframeUart?.debugRegisters?.secondPageName,
  'second register page name',
);
assertNonEmpty(
  report.iframeUart?.debugRegisters?.secondPageValue,
  'second register page value',
);
assertTrue(
  report.iframeUart?.debugRegisters?.firstPageName
    !== report.iframeUart?.debugRegisters?.secondPageName,
  'register pagination must advance to a different register',
);
assertTrue(
  /^[a-z0-9_-]{1,64}$/i.test(
    report.iframeUart?.debugMemory?.regionId || '',
  ),
  'iframe memory region id',
);
assertTrue(
  /^0x[0-9a-f]{8}$/i.test(
    report.iframeUart?.debugMemory?.address || '',
  ),
  'iframe memory address',
);
assertEqual(
  report.iframeUart?.debugMemory?.length,
  16,
  'iframe memory read length',
);
assertTrue(
  /^0x[0-9a-f]{8}\s{2}(?:[0-9a-f]{2}\s?){16}/i.test(
    report.iframeUart?.debugMemory?.firstLine || '',
  ),
  'iframe memory dump first line',
);
assertNonEmpty(
  report.iframeUart?.debugStepInto?.functionName,
  'step-into function',
);
assertTrue(
  report.iframeUart?.debugStepInto?.functionName !== 'loop',
  'step-into must leave loop()',
);
assertNonEmpty(
  report.iframeUart?.debugStepInto?.location,
  'step-into location',
);
assertTrue(
  Number.isSafeInteger(report.iframeUart?.debugStepInto?.attempts)
    && report.iframeUart.debugStepInto.attempts >= 1
    && report.iframeUart.debugStepInto.attempts <= 8,
  'step-into attempt count',
);
assertEqual(
  report.iframeUart?.debugStepOver?.functionName,
  'loop',
  'step-over function',
);
assertEqual(
  report.iframeUart?.debugStepOver?.blockId,
  'debug-delay-block',
  'step-over Blockly block',
);
assertTrue(
  /^sketch\.ino:\d+$/.test(
    report.iframeUart?.debugStepOver?.location || '',
  ),
  'step-over source location',
);
assertTrue(
  Number.isSafeInteger(report.iframeUart?.debugStepOver?.attempts)
    && report.iframeUart.debugStepOver.attempts >= 1
    && report.iframeUart.debugStepOver.attempts <= 8,
  'step-over attempt count',
);
assertEqual(
  report.iframeUart?.debugBlockControls?.selectedTargetBlockId,
  'debug-delay-block',
  'selected Blockly debug target',
);
assertEqual(
  report.iframeUart?.debugBlockControls?.targetPreservedWhileStopped,
  true,
  'selected target/current execution block separation',
);
assertEqual(
  report.iframeUart?.debugBlockControls?.runToBlockId,
  'debug-delay-block',
  'run-to-selected Blockly block',
);
assertTrue(
  /^sketch\.ino:\d+$/.test(
    report.iframeUart?.debugBlockControls?.runToLocation || '',
  ),
  'run-to-selected source location',
);
assertEqual(
  report.iframeUart?.debugBlockControls?.temporaryBreakpointCleaned,
  true,
  'run-to-selected temporary breakpoint cleanup',
);
assertEqual(
  report.iframeUart?.debugBlockControls?.configurationCountPreserved,
  true,
  'run-to-selected configuration preservation',
);
assertEqual(
  report.iframeUart?.debugBlockControls?.stepBlockId,
  'debug-delay-block',
  'next Blockly statement block',
);
assertTrue(
  /^sketch\.ino:\d+$/.test(
    report.iframeUart?.debugBlockControls?.stepBlockLocation || '',
  ),
  'next Blockly statement source location',
);
assertTrue(
  Number.isSafeInteger(
    report.iframeUart?.debugRecovery?.firstProcessId,
  )
    && report.iframeUart.debugRecovery.firstProcessId >= 1,
  'pre-crash QEMU process id',
);
assertTrue(
  Number.isSafeInteger(
    report.iframeUart?.debugRecovery?.recoveredProcessId,
  )
    && report.iframeUart.debugRecovery.recoveredProcessId >= 1,
  'recovered QEMU process id',
);
assertTrue(
  report.iframeUart?.debugRecovery?.firstProcessId
    !== report.iframeUart?.debugRecovery?.recoveredProcessId,
  'recovery must create a fresh QEMU process',
);
assertEqual(
  report.iframeUart?.debugRecovery?.recoveryCount,
  1,
  'runtime recovery count',
);
assertEqual(
  report.iframeUart?.debugRecovery?.automaticRestorePrevented,
  true,
  'automatic debugger configuration restore prevention',
);
assertTrue(
  Number.isSafeInteger(report.iframeUart?.debugRecovery?.restorePasses)
    && report.iframeUart.debugRecovery.restorePasses >= 1
    && report.iframeUart.debugRecovery.restorePasses <= 2,
  'explicit debugger configuration restore pass count',
);
assertEqual(
  report.iframeUart?.debugRecovery?.breakpointRestored,
  true,
  'breakpoint restore result',
);
assertEqual(
  report.iframeUart?.debugRecovery?.watchRestored,
  true,
  'watch restore result',
);
assertEqual(
  report.iframeUart?.debugRecovery?.restoredWatchValue,
  '3',
  'restored watch value',
);
assertTrue(
  typeof report.gdb?.frame?.location?.file === 'string'
    && !path.posix.isAbsolute(report.gdb.frame.location.file)
    && !path.win32.isAbsolute(report.gdb.frame.location.file),
  'GDB frame source file must remain relative',
);
assertTrue(
  Number.isSafeInteger(report.gdb?.frame?.location?.line)
    && report.gdb.frame.location.line >= 1,
  'GDB frame source line must be a positive integer',
);

if (failures.length) {
  throw new Error(
    `Simulator debug E2E report validation failed:\n- ${failures.join('\n- ')}`,
  );
}

console.log(JSON.stringify({
  status: 'passed',
  reportPath,
  artifactId: report.builder.artifactId,
  blockId: report.breakpoint.blockId,
  functionName: report.gdb.frame.functionName,
  source: report.gdb.frame.location,
  debugPanelOwner: report.iframeUart.debugPanelOwner,
  debugPanelCollapsible: report.iframeUart.debugPanelCollapsible,
  watch: report.iframeUart.debugWatch,
  variable: report.iframeUart.debugVariable,
  variableExpansion: report.iframeUart.debugVariableExpansion,
  configurationLifecycle:
    report.iframeUart.debugConfigurationLifecycle,
  sourceContext: report.iframeUart.debugSourceContext,
  sourceGutter: report.iframeUart.debugSourceGutter,
  frameSelection: report.iframeUart.debugFrameSelection,
  registers: report.iframeUart.debugRegisters,
  memory: report.iframeUart.debugMemory,
  stepOver: report.iframeUart.debugStepOver,
  blockControls: report.iframeUart.debugBlockControls,
  stepInto: report.iframeUart.debugStepInto,
  recovery: report.iframeUart.debugRecovery,
}, null, 2));

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    failures.push(
      `${label}: expected ${JSON.stringify(expected)}, got ${
        JSON.stringify(actual)
      }`,
    );
  }
}

function assertTrue(condition, label) {
  if (!condition) failures.push(label);
}

function assertNonEmpty(value, label) {
  assertTrue(
    typeof value === 'string' && value.trim().length > 0,
    `${label} must be a non-empty string`,
  );
}

function assertSha256(value, label) {
  assertTrue(
    typeof value === 'string' && /^[a-f0-9]{64}$/.test(value),
    `${label} must be a lowercase SHA-256`,
  );
}
