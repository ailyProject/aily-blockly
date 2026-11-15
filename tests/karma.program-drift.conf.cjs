const defaults = require('./karma.conf.cjs');
module.exports = config => { defaults(config); config.set({ client: { args: ['--grep=' + (process.env.AILY_PROGRAM_DRIFT_GREP || 'Native program drift')] } }); };
