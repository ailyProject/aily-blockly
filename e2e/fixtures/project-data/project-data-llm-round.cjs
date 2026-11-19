const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { roundSettled, progressKey, assertRoundTools, readFreshBuild } = require('./project-data-llm-evidence.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Submit natural language through the product UI; the E2E API is read-only observation. */
async function createLlmRoundDriver(page, project, root, setPhase) {
  const iframe = page.locator('app-main-window nz-sider app-child-tool-host iframe');
  const frame = await (await iframe.elementHandle()).contentFrame();
  const url = new URL(frame.url()); // Contains a bearer token; never put this URL in evidence.
  const request = async input => {
    const response = await fetch(new URL('/api/agent/e2e', url), { method: 'POST',
      headers: { authorization: `Bearer ${url.searchParams.get('token')}`, 'content-type': 'application/json' },
      body: JSON.stringify({ protocol: 'aily-agent-e2e', version: 4, ...input }), signal: AbortSignal.timeout(15000) });
    assert.equal(response.status, 200); const body = await response.json(); assert.equal(body.ok, true);
    return body.result;
  };
  const runRound = async (number, prompt, previous) => {
    fs.writeFileSync(path.join(root, `llm-task-${number}.txt`), prompt);
    setPhase(`llm-round-${number}-edit-and-build`);
    const started = Date.now();
    await frame.locator('.aily-chat-composer-input[contenteditable="true"]').fill(prompt);
    await frame.locator('button.send-action').click();
    let session, progress = '', logged = '', quietSince = started;
    while (Date.now() < started + 12 * 60 * 1000) {
      const { sessions } = await request({ method: 'session.list' });
      const target = previous ? sessions.find(item => item.sessionId === previous.sessionId)
        : sessions.find(item => path.resolve(item.cwd).toLowerCase() === path.resolve(project).toLowerCase());
      if (target) {
        ({ session } = await request({ method: 'session.read', sessionId: target.sessionId }));
        assert.equal(path.resolve(session.cwd).toLowerCase(), path.resolve(project).toLowerCase());
        // Isolated task-only transcript; never write token-bearing URLs or account config.
        fs.writeFileSync(path.join(root, `llm-session-${number}.json`), JSON.stringify(session, null, 2));
        // Native build output can advance while project_build is pending in the transcript.
        let buildProgress = '';
        try {
          const log = fs.statSync(path.join(project, '.build/.ninja_log'));
          if (log.mtimeMs >= started) buildProgress = `${log.size}:${log.mtimeMs}`;
        } catch { /* No compiler has started yet. */ }
        const next = progressKey(session) + buildProgress;
        if (next !== progress) {
          progress = next; quietSince = Date.now();
          const summary = JSON.stringify({ round: number, phase: session.phase, model: session.model,
            tools: session.toolExecutions.map(tool => ({ name: tool.toolName, status: tool.status })) });
          if (summary !== logged) { console.log('LLM_PROGRESS=' + summary); logged = summary; }
        }
        if (roundSettled(session, previous)) break;
      }
      if (Date.now() - quietSince > 180000) throw new Error('LLM session made no observable progress for 180 seconds');
      await sleep(5000);
    }
    assert.ok(session && roundSettled(session, previous), 'LLM round did not settle within the bounded deadline');
    await page.screenshot({ path: path.join(root, `llm-completed-${number}-page.png`), fullPage: true });
    const tools = assertRoundTools(session, previous), build = readFreshBuild(project, started);
    return { session, evidence: { number, tools, started, durationMs: Date.now() - started, ...build } };
  };

  return { runRound, request };
}

module.exports = { createLlmRoundDriver };
