import * as Blockly from 'blockly/core';
import { FieldTftEsPiAnimation } from './field-tftespi-animation';
import { FieldTftEsPiRgb565Animation } from './field-tftespi-rgb565-animation';

describe('TFT animation field registry coexistence', () => {
  it('keeps the legacy registry ID on the raw RGB field', () => {
    const field = Blockly.fieldRegistry.fromJson({
      type: 'field_tftespi_animation',
      width: 2,
      height: 1,
      fps: 10,
      maxFrames: 1,
      format: 'rgb565',
    });

    expect(field instanceof FieldTftEsPiRgb565Animation).toBeTrue();
  });

  it('registers the explicit raw RGB alias on the same class', () => {
    const field = Blockly.fieldRegistry.fromJson({
      type: 'field_tftespi_rgb565_animation',
      width: 2,
      height: 1,
      fps: 10,
      maxFrames: 1,
      format: 'rgb332',
    });

    expect(field instanceof FieldTftEsPiRgb565Animation).toBeTrue();
  });

  it('registers AANI under its isolated registry ID', () => {
    const field = Blockly.fieldRegistry.fromJson({
      type: 'field_tftespi_aani_animation',
      width: 2,
      height: 1,
      fps: 10,
      maxFrames: 1,
    });

    expect(field instanceof FieldTftEsPiAnimation).toBeTrue();
  });
});
