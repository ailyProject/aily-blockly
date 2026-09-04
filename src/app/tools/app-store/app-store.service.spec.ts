import { isAppAvailableForApplication } from './app-store.service';

describe('isAppAvailableForApplication', () => {
  it('shows entries without only configuration in every application', () => {
    expect(isAppAvailableForApplication(undefined, 'aily blockly')).toBeTrue();
    expect(isAppAvailableForApplication('all', 'aily coder')).toBeTrue();
  });

  it('shows an application-specific entry only in the matching standalone product', () => {
    expect(isAppAvailableForApplication('aily coder', 'aily coder')).toBeTrue();
    expect(isAppAvailableForApplication('aily coder', 'aily blockly')).toBeFalse();
  });
});
