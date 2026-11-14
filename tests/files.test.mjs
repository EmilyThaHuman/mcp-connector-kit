import test from 'node:test';
import assert from 'node:assert/strict';
import { readConnectorFile, materializeConnectorFile } from '../dist/index.js';
const env = { ZEROTWO_API_URL: 'https://api.example.test' };

test('Library references resolve through authenticated backend; downloads contain no connector bearer', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/resolve-file')) return Response.json({ file_uri: 'https://storage.example.test/file', name: 'note.txt', mime_type: 'text/plain' });
    if (url.includes('/materialize-file')) return Response.json({ library_item_id: 'saved', extraction_status: 'ready' });
    return new Response('hello');
  };
  const file = await readConnectorFile('zerotwo-library://item-1', 'jwt', env);
  assert.equal(file.filename, 'note.txt');
  assert.equal(new TextDecoder().decode(file.bytes), 'hello');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer jwt');
  assert.equal(calls[1].init, undefined);
  const result = await materializeConnectorFile(file.bytes, { name: file.filename, mimeType: file.mimeType, messageId: 'm1', attachmentId: 'a1', startLine: 9 }, 'jwt', env);
  assert.equal(result.library_item_id, 'saved');
  assert.equal(new URL(calls[2].url).searchParams.get('start_line'), '9');
  await assert.rejects(readConnectorFile('/tmp/local.pdf', 'jwt', env), /upload local files/);
});

test('attachment download aborts at the byte limit even without Content-Length', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let cancelled = false;
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(25 * 1024 * 1024 + 1)); },
    cancel() { cancelled = true; },
  }));
  await assert.rejects(readConnectorFile('https://files.example.test/huge', 'jwt', env), /25 MB/);
  assert.equal(cancelled, true);
});
