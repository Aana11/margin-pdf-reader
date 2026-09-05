import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';

const model = 'Qwen/Qwen3-Embedding-4B';
const revision = '1e989783831283ef06a82c1fe647cf42ce3284b7';
const files = [
  { remote: 'config.json' },
  { remote: 'config_sentence_transformers.json' },
  { remote: 'tokenizer.json' },
  { remote: 'tokenizer_config.json' },
  { remote: 'merges.txt' },
  { remote: 'vocab.json' },
  {
    remote: 'onnx/model_quint8_avx2.onnx',
    local: 'onnx/model_q8.onnx',
    sha256: '465644d0069f99ab692b1ce1c40fb0065379a942cde49c8d642dd82361e873aa',
  },
];
const destination = path.resolve('public', 'models', model);

function sources(file) {
  const encoded = file.split('/').map(encodeURIComponent).join('/');
  return [
    `https://huggingface.co/${model}/resolve/${revision}/${encoded}`,
    `https://www.modelscope.cn/models/${model}/resolve/master/${encoded}`,
  ];
}

async function sha256(file) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), new Transform({ transform(chunk, _encoding, done) { hash.update(chunk); done(); } }));
  return hash.digest('hex');
}

async function download(url, output) {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), await import('node:fs').then(({ createWriteStream }) => createWriteStream(output)));
}

for (const file of files) {
  const output = path.join(destination, file.local ?? file.remote);
  const temporary = `${output}.download`;
  await mkdir(path.dirname(output), { recursive: true });
  let downloaded = false;
  for (const url of sources(file.remote)) {
    try {
      console.log(`Downloading ${file.remote} from ${new URL(url).hostname}`);
      await download(url, temporary);
      downloaded = true;
      break;
    } catch (error) {
      await rm(temporary, { force: true });
      console.warn(`${new URL(url).hostname} failed: ${error.message}`);
    }
  }
  if (!downloaded) throw new Error(`Unable to download ${file.remote} from Hugging Face or ModelScope`);
  const digest = await sha256(temporary);
  if (file.sha256 && digest !== file.sha256) {
    await rm(temporary, { force: true });
    throw new Error(`Checksum mismatch for ${file.remote}: ${digest}`);
  }
  await rm(output, { force: true });
  await rename(temporary, output);
  console.log(`${file.local ?? file.remote} sha256:${digest}`);
}

await writeFile(
  path.join(destination, 'MARGIN_MODEL_NOTICE.txt'),
  `Model: ${model}\nRevision: ${revision}\nFormat: ONNX Q8 AVX2\nLicense: Apache-2.0\nPrimary: https://huggingface.co/${model}\nFallback: https://www.modelscope.cn/models/${model}\n`,
);
