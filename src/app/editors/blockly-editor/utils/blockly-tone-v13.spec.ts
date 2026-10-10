import {FieldTonePicker} from '../components/blockly/custom-field/field-tone';

describe('tone picker v13 initialization', () => {
  it('initializes its validator before accepting a saved tone', () => {
    const field = new FieldTonePicker('440');
    expect(field.getValue()).toBe('440');
    field.setValue('523');
    expect(field.getValue()).toBe('523');
    field.setValue('not-a-tone');
    expect(field.getValue()).toBe('523');
    field.dispose();
  });
  it('stores the displayed default when the initial tone is invalid', () => {
    const field = new FieldTonePicker('invalid');
    expect(field.getValue()).toBe('131');
    field.dispose();
  });
});
