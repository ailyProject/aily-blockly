import * as Blockly from 'blockly';
import * as pinyinPro from 'pinyin-pro';
import '../components/blockly/blockly-native-registrations';
import { installNativeCandidateRealm } from './blockly-native-candidate-realm';
import { installBlocklyVariableComparator } from '../utils/blockly-variable-order';

// This bundle is evaluated only inside the opaque candidate iframe, never in the host.
// A local facade lets replay intercept registration without rewriting ES module exports.
Object.assign(window, { Blockly: Object.assign({}, Blockly), pinyinPro });
// Reuse the host's core ordering without changing the host's installation time
// or importing editor loading/render batching into this independent realm.
installBlocklyVariableComparator();
installNativeCandidateRealm();
