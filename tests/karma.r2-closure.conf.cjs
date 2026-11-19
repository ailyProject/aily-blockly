const defaults = require('./karma.conf.cjs');
module.exports = config => { defaults(config); config.set({ client: { args: ['--grep=R2 |trusted ABS load normalization|same-project durable operation|automatic location metadata|Project Data normalization'] } }); };
