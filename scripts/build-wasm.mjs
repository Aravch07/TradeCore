import { spawnSync } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('../', import.meta.url)));
const sdk = process.argv[2] || process.env.WASI_SDK_PATH ||
  join(homedir(), '.cache', 'tradecore-tools', 'wasi-sdk-34.0-x86_64-windows');
const clang = join(resolve(sdk), 'bin', process.platform === 'win32' ? 'clang.exe' : 'clang');
if (!existsSync(clang)) throw new Error('Set WASI_SDK_PATH or pass the path to WASI SDK 34.');
mkdirSync('frontend/wasm', { recursive: true });
const core = ['trace', 'order_list', 'avl', 'hashmap', 'vec', 'engine', 'reference', 'scenario', 'json', 'api'];
const args = ['--target=wasm32-wasip1', '-mexec-model=reactor', '-std=c11', '-O2',
  '-Wall', '-Wextra', '-Werror', '-D_POSIX_C_SOURCE=200809L', '-I', 'src',
  '-Wl,--export=tc_init', '-Wl,--export=tc_request', '-Wl,--export=tc_json',
  '-Wl,--export=tc_events', '-Wl,--export=malloc', '-Wl,--export=free',
  '-Wl,--export-memory', '-Wl,-z,stack-size=1048576',
  '-Wl,--initial-memory=33554432', '-Wl,--max-memory=268435456',
  ...core.map(name => `src/${name}.c`), 'wasm/bridge.c', '-lm', '-o', 'frontend/wasm/engine.wasm'];
const result = spawnSync(clang, args, { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
