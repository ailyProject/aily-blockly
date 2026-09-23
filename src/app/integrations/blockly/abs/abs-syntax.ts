import { readAbsJsonToken, readAbsSingleQuotedToken } from '@shared/public-api';
import { readAbsFieldToken } from './abs-field-values';
import { ABS_SCHEMA_HEADER, AbsSyntaxNode, AbsSyncError } from './abs-state';
import { bindAbsSyntax, type AbsRawNode, type AbsRawValue, type AbsSyntaxOptions } from './abs-syntax-binding';
export type { AbsArgumentDefinition, AbsSyntaxOptions } from './abs-syntax-binding';

/** The existing grammar, first read without looking up definitions or executing callbacks. */
export function readAbsSyntax(source: string): AbsRawNode[] {
  if (!source.split(/\r?\n/).some(line => line.trim() === ABS_SCHEMA_HEADER)) {
    throw new AbsSyncError('ABS_SCHEMA_UNSUPPORTED', 'Expected ABS Schema: 2.', undefined, [], {
      reason: 'abs-schema-header',
      hint: 'Retain any old draft. Use the current host export/recovery workflow for a valid baseline, then transfer intended edits. Do not just add a header, discard the map or initialize over a draft.',
    });
  }
  return new AbsSyntaxReader(source).read();
}

/** Existing callers retain the same API and pure definition-bound semantics. */
export function parseAbsSyntax(source: string, options: AbsSyntaxOptions = {}): AbsSyntaxNode[] {
  return bindAbsSyntax(readAbsSyntax(source), options);
}

class AbsSyntaxReader {
  private offset = 0;
  private depth = 0;
  private blockDepth = 0;
  private nodes = 0;
  private indentWidth?: number;
  private indentCharacter?: string;
  constructor(private readonly source: string) {}

  read(): AbsRawNode[] {
    const roots: AbsRawNode[] = [];
    while (this.skipLines()) {
      if (this.indent() !== 0) this.fail('Root blocks must not be indented.');
      roots.push(this.block(0));
    }
    return roots;
  }

