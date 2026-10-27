import { readAbsSyntax } from './abs-syntax';
import { walkAbsRawSyntax, type AbsRawNode } from './abs-syntax-binding';

describe('raw ABS executable activity', () => {
  const activity = (source: string) => [...walkAbsRawSyntax(readAbsSyntax('# ABS Schema: 2\n' + source))]
    .map(({ node, disabled }) => [node.type, disabled]);
  it('does not disable an explicit next continuation with its predecessor', () => {
    expect(activity('first() @disabled\n    @next: second()\n')).toEqual([['first', true], ['second', false]]);
    expect(activity('first() @disabled\n    @next:\n        second()\n')).toEqual([['first', true], ['second', false]]);
  });
  it('retains the enclosing disabled scope for next, positional values and statement siblings', () => {
    expect(activity('container(value()) @disabled\n    first() @disabled\n        @next: second()\n    third()\n'))
      .toEqual([['container', true], ['value', true], ['first', true], ['second', true], ['third', true]]);
    expect(activity('container()\n    first() @disabled\n    second()\n')).toEqual([['container', false], ['first', true], ['second', false]]);
  });
  it('walks deep synthetic next syntax iteratively and preserves traversal order', () => {
    const node = (index: number): AbsRawNode => ({ type: `b${index}`, parameters: [], sections: [], disabled: index === 0, start: index, end: index + 1 });
    const root = node(0); let previous = root;
    for (let index = 1; index < 6000; index++) { const next = node(index); previous.sections.push({ name: 'next', children: [next] }); previous = next; }
    const entries = [...walkAbsRawSyntax([root])];
    expect(entries.length).toBe(6000); expect(entries[0].disabled).toBeTrue();
    expect(entries[5999].node.type).toBe('b5999'); expect(entries[5999].disabled).toBeFalse();
  });
});
