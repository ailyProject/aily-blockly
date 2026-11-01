import assert from 'node:assert/strict';

export function createReadLineCoverage(totalLines) {
  const positive = value => Number.isSafeInteger(value) && value > 0;
  assert.ok(positive(totalLines), 'totalLines must be a positive safe integer');
  const ranges = [];
  return {
    observe({ offset = 1, limit = 2000 } = {}, truncation) {
      assert.ok(positive(offset) && positive(limit), 'offset and limit must be positive safe integers');
      const shown = truncation?.truncated
        ? truncation.firstLineExceedsLimit ? 0 : truncation.outputLines
        : limit;
      assert.ok(Number.isSafeInteger(shown) && shown >= 0, 'outputLines must be a nonnegative safe integer');
      if (shown > 0 && offset <= totalLines) ranges.push([offset, Math.min(totalLines, offset + Math.min(shown, limit) - 1)]);
    },
    get complete() {
      let through = 0;
      for (const [start, end] of ranges.toSorted((a, b) => a[0] - b[0])) {
        if (start > through + 1) break;
        through = Math.max(through, end);
      }
      return through >= totalLines;
    }
  };
}

export function grepCoversSourceLines(source, renderedText) {
  assert.equal(typeof source, 'string');
  assert.equal(typeof renderedText, 'string');
  const lines = source.split(/\r?\n/), covered = new Set();
  for (const output of renderedText.split(/\r?\n/)) {
    const match = /^(?:[A-Za-z]:)?[^:\r\n]+:([1-9]\d*): (.*)$/.exec(output);
    if (!match) continue;
    const number = Number(match[1]);
    if (Number.isSafeInteger(number) && number <= lines.length && match[2] === lines[number - 1]) covered.add(number);
  }
  return lines.some(line => line.trim()) && lines.every((line, index) => !line.trim() || covered.has(index + 1));
}