  private block(indent: number): AbsRawNode {
    if (++this.blockDepth > 128) this.fail('ABS block nesting exceeds parsing limits.');
    this.offset += indent;
    const node = this.expression();
    this.endLine();
    while (this.skipLines() && this.indent() > indent) {
      const sectionIndent = this.indent();
      this.childIndent(indent, sectionIndent);
      if (this.source[this.offset + sectionIndent] !== '@') {
        node.sections.push({ children: this.chain(sectionIndent) });
        node.end = this.offset;
        continue;
      }
      this.offset += sectionIndent;
      this.expect('@');
      const name = this.argumentName();
      this.space(); this.expect(':'); this.space();
      const section: AbsRawNode['sections'][number] = { name, children: [] };
      if (this.offset < this.source.length && !/[\r\n#]/.test(this.source[this.offset])) {
        section.inline = this.valueInput();
        this.endLine();
      } else {
        this.endLine();
        if (this.skipLines() && this.indent() > sectionIndent) {
          this.childIndent(sectionIndent, this.indent());
          section.children = this.chain(this.indent());
        }
      }
      node.sections.push(section);
      node.end = this.offset;
    }
    this.blockDepth--;
    return node;
  }

  private chain(indent: number): AbsRawNode[] {
    const children = [this.block(indent)];
    while (this.skipLines() && this.indent() === indent && this.source[this.offset + indent] !== '@') {
      children.push(this.block(indent));
    }
    return children;
  }

  private valueInput(): AbsRawValue {
    const start = this.offset;
    if (/^[\w]+\s*\(/.test(this.source.slice(this.offset))) {
      const child = this.expression();
      return { child, start, end: this.offset };
    }
    this.literalEnd();
    if (++this.nodes > 100000) this.fail('ABS structure exceeds parsing limits.');
    return { token: readAbsFieldToken(this.source.slice(start, this.offset)), start, end: this.offset };
  }

  private expression(): AbsRawNode {
    if (++this.depth > 128 || ++this.nodes > 100000) this.fail('ABS structure exceeds parsing limits.');
    const node: AbsRawNode = {
      type: '', parameters: [], sections: [],
      disabled: false, start: this.offset, end: this.offset,
    };
    node.type = this.name();
    this.space();
    if (this.source[this.offset] !== '(') {
      node.omittedParentheses = true; node.end = this.offset; this.depth--; return node;
    }
    this.expect('(');
    this.space(true);
    // Parse values first; @extra follows the call and determines this instance's shape.
    const parameters = node.parameters;
    let sawNamed = false;
    while (this.source[this.offset] !== ')') {
      let name: string | undefined;
      const quotedName = this.source[this.offset] === '"' ? readAbsJsonToken(this.source, this.offset) : undefined;
      if (/^[A-Za-z_]\w*\s*=/.test(this.source.slice(this.offset))
        || (quotedName && /^\s*=/.test(this.source.slice(quotedName.end)))) {
        sawNamed = true;
        name = this.argumentName();
        this.space(true);
        this.expect('=');
        this.space(true);
      } else {
        if (sawNamed) this.fail('Positional arguments must precede named arguments.');
      }
      const start = this.offset;
      if (this.source[this.offset] === ',' && name === undefined) {
        parameters.push({ token: { raw: '', value: '', quoted: false, omitted: true }, start, end: start });
      } else if (/^[\w]+\s*\(/.test(this.source.slice(this.offset))) {
        const child = this.expression();
        parameters.push({ name, child, start, end: this.offset });
      } else {
        this.literalEnd();
        try {
          const token = readAbsFieldToken(this.source.slice(start, this.offset));
          parameters.push({ name, token, start, end: this.offset });
        }
        catch (error) { this.fail(String(error)); }
      }
      this.space(true);
      if (this.source[this.offset] === ')') break;
      if (this.source[this.offset] !== ',') this.argumentSeparator(node.type, parameters[parameters.length - 1]);
      this.offset++;
      this.space(true);
    }
    this.expect(')');
    this.space();
    while (this.source[this.offset] === '@') {
      this.offset++;
      const annotation = this.name();
      if (annotation === 'disabled') {
        if (node.disabled) this.fail('Duplicate @disabled.');
        node.disabled = true;
      } else if (annotation === 'extra') {
        if (Object.hasOwn(node, 'extraState')) this.fail('Duplicate @extra.');
        this.expect(':');
        this.space();
        const start = this.offset;
        this.literalEnd();
        try { node.extraState = JSON.parse(this.source.slice(start, this.offset)); }
        catch { this.fail('Invalid @extra JSON.'); }
        node.extraRange = { start, end: this.offset };
      } else this.fail(`Unsupported annotation @${annotation}.`);
      this.space();
    }
    node.end = this.offset;
    this.depth--;
    return node;
  }

  private literalEnd(): void {
    const char = this.source[this.offset];
    if (char === '$' && this.source[this.offset + 1] === '"') {
      try { this.offset = readAbsJsonToken(this.source, this.offset + 1).end; }
      catch (error) { this.fail(String(error)); }
    } else if (char === "'") {
      try { this.offset = readAbsSingleQuotedToken(this.source, this.offset).end; }
      catch (error) { this.fail(String(error)); }
    } else if (char === '"' || char === '{' || char === '[') {
      try { this.offset = readAbsJsonToken(this.source, this.offset).end; }
      catch (error) { this.fail(String(error)); }
    } else {
      const match = /^[^\s,()@#]+/.exec(this.source.slice(this.offset));
      if (!match) this.fail('Expected a field value.');
      this.offset += match[0].length;
      // Commas delimit arguments, not horizontal spaces. Accept word-like
      // enum/text atoms without swallowing a missing separator between numbers,
      // references, named arguments or nested calls. Newlines remain boundaries.
      if (/^[\p{L}_][\p{L}\p{N}_]*$/u.test(match[0])) {
        const rest = /^(?:[ \t]+[\p{L}_][\p{L}\p{N}_]*)+/u.exec(this.source.slice(this.offset));
        if (rest && /^[ \t]*(?:[,\r\n)@#]|$)/.test(this.source.slice(this.offset + rest[0].length))) {
          this.offset += rest[0].length;
        }
      }
    }
  }

  private argumentName(): string {
    if (this.source[this.offset] !== '"') return this.name();
    const token = readAbsJsonToken(this.source, this.offset);
    const value = JSON.parse(this.source.slice(this.offset, token.end));
    this.offset = token.end;
    return value;
  }

  /** Explain malformed argument boundaries without guessing a field definition or repairing source. */
  private argumentSeparator(blockType: string, parameter: AbsRawValue): never {
    const start = parameter.start;
    const hint = 'Separate arguments with commas and close the call with ). Quote text containing syntax punctuation; keep nested block calls separate.';
    throw new AbsSyncError('ABS_SYNTAX_INVALID', `Expected , or ) after an argument in ${blockType}.`,
      { start: this.offset, end: this.offset + 1 }, [], {
        blockType, reason: 'argument-separator', received: this.source.slice(start, start + 160), hint,
      });
  }

  private name(): string {
    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.source.slice(this.offset));
    if (!match) this.fail('Expected an identifier.');
    this.offset += match[0].length;
    return match[0];
  }
  private expect(char: string): void {
    if (this.source[this.offset] !== char) this.fail(`Expected ${char}.`);
    this.offset++;
  }
  private space(multiline = false): void {
    while (this.offset < this.source.length && (multiline ? /\s/ : /[ \t]/).test(this.source[this.offset])) this.offset++;
  }
  private endLine(): void {
    this.space();
    if (this.source[this.offset] === '#') {
      while (this.offset < this.source.length && this.source[this.offset] !== '\n') this.offset++;
    }
    if (this.source[this.offset] === '\r') this.offset++;
    if (this.source[this.offset] === '\n') this.offset++;
    else if (this.offset < this.source.length) this.fail('Unexpected trailing input.');
  }
  private skipLines(): boolean {
    while (this.offset < this.source.length) {
      const end = this.source.indexOf('\n', this.offset);
      const text = this.source.slice(this.offset, end < 0 ? this.source.length : end).trim();
      if (text && !text.startsWith('#')) return true;
      this.offset = end < 0 ? this.source.length : end + 1;
    }
    return false;
  }
  private indent(): number {
    const indent = /^[ \t]*/.exec(this.source.slice(this.offset))![0];
    if (indent) {
      this.indentCharacter ??= indent[0];
      if ([...indent].some(char => char !== this.indentCharacter)) this.fail('Do not mix tabs and spaces for block indentation.');
    }
    return indent.length;
  }
  private childIndent(parent: number, child: number): void {
    this.indentWidth ??= child - parent;
    if (child !== parent + this.indentWidth) this.fail('Use one consistent indentation step for block bodies.');
  }
  private fail(message: string): never {
    throw new AbsSyncError('ABS_SYNTAX_INVALID', message, { start: this.offset, end: this.offset + 1 });
  }
}
