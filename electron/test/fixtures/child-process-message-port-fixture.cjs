'use strict';

if (typeof process.send !== 'function') {
  process.exitCode = 2;
} else {
  process.send({ type: 'fixture.ready' });
  process.once('message', (message) => {
    process.send({
      type: 'fixture.pong',
      requestId: message?.requestId,
    }, () => {
      process.disconnect();
    });
  });
}
