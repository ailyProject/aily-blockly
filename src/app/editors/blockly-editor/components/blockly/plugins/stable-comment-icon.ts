import * as Blockly from 'blockly';

/**
 * Keeps comment serialization stable when a pinned comment has no saved
 * bubble coordinates. Blockly still lays the bubble out for display, but that
 * derived position is persisted only after the user or another caller moves it.
 */
export class StableCommentIcon extends Blockly.icons.CommentIcon {
  private captureLocationChanges = true;
  private serializeBubbleLocation = false;

  override loadState(state: Blockly.icons.CommentState): void {
    this.serializeBubbleLocation = state.x != null && state.y != null;
    super.loadState(state);
  }

  override saveState(): Blockly.icons.CommentState | null {
    const state = super.saveState();
    if (!state || this.serializeBubbleLocation) return state;

    delete state.x;
    delete state.y;

    return state;
  }

  override setBubbleLocation(location: Blockly.utils.Coordinate): void {
    this.serializeBubbleLocation = true;
    super.setBubbleLocation(location);
  }

  override onBubbleLocationChange(): void {
    super.onBubbleLocationChange();
    if (this.captureLocationChanges) {
      this.serializeBubbleLocation = true;
    }
  }

  protected override createBubble(): void {
    this.captureLocationChanges = false;

    try {
      super.createBubble();
    } finally {
      this.captureLocationChanges = true;
    }
  }
}

Blockly.icons.registry.unregister(Blockly.icons.CommentIcon.TYPE.toString());
Blockly.icons.registry.register(Blockly.icons.CommentIcon.TYPE, StableCommentIcon);
