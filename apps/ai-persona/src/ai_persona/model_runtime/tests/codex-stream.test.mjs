/** Real subscription adapter against local SSE/WebSocket fixtures, never a real account. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {streamSimple} from '@earendil-works/pi-ai/api/openai-codex-responses';
import {openaiCodexProvider} from '@earendil-works/pi-ai/providers/openai-codex';
import {PiEngine} from '../engine.mjs';
const {WebSocketServer} = createRequire(import.meta.url)('ws');

for (const transport of ['sse', 'websocket']) {
  test(`subscription ${transport}: completion returns without waiting for connection close; actual output limit is observable`, async t => {
    const item = {id: 'fixture-message', type: 'message', role: 'assistant', status: 'completed', content: [{type: 'output_text', text: 'OK', annotations: []}]};
    const events = [
      {type: 'response.output_item.added', output_index: 0, item: {...item, content: []}},
      {type: 'response.content_part.added', output_index: 0, content_index: 0, part: {type: 'output_text', text: '', annotations: []}},
      {type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'OK'},
      {type: 'response.output_item.done', output_index: 0, item},
      {type: 'response.completed', response: {id: 'fixture-response', status: 'completed', output: [item], usage: {input_tokens: 10, output_tokens: 1, total_tokens: 11, input_tokens_details: {cached_tokens: 0}}}},
    ];
    const server = createServer((req, res) => {
      req.resume(); res.writeHead(200, {'Content-Type': 'text/event-stream'});
      for (const event of events) res.write('data: ' + JSON.stringify(event) + '\n\n');
      // Intentionally do not end the response: the terminal event must be enough.
    });
    const sockets = new WebSocketServer({server});
    sockets.on('connection', socket => socket.on('message', () => {
      for (const event of events) socket.send(JSON.stringify(event));
    }));
    t.after(() => {for (const socket of sockets.clients) socket.terminate(); sockets.close(); server.closeAllConnections(); server.close();});
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const model = {...openaiCodexProvider().getModels().find(m => m.reasoning), baseUrl: `http://127.0.0.1:${server.address().port}`};
    const apiKey = 'fixture.' + Buffer.from(JSON.stringify({'https://api.openai.com/auth': {chatgpt_account_id: 'fixture'}})).toString('base64url') + '.fixture';
    const engine = new PiEngine({});
    engine.collection = () => ({getModel: () => model, streamSimple: (m, context, options) => streamSimple(m, context, {...options, apiKey, transport})});
    const observed = [];
    const result = await engine.generate({providerId: model.provider, modelId: model.id, maxTokens: 128000, authType: 'oauth'}, {
      prompt: 'private fixture input', maxTokens: 6000, signal: AbortSignal.timeout(2000),
      onEvent: (type, detail) => observed.push({type, ...detail}),
    });
    assert.equal(result.text, 'OK'); assert.equal(result.stopReason, 'stop');
    assert.equal(observed.at(-1).type, 'done');
    assert.equal(observed.find(e => e.type === 'text_delta').chars, 2);
    // Pi's Codex adapter omits max_output_tokens, unlike its API-key adapters.
    assert.equal(observed.find(e => e.type === 'request_prepared').outputLimit, null);
    assert.doesNotMatch(JSON.stringify(observed), /private fixture|fixture\./);
  });
}
