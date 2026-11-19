const path = require('node:path');

// Keep Angular's application-builder defaults, with test artifacts under tests/.
module.exports = function (config) {
  config.set({
    basePath: path.resolve(__dirname, '..'),
    frameworks: ['jasmine'],
    plugins: [
      require('karma-jasmine'),
      require('karma-chrome-launcher'),
      require('karma-jasmine-html-reporter'),
      require('karma-coverage'),
    ],
    jasmineHtmlReporter: { suppressAll: true },
    coverageReporter: {
      dir: path.join(__dirname, 'coverage', 'aily-blockly'),
      subdir: '.',
      reporters: [{ type: 'html' }, { type: 'text-summary' }],
    },
    reporters: ['progress', 'kjhtml'],
    browsers: ['Chrome'],
    customLaunchers: {
      ChromeHeadlessNoSandbox: {
        base: 'ChromeHeadless',
        flags: ['--no-sandbox', '--headless', '--disable-gpu', '--disable-dev-shm-usage'],
      },
    },
    restartOnFileChange: true,
  });
};
