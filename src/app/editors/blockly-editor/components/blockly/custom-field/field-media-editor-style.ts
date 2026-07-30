import * as Blockly from 'blockly/core';

export const MEDIA_FIELD_PARAMETER_DEBOUNCE_MS = 1000;

let mediaFieldEditorStylesRegistered = false;

/**
 * Shared popup styling for bitmap, image, and animation fields.
 * All colours come from the application theme so an open popup follows
 * dark/light changes immediately.
 */
export function registerMediaFieldEditorStyles() {
  if (mediaFieldEditorStylesRegistered) return;
  mediaFieldEditorStylesRegistered = true;

  Blockly.Css.register(`
.blocklyDropDownContent.ailyMediaFieldDropdown {
  background: var(--aily-bg-primary, #2a2a2a);
  border: 1px solid var(--aily-border-secondary, #444);
  border-radius: 6px;
  box-shadow: var(--aily-shadow-lg, 0 4px 12px rgba(0, 0, 0, 0.3));
  color: var(--aily-text-primary, #f4f4f4);
  max-height: none;
  overflow: visible;
}
.blocklyDropDownContent .ailyMediaFieldEditor {
  align-items: stretch;
  background: var(--aily-bg-primary, #2a2a2a);
  box-sizing: border-box;
  color: var(--aily-text-primary, #f4f4f4);
  display: flex;
  flex-direction: column;
  font-size: 12px;
  gap: 10px;
  max-width: min(94vw, 880px);
  padding: 8px 10px;
  width: max-content;
}
.ailyMediaFieldEditor .ailyMediaFieldToolbar {
  align-items: center;
  display: flex;
  flex-wrap: nowrap;
  gap: 8px;
  justify-content: space-between;
  max-width: 100%;
  width: max-content;
}
.ailyMediaFieldEditor .ailyMediaFieldSettings,
.ailyMediaFieldEditor .ailyMediaFieldActions {
  align-items: center;
  display: inline-flex;
  flex-wrap: nowrap;
  gap: 6px;
}
.ailyMediaFieldEditor .ailyMediaFieldActions {
  margin-left: auto;
}
.ailyMediaFieldEditor .ailyMediaFieldControl {
  align-items: center;
  color: var(--aily-text-primary, #f4f4f4);
  display: inline-flex;
  gap: 4px;
  white-space: nowrap;
}
.ailyMediaFieldEditor .ailyMediaFieldControl > span {
  color: var(--aily-text-tertiary, #cfcfcf);
  font-size: 12px;
  line-height: 1;
}
.ailyMediaFieldEditor .ailyMediaFieldInput {
  background: var(--aily-bg-input, #363636);
  border: 1px solid var(--aily-border-input, #666);
  border-radius: 4px;
  box-sizing: border-box;
  color: var(--aily-text-primary, #f4f4f4);
  font: inherit;
  height: 26px;
  margin: 0;
  outline: none;
  padding: 0 4px;
  text-align: center;
  width: 48px;
}
.ailyMediaFieldEditor select.ailyMediaFieldInput {
  text-align: left;
  width: 78px;
}
.ailyMediaFieldEditor .ailyMediaFieldInput:focus {
  border-color: var(--aily-color-accent, #4db6ac);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--aily-color-accent, #4db6ac) 35%, transparent);
}
.ailyMediaFieldEditor .ailyMediaFieldButton {
  background: var(--aily-bg-secondary, #333);
  border: 1px solid var(--aily-border-input, #666);
  border-radius: 4px;
  box-sizing: border-box;
  color: var(--aily-text-primary, #fff);
  cursor: pointer;
  font: inherit;
  height: 26px;
  margin: 0;
  padding: 0 10px;
}
.ailyMediaFieldEditor .ailyMediaFieldButton:hover:not(:disabled) {
  background: var(--aily-bg-hover, #444);
  border-color: var(--aily-color-accent, #888);
}
.ailyMediaFieldEditor .ailyMediaFieldButton:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}
.ailyMediaFieldEditor .ailyMediaFieldIconButton {
  align-items: center;
  display: inline-flex;
  justify-content: center;
  padding: 0;
  width: 26px;
}
.ailyMediaFieldEditor .ailyMediaFieldStatus,
.ailyMediaFieldEditor .ailyMediaFieldHint {
  color: var(--aily-text-tertiary, #cfcfcf);
  font-size: 12px;
  line-height: 1.4;
}
.ailyMediaFieldEditor .ailyMediaFieldStatus {
  max-width: 100%;
  min-height: 18px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ailyMediaFieldEditor .ailyMediaFieldStatus.is-error {
  color: var(--aily-color-error-bright, #ff8a80);
}
.ailyMediaFieldEditor .ailyMediaFieldHint {
  text-align: center;
  white-space: nowrap;
  width: 100%;
}
.ailyMediaFieldEditor .ailyMediaFieldSurface {
  background: var(--aily-bg-elevated, #1b1b1b);
  border: 1px solid var(--aily-border-input, #666);
  border-radius: 4px;
  box-sizing: border-box;
  scrollbar-color: var(--aily-scrollbar-thumb, #666) transparent;
  scrollbar-width: thin;
}
.ailyMediaFieldEditor input[type='radio'],
.ailyMediaFieldEditor input[type='range'] {
  accent-color: var(--aily-color-accent, #4db6ac);
}
.ailyMediaFieldEditor .tftEsPiImagePreview.ailyMediaFieldSurface,
.ailyMediaFieldEditor .tftEsPiAnimationPreview.ailyMediaFieldSurface {
  background-color: var(--aily-bg-elevated, #1b1b1b);
  background-image:
    linear-gradient(45deg, var(--aily-bg-tertiary, #333) 25%, transparent 25%),
    linear-gradient(-45deg, var(--aily-bg-tertiary, #333) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, var(--aily-bg-tertiary, #333) 75%),
    linear-gradient(-45deg, transparent 75%, var(--aily-bg-tertiary, #333) 75%);
  background-position: 0 0, 0 6px, 6px -6px, -6px 0;
  background-size: 12px 12px;
}
.ailyMediaFieldEditor .ailyMediaFieldSurface::-webkit-scrollbar {
  height: 4px;
  width: 4px;
}
.ailyMediaFieldEditor .ailyMediaFieldSurface::-webkit-scrollbar-track {
  background: transparent;
}
.ailyMediaFieldEditor .ailyMediaFieldSurface::-webkit-scrollbar-thumb {
  background: var(--aily-scrollbar-thumb, #666);
  border-radius: 2px;
}
.ailyMediaFieldEditor .ailyMediaFieldSurface::-webkit-scrollbar-thumb:hover {
  background: var(--aily-scrollbar-thumb-hover, #888);
}
`);
}
