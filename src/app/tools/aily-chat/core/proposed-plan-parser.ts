export type ProposedPlanSegment =
  | { readonly type: 'normal'; readonly text: string }
  | { readonly type: 'planStart' }
  | { readonly type: 'planDelta'; readonly text: string }
  | { readonly type: 'planEnd' };

const OPEN_TAG = '<proposed_plan>';
const CLOSE_TAG = '</proposed_plan>';

/**
 * Streaming parser for Codex-style `<proposed_plan>` blocks.
 *
 * Tags are recognized only when they appear alone on a line, with optional
 * leading/trailing whitespace. Text inside the block is removed from visible
 * assistant markdown and emitted as plan deltas.
 */
export class ProposedPlanParser {
  private active = false;
  private detectTag = true;
  private lineBuffer = '';

  push(text: string): ProposedPlanSegment[] {
    const segments: ProposedPlanSegment[] = [];
    let run = '';

    for (const ch of text) {
      if (this.detectTag) {
        if (run) {
          this.pushText(run, segments);
          run = '';
        }
        this.lineBuffer += ch;
        if (ch === '\n') {
          this.finishLine(segments);
          continue;
        }

        const slug = this.lineBuffer.trimStart();
        if (!slug || isTagPrefix(slug)) {
          continue;
        }

        const buffered = this.lineBuffer;
        this.lineBuffer = '';
        this.detectTag = false;
        this.pushText(buffered, segments);
        continue;
      }

      run += ch;
      if (ch === '\n') {
        this.pushText(run, segments);
        run = '';
        this.detectTag = true;
      }
    }

    if (run) {
      this.pushText(run, segments);
    }
    return segments;
  }

  finish(): ProposedPlanSegment[] {
    const segments: ProposedPlanSegment[] = [];
    if (this.lineBuffer) {
      const buffered = this.lineBuffer;
      this.lineBuffer = '';
      const withoutNewline = buffered.endsWith('\n') ? buffered.slice(0, -1) : buffered;
      const slug = withoutNewline.trimStart().trimEnd();
      if (slug === OPEN_TAG && !this.active) {
        pushSegment(segments, { type: 'planStart' });
        this.active = true;
      } else if (slug === CLOSE_TAG && this.active) {
        pushSegment(segments, { type: 'planEnd' });
        this.active = false;
      } else {
        this.pushText(buffered, segments);
      }
    }

    if (this.active) {
      pushSegment(segments, { type: 'planEnd' });
      this.active = false;
    }
    this.detectTag = true;
    return segments;
  }

  private finishLine(segments: ProposedPlanSegment[]): void {
    const line = this.lineBuffer;
    this.lineBuffer = '';
    const withoutNewline = line.endsWith('\n') ? line.slice(0, -1) : line;
    const slug = withoutNewline.trimStart().trimEnd();

    if (slug === OPEN_TAG && !this.active) {
      pushSegment(segments, { type: 'planStart' });
      this.active = true;
      this.detectTag = true;
      return;
    }

    if (slug === CLOSE_TAG && this.active) {
      pushSegment(segments, { type: 'planEnd' });
      this.active = false;
      this.detectTag = true;
      return;
    }

    this.detectTag = true;
    this.pushText(line, segments);
  }

  private pushText(text: string, segments: ProposedPlanSegment[]): void {
    if (!text) {
      return;
    }
    pushSegment(segments, this.active
      ? { type: 'planDelta', text }
      : { type: 'normal', text });
  }
}

function isTagPrefix(slug: string): boolean {
  const normalized = slug.trimEnd();
  return OPEN_TAG.startsWith(normalized) || CLOSE_TAG.startsWith(normalized);
}

function pushSegment(segments: ProposedPlanSegment[], segment: ProposedPlanSegment): void {
  if (segment.type === 'normal' || segment.type === 'planDelta') {
    if (!segment.text) {
      return;
    }
    const previous = segments[segments.length - 1];
    if (previous?.type === segment.type) {
      segments[segments.length - 1] = { ...previous, text: previous.text + segment.text };
      return;
    }
  }
  segments.push(segment);
}
