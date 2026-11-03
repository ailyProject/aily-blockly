const defaults = require('./karma.conf.cjs');
module.exports = config => {
  defaults(config);
  config.set({ client: { args: ['--grep=Save As commits a new destination generation'] } });
};
