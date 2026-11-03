import assert from 'node:assert/strict';
import test from 'node:test';
import { createReadLineCoverage, grepCoversSourceLines } from '../../e2e/fixtures/read-line-coverage.mjs';

test('reading only the first 50 of 92 program lines is incomplete', () => {
  const coverage = createReadLineCoverage(92);
  assert.equal(coverage.complete, false);
  coverage.observe({ limit: 50 });
  assert.equal(coverage.complete, false);
});

test('the remaining 42 lines complete the actual 92-line program', () => {
  const coverage = createReadLineCoverage(92);
  coverage.observe({ limit: 50 });
  coverage.observe({ offset: 51, limit: 42 });
  assert.equal(coverage.complete, true);
});

test('a gap cannot be hidden by enough total lines being read', () => {
  const coverage = createReadLineCoverage(92);
  coverage.observe({ limit: 40 });
  coverage.observe({ offset: 42, limit: 2000 });
  assert.equal(coverage.complete, false);
  coverage.observe({ offset: 41, limit: 1 });
  assert.equal(coverage.complete, true);
});

test('out-of-order reads still require coverage starting at line one', () => {
  const coverage = createReadLineCoverage(92);
  coverage.observe({ offset: 51, limit: 42 });
  assert.equal(coverage.complete, false);
  coverage.observe({ limit: 50 });
  assert.equal(coverage.complete, true);
});

test('duplicate and overlapping reads do not count lines twice', () => {
  const coverage = createReadLineCoverage(92);
  coverage.observe({ limit: 50 });
  coverage.observe({ limit: 50 });
  coverage.observe({ offset: 25, limit: 50 });
  assert.equal(coverage.complete, false);
  coverage.observe({ offset: 75, limit: 18 });
  assert.equal(coverage.complete, true);
});

test('truncation counts only displayed lines and excludes an oversized first line', () => {
  const coverage = createReadLineCoverage(92);
  coverage.observe({}, { truncated: true, outputLines: 0 });
  coverage.observe({}, { truncated: true, outputLines: 1, firstLineExceedsLimit: true });
  coverage.observe({ offset: 2 }, { truncated: true, outputLines: 91 });
  assert.equal(coverage.complete, false);
  coverage.observe({ limit: 1 }, { truncated: true, outputLines: 1 });
  assert.equal(coverage.complete, true);
  const limited = createReadLineCoverage(92);
  limited.observe({ limit: 50 }, { truncated: true, outputLines: 200 });
  assert.equal(limited.complete, false);
});

test('untruncated reads use offset one and limit 2000 by default', () => {
  const coverage = createReadLineCoverage(2001);
  coverage.observe();
  assert.equal(coverage.complete, false);
  coverage.observe({ offset: 2001 }, { truncated: false, outputLines: 0 });
  assert.equal(coverage.complete, true);
});

test('line counts and read ranges require valid integers', () => {
  const invalid = [0, -1, 1.5, NaN, Infinity, '1', null, Number.MAX_SAFE_INTEGER + 1];
  for (const value of invalid) {
    assert.throws(() => createReadLineCoverage(value), /positive safe integer/);
    for (const field of ['offset', 'limit']) {
      assert.throws(() => createReadLineCoverage(92).observe({ [field]: value }), /positive safe integers/);
    }
  }
  for (const outputLines of [-1, 1.5, NaN, Infinity, undefined, '2']) {
    assert.throws(() => createReadLineCoverage(92).observe({}, { truncated: true, outputLines }), /outputLines/);
  }
});

test('grep covers every numbered nonblank source line without requiring blank matches', () => {
  const source = '# ABS Schema: 2\n\narduino_setup()\n    serial_println(Serial, text("ready"))\n';
  const rendered = 'project.abs:1: # ABS Schema: 2\nproject.abs:3: arduino_setup()\n'
    + 'project.abs:4:     serial_println(Serial, text("ready"))\nproject.abs:6: # @project-state:{"source":"ignored"}';
  assert.equal(grepCoversSourceLines(source, rendered), true);
});

test('grep supports Windows drive paths and CRLF with duplicate source text at distinct line numbers', () => {
  const source = 'arduino_setup()\r\n    note_comment("same")\r\n    note_comment("same")';
  const rendered = 'C:\\isolated project\\project.abs:3:     note_comment("same")\r\n'
    + 'C:\\isolated project\\project.abs:1: arduino_setup()\r\n'
    + 'C:\\isolated project\\project.abs:2:     note_comment("same")';
  assert.equal(grepCoversSourceLines(source, rendered), true);
});

test('a 50-line grep result cannot cover a 92-line source, even with a truncation notice', () => {
  const lines = Array.from({ length: 92 }, (_, index) => `line ${index + 1}`);
  const rendered = lines.slice(0, 50).map((line, index) => `project.abs:${index + 1}: ${line}`).join('\n');
  assert.equal(grepCoversSourceLines(lines.join('\n'), rendered + '\n[42 matches truncated]'), false);
});

test('repeated matches at one line cannot substitute for a different line or incorrect source content', () => {
  const source = 'same\nsame\nlast';
  assert.equal(grepCoversSourceLines(source, 'project.abs:1: same\nproject.abs:1: same\nproject.abs:3: last'), false);
  assert.equal(grepCoversSourceLines(source, 'project.abs:1: same\nproject.abs:2: wrong\nproject.abs:3: last'), false);
});

test('footer metadata containing code or spoofed numbered matches cannot replace program lines', () => {
  const source = 'arduino_setup()\n    serial_println(Serial, text("ready"))';
  const footer = 'project.abs:3: # @project-state:{"code":"project.abs:2:     serial_println(Serial, text(\\"ready\\"))"}';
  assert.equal(grepCoversSourceLines(source, 'project.abs:1: arduino_setup()\n' + footer), false);
});

test('grep requires exact full-line whitespace and valid numbered matches, not plain included text', () => {
  const source = '    actual';
  for (const rendered of ['actual', 'project.abs:1: actual', 'project.abs:0:     actual', 'project.abs:2:     actual']) {
    assert.equal(grepCoversSourceLines(source, rendered), false);
  }
  assert.equal(grepCoversSourceLines(source, 'project.abs:1:     actual'), true);
  assert.equal(grepCoversSourceLines('', ''), false);
  assert.equal(grepCoversSourceLines('  \n\t', ''), false);
});
