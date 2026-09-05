import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';

const appData = process.env.APPDATA || path.resolve('.margin-data');
const dataRoot = process.env.MARGIN_DATA_ROOT || path.join(appData, 'Margin');
const modelRoot = path.join(dataRoot, 'models', 'Qwen', 'Qwen3-Embedding-4B-GGUF');
const runtimeRoot = path.join(dataRoot, 'runtime', 'llama');
const modelName = 'Qwen3-Embedding-4B-Q4_K_M.gguf';
const modelRevision = 'f4602530db1d980e16da9d7d3a70294cf5c190be';
const runtimeVersion = 'b10516';

const resources = [
  {
    name: 'Qwen3-Embedding-4B Q4_K_M',
    output: path.join(modelRoot, modelName),
    sha256: '2b0cf8f17b4c723c27303015383c27ec4bf2d8314bb677d05e920dd70bb0f16b',
    urls: [
      `https://huggingface.co/Qwen/Qwen3-Embedding-4B-GGUF/resolve/${modelRevision}/${modelName}`,
      `https://www.modelscope.cn/models/Qwen/Qwen3-Embedding-4B-GGUF/resolve/master/${modelName}`,
      `https://hf-mirror.com/Qwen/Qwen3-Embedding-4B-GGUF/resolve/${modelRevision}/${modelName}`,
    ],
  },
  {
    name: `llama.cpp ${runtimeVersion} Windows CPU runtime`,
    output: path.join(dataRoot, 'downloads', `llama-${runtimeVersion}-win-cpu-x64.zip`),
    sha256: 'fbbbc55e0eb2e1b07f9dcb9488616c98ed47d9003b90e15e7c8c7812c4307cd3',
    urls: [`https://github.com/ggml-org/llama.cpp/releases/download/${runtimeVersion}/llama-${runtimeVersion}-bin-win-cpu-x64.zip`],
  },
];

async function sha256(file) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), new Transform({ transform(chunk, _encoding, done) { hash.update(chunk); done(); } }));
  return hash.digest('hex');
}

async function download(url, output) {
  const existing = await stat(output).then((value) => value.size).catch(() => 0);
  const response = await fetch(url, { redirect: 'follow', headers: existing > 0 ? { Range: `bytes=${existing}-` } : {} });
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
  const resumed = existing > 0 && response.status === 206;
  const initial = resumed ? existing : 0;
  const expected = initial + Number(response.headers.get('content-length') || 0);
  let received = initial;
  let nextReport = 5;
  const progress = new Transform({
    transform(chunk, _encoding, done) {
      received += chunk.length;
      if (expected > 0) {
        const percent = Math.floor((received / expected) * 100);
        if (percent >= nextReport) {
          console.log(`  ${Math.min(percent, 100)}% (${(received / 1024 / 1024).toFixed(0)} MiB)`);
          nextReport = percent + 5;
        }
      }
      done(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body), progress, createWriteStream(output, { flags: resumed ? 'a' : 'w' }));
}

for (const resource of resources) {
  await mkdir(path.dirname(resource.output), { recursive: true });
  if (await access(resource.output).then(() => true).catch(() => false)) {
    const digest = await sha256(resource.output);
    if (digest === resource.sha256) {
      console.log(`Using existing ${resource.name} sha256:${digest}`);
      continue;
    }
    await rm(resource.output, { force: true });
  }
  let installed = false;
  for (const [sourceIndex, url] of resource.urls.entries()) {
    const temporary = `${resource.output}.${sourceIndex}.download`;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        console.log(`Downloading ${resource.name} from ${new URL(url).hostname} (attempt ${attempt}/3)`);
        await download(url, temporary);
        const digest = await sha256(temporary);
        if (digest !== resource.sha256) throw new Error(`checksum mismatch: ${digest}`);
        await rm(resource.output, { force: true });
        await rename(temporary, resource.output);
        console.log(`${resource.name} sha256:${digest}`);
        installed = true;
        break;
      } catch (error) {
        console.warn(`${new URL(url).hostname} failed: ${error.message}`);
      }
    }
    if (installed) break;
  }
  if (!installed) throw new Error(`Unable to install ${resource.name}`);
  for (let sourceIndex = 0; sourceIndex < resource.urls.length; sourceIndex += 1) {
    await rm(`${resource.output}.${sourceIndex}.download`, { force: true });
  }
}

const runtimeArchive = resources[1].output;
const temporaryRuntime = `${runtimeRoot}.extracting`;
await rm(temporaryRuntime, { recursive: true, force: true });
await mkdir(temporaryRuntime, { recursive: true });
const extractCommand = process.platform === 'win32'
  ? spawnSync('tar.exe', ['-xf', runtimeArchive, '-C', temporaryRuntime], { stdio: 'inherit' })
  : spawnSync('unzip', ['-q', runtimeArchive, '-d', temporaryRuntime], { stdio: 'inherit' });
if (extractCommand.status !== 0) throw new Error(`Unable to extract llama.cpp runtime (${extractCommand.status})`);
await rm(runtimeRoot, { recursive: true, force: true });
await mkdir(path.dirname(runtimeRoot), { recursive: true });
await rename(temporaryRuntime, runtimeRoot);
if (!await access(path.join(runtimeRoot, 'llama-server.exe')).then(() => true).catch(() => false)) {
  throw new Error('llama-server.exe was not present in the verified runtime archive');
}

await writeFile(path.join(modelRoot, 'MARGIN_MODEL_NOTICE.txt'), [
  'Model: Qwen/Qwen3-Embedding-4B-GGUF',
  `Revision: ${modelRevision}`,
  'Quantization: Q4_K_M',
  'License: Apache-2.0',
  'Runtime: ggml-org/llama.cpp',
  `Runtime version: ${runtimeVersion}`,
  '',
].join('\n'));
console.log(`Installed model in ${modelRoot}`);
console.log(`Installed runtime in ${runtimeRoot}`);
