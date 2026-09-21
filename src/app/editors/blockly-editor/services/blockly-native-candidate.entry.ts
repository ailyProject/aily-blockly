import * as Blockly from 'blockly';
import * as pinyinPro from 'pinyin-pro';
import '../components/blockly/blockly-native-registrations';
import { installNativeCandidateRealm } from './blockly-native-candidate-realm';

// This bundle is evaluated only inside the opaque candidate iframe, never in the host.
// A local facade lets replay intercept registration without rewriting ES module exports.
Object.assign(window, { Blockly: Object.assign({}, Blockly), pinyinPro });
installNativeCandidateRealm();
