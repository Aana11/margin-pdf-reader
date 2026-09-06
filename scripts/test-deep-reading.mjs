import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { recognizeWithGlmOcr, selectDeepReadCandidates } from '../lib/rag/deep-reading.ts';

const matches = [
  { id: 'p8-c0', page: 8, score: 0.93, text: '由公式 ∫ f(x) dx = F(x) + C，可以得到最终结果。' },
  { id: 'p3-c0', page: 3, score: 0.72, text: '普通介绍文本。' },
];
const candidates = selectDeepReadCandidates(1, '当前页是目录。', matches, '请解释命中的公式推导');
assert.equal(candidates[0]?.page, 8);
assert.equal(candidates[0]?.task, 'formula');
assert.ok(candidates.length <= 2);

let received;
const server = createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    received = {
      path: request.url,
      authorization: request.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
    };
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: '\\int f(x)\\,dx = F(x) + C' } }] }));
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
try {
  const address = server.address();
  assert.equal(typeof address, 'object');
  const result = await recognizeWithGlmOcr(
    { endpoint: `http://127.0.0.1:${address.port}/v1`, model: 'glm-ocr', apiKey: 'local-test-key' },
    Uint8Array.from([255, 216, 255, 217]),
    'image/jpeg',
    'formula',
  );
  assert.match(result.text, /int f/);
  assert.equal(received.path, '/v1/chat/completions');
  assert.equal(received.authorization, 'Bearer local-test-key');
  assert.equal(received.body.model, 'glm-ocr');
  assert.equal(received.body.messages[0].content[1].text, 'Formula Recognition:');
  assert.match(received.body.messages[0].content[0].image_url.url, /^data:image\/jpeg;base64,/);
  console.log(JSON.stringify({ selectedPage: candidates[0].page, selectedTask: candidates[0].task, endpoint: received.path, prompt: received.body.messages[0].content[1].text }));
} finally {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
