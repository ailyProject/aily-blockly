import {
  AILY_BUILDER_PROGRESS_PREFIX,
  AilyBuilderOutputLineBuffer,
  parseAilyBuilderProgressLine
} from './aily-builder-progress.utils';

describe('AilyBuilderOutputLineBuffer', () => {
  it('reassembles a structured progress line split across stdout chunks', () => {
    const buffer = new AilyBuilderOutputLineBuffer();
    const progressLine = `${AILY_BUILDER_PROGRESS_PREFIX} {"protocolVersion":1,"stage":"core","percent":45,"status":"running","message":"Compiling core"}`;

    expect(buffer.append('stdout', progressLine.slice(0, 30))).toEqual([]);
    const lines = buffer.append('stdout', `${progressLine.slice(30)}\n`);

    expect(lines).toEqual([{ line: progressLine, type: 'stdout' }]);
    expect(parseAilyBuilderProgressLine(lines[0].line)?.percent).toBe(45);
  });

  it('does not mix interleaved stderr into a partial stdout line', () => {
    const buffer = new AilyBuilderOutputLineBuffer();

    expect(buffer.append('stdout', '[aily-builder:progress] {"protocol')).toEqual([]);
    expect(buffer.append('stderr', 'compiler warning\n')).toEqual([
      { line: 'compiler warning', type: 'stderr' }
    ]);
    expect(buffer.append('stdout', 'Version":1}\n')).toEqual([
      { line: '[aily-builder:progress] {"protocolVersion":1}', type: 'stdout' }
    ]);
  });

  it('flushes final lines that do not end with a newline', () => {
    const buffer = new AilyBuilderOutputLineBuffer();

    buffer.append('stdout', 'last stdout line');
    buffer.append('stderr', 'last stderr line');

    expect(buffer.flush()).toEqual([
      { line: 'last stdout line', type: 'stdout' },
      { line: 'last stderr line', type: 'stderr' }
    ]);
    expect(buffer.flush()).toEqual([]);
  });
});
