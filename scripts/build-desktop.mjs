import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const command = process.platform === 'win32' ? 'vinext.cmd' : 'vinext';
const result = spawnSync(command, ['build'], { encoding: 'utf8', shell: process.platform === 'win32' });
process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');

const windowsUvShutdownBug = process.platform === 'win32'
  && result.status !== 0
  && result.stderr?.includes('UV_HANDLE_CLOSING')
  && result.stdout?.includes('Build complete')
  && existsSync('dist/client/index.html');

if (windowsUvShutdownBug) {
  console.warn('[margin] vinext completed successfully; ignored its known Windows libuv shutdown assertion.');
  process.exit(0);
}

process.exit(result.status ?? 1);
