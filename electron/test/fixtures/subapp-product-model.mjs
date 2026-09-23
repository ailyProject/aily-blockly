import assert from 'node:assert/strict';
import http from 'node:http';

// Deterministic local model transport, not a replacement for Agent tool execution.
// Responses use only the native tools actually exposed by the product.
export async function createProductModel() {
  const plans = new Map();
  const requests = [];
  const errors = [];
  const server = http.createServer(async (request, response) => {
    try {
      assert.equal(request.url, '/v1/chat/completions');
      let bytes = 0; const chunks = [];
      for await (const chunk of request) {
        bytes += chunk.length; assert.ok(bytes <= 8 * 1024 * 1024, 'Fixture request too large'); chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks));
      const marker = JSON.stringify(body.messages.filter(message => message.role === 'user')).match(/PRODUCT-FIXTURE:([A-Z])/);
      assert.ok(marker, 'Unknown fixture prompt');
      const plan = plans.get(marker[1]); assert.ok(plan);
      const exposed = body.tools?.map(tool => tool.function.name) || [];
      // Chat also asks this model to generate a title, with no tools. That is
      // a separate request kind, not the first step of the Agent's workflow.
      const auxiliary = exposed.length === 0;
      const step = auxiliary ? undefined : plan.steps[plan.next++];
      requests.push({ marker: marker[1], step: auxiliary ? 0 : plan.next, auxiliary, exposed, tool: step?.name || null,
        lastToolResult: String(body.messages.filter(message => message.role === 'tool').at(-1)?.content || '').slice(0, 12000) });
      assert.ok(plan.next <= plan.steps.length + 1, 'Unexpected extra model request');
      if (step) assert.ok(exposed.includes(step.name), `Product did not expose ${step.name}`);
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const emit = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({
        id: `fixture-${marker[1]}-${plan.next}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000),
        model: body.model, choices: [{ index: 0, delta, finish_reason }]
      })}\n\n`);
      emit(step ? { role: 'assistant', tool_calls: [{ index: 0, id: `fixture-call-${marker[1]}-${plan.next}`,
        type: 'function', function: { name: step.name, arguments: JSON.stringify(step.arguments) } }] }
        : { role: 'assistant', content: auxiliary ? `Product model session ${marker[1]}` : `PRODUCT-FIXTURE:${marker[1]} complete` });
      emit({}, step ? 'tool_calls' : 'stop');
      response.end('data: [DONE]\n\n');
    } catch (error) {
      errors.push(error.message);
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, requests, errors,
    planTools(marker, steps) {
      assert.match(marker, /^[A-Z]$/);
      plans.set(marker, { next: 0, steps });
    },
    plan(marker, { channelId, port }) {
      plans.set(marker, { next: 0, steps: [
        { name: 'tool_load', arguments: { names: ['serial_session_manage', 'serial_transact'] } },
        { name: 'tool_invoke', arguments: { name: 'serial_session_manage', arguments: { action: 'open', channelId, portPath: port, baudRate: 115200 } } },
        { name: 'tool_invoke', arguments: { name: 'serial_transact', arguments: { channelId,
          send: { mode: 'text', data: `chat-owned-${marker}` }, expect: { type: 'text', value: `chat-owned-${marker}` }, timeoutMs: 1000, quietMs: 10 } } }
      ] });
    },
    waitForClose(marker, channelId) {
      plans.set(marker, { next: 0, steps: [
        { name: 'tool_load', arguments: { names: ['serial_transact'] } },
        { name: 'tool_invoke', arguments: { name: 'serial_transact', arguments: { channelId,
          send: { mode: 'text', data: 'await-session-close' }, expect: { type: 'text', value: 'never-return-this-marker' },
          timeoutMs: 30000 } } }
      ] });
    },
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  };
}
