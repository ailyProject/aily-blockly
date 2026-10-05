/** Test page only: fire the existing watchdog after the real replay observation.
 * No library edits, busy loop, shorter product budget or disk writes. */
function installAbsTimeoutFault(mode) {
  if (!['once', 'always'].includes(mode)) throw Error('Invalid timeout fault mode');
  const schedule = window.setTimeout, Channel = window.MessageChannel;
  let watchdog;
  const evidence = { mode, fired: 0, realms: 0, budgets: [], cleanBeforeRealm: [] };
  window.setTimeout = function (callback, delay, ...args) {
    if (typeof callback === 'function' && (delay >= 9990 && delay <= 10000 || delay >= 29990 && delay <= 30000)) {
      watchdog = { callback, delay };
    }
    return schedule.call(this, callback, delay, ...args);
  };
  window.MessageChannel = function () {
    const channel = new Channel(), timer = watchdog;
    evidence.realms++;
    evidence.cleanBeforeRealm.push(!document.querySelector('[data-blockly-native-candidate]'));
    let fired = false;
    channel.port1.addEventListener('message', event => {
      if (fired || mode === 'once' && evidence.fired || event.data.replay?.event !== 'drain-start') return;
      if (!timer) throw Error('No native watchdog captured');
      fired = true; evidence.fired++; evidence.budgets.push(timer.delay);
      schedule(() => timer.callback(), 0);
    });
    return channel;
  };
  window.absTimeoutFault = { evidence, restore() {
    window.setTimeout = schedule; window.MessageChannel = Channel;
    return { ...evidence, cleanedUp: !document.querySelector('[data-blockly-native-candidate]') };
  } };
}
module.exports = { installAbsTimeoutFault };
