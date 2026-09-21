import { matchAbsIdentities } from './abs-identity-matcher';
import { indexAbsSyntax } from './abs-identity-map';
import { parseAbsSyntax } from './abs-syntax';
import { original, syntax } from './abs-thermometer-session.fixture';


describe('reported thermometer session identity regression', () => {
  it('accepts the first comfort-display candidate without coordinate retries (52 retained calls)', async () => {
    const loop = original.indexOf('arduino_loop()');
    const prefix = original.slice(0, loop).replace('arduino_setup()',
      '    variable_define("lastUpdate", uint32_t, math_number(0))\narduino_setup()');
    const body = original.slice(loop + 'arduino_loop()\n'.length)
      .replace(/    time_delay\(math_number\(2000\)\)\s*$/, '').trimEnd();
    const beforeText = prefix + 'arduino_loop()\n'
      + '    controls_if(logic_compare(math_arithmetic(time_millis(), MINUS, variables_get($lastUpdate)), GTE, math_number(2000)))\n'
      + '        variables_set($lastUpdate, time_millis())\n'
      + body.split('\n').map(line => '    ' + line).join('\n');
    const condition = 'logic_operation(logic_operation(logic_compare(variables_get($temperature), GTE, math_number(18)), AND, logic_compare(variables_get($temperature), LTE, math_number(28))), AND, logic_operation(logic_compare(variables_get($humidity), GTE, math_number(30)), AND, logic_compare(variables_get($humidity), LTE, math_number(70))))';
    const serial = '\n        serial_println(Serial, logic_ternary(' + condition + ', text("环境舒适"), text("环境不舒适")))';
    const display = '\n        u8g2_draw_str(math_number(0), math_number(56), logic_ternary(' + condition + ', text("舒适"), text("不舒适")))';
    const serialAt = beforeText.indexOf('\n        u8g2_clear_buffer()');
    const displayAt = beforeText.indexOf('        u8g2_draw_str('), displayBefore = beforeText.slice(displayAt);
    const displayAfter = displayBefore.replace('math_number(22)', 'math_number(18)').replace('math_number(54)', 'math_number(37)')
      .replace('\n        u8g2_send_buffer()', display + '\n        u8g2_send_buffer()');
    const afterText = beforeText.slice(0, serialAt) + serial + beforeText.slice(serialAt, displayAt) + displayAfter;
    // Recorded transport evidence from the ordinary multi-line edit. The final
    // splice is deliberately coarse inside the second call; its name still survives.
    const humidityAt = beforeText.indexOf('math_number(54)') + 'math_number('.length;
    const temperatureAt = beforeText.indexOf('math_number(22)') + 'math_number('.length;
    const sourceEdits = [[{ start: serialAt, end: serialAt, text: serial },
      { start: temperatureAt, end: temperatureAt + 2, text: '18' },
      { start: humidityAt, end: beforeText.length - 28, text: displayAfter.slice(humidityAt - displayAt, -28) }]];
    expect([...sourceEdits[0]].reverse().reduce((text, e) => text.slice(0, e.start) + e.text + text.slice(e.end), beforeText)).toBe(afterText);
    const before = parseAbsSyntax(beforeText, syntax), after = parseAbsSyntax(afterText, syntax);
    // Missing/coarse provenance may rebuild ordinary calls; it is not a syntax failure.
    await expectAsync(matchAbsIdentities(beforeText, afterText, before, after,
      [[{ start: serialAt, end: serialAt, text: serial }, { start: temperatureAt, end: beforeText.length - 28,
        text: displayAfter.slice(temperatureAt - displayAt, -28) }]]))
      .toBeResolved();
    const matches = await matchAbsIdentities(beforeText, afterText, before, after, sourceEdits);
    expect(indexAbsSyntax(before).length).toBe(52); expect(indexAbsSyntax(after).length).toBe(92);
    expect(new Set(matches.values()).size).toBe(52);
    const displays = indexAbsSyntax(after).map(entry => entry.node).filter(node => node.type === 'u8g2_draw_str');
    expect(displays.map(node => node.inputs['Y']!.fields['NUM'].value)).toEqual([18, 37, 56]);
    expect(displays.map(node => matches.has(node))).toEqual([true, true, false]);
  });

  for (const initializer of ['math_number(0)', '0']) it('accepts the whole nonblocking rewrite with initializer ' + initializer, async () => {
    const loop = original.indexOf('arduino_loop()');
    const prefix = original.slice(0, loop).replace('arduino_setup()',
      '    variable_define("lastUpdate", uint32_t, ' + initializer + ')\narduino_setup()');
    const body = original.slice(loop + 'arduino_loop()\n'.length)
      .replace(/    time_delay\(math_number\(2000\)\)\s*$/, '').trimEnd();
    const edited = prefix + 'arduino_loop()\n'
      + '    controls_if(logic_compare(math_arithmetic(time_millis(), MINUS, variables_get($lastUpdate)), GTE, math_number(2000)))\n'
      + '        variables_set($lastUpdate, time_millis())\n'
      + body.split('\n').map(line => '    ' + line).join('\n') + '\n';
    const before = parseAbsSyntax(original, syntax), after = parseAbsSyntax(edited, syntax);
    const matches = await matchAbsIdentities(original, edited, before, after);
    const retained = new Set(matches.values());
    // Every original call except the removed delay survives, including repeated
    // zero/text/getter blocks nested below the two moved display statements.
    expect(indexAbsSyntax(before).filter(({ node }) => !retained.has(node)).map(({ node }) => node.type)).toEqual(['time_delay']);
    const declaration = indexAbsSyntax(after).find(({ node }) => node.type === 'variable_define' && node.fields['VAR'].value === 'lastUpdate')!.node;
    expect(matches.has(declaration)).toBeFalse();
    expect(matches.has(declaration.inputs['VALUE']!)).toBeFalse();
  });
});
