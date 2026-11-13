const defaults = require('./karma.conf.cjs');
module.exports = config => { defaults(config); config.set({ client: { args: ['--grep=R2 imports a full ABI'] } }); };
