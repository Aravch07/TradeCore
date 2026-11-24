import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
process.chdir(fileURLToPath(new URL('../', import.meta.url)));
const sdk = process.argv[2] || process.env.WASI_SDK_PATH || join(homedir(), '.cache', 'tradecore-tools', 'wasi-sdk-34.0-x86_64-windows');
const clang = join(sdk, 'bin', process.platform === 'win32' ? 'clang.exe' : 'clang');
const dir = '.vercel/simulation-build/src';
mkdirSync(dir, { recursive: true }); mkdirSync('frontend/simulation/adapter', { recursive: true });
for (const name of readdirSync('upstream-simulation/src')) {
  let source = readFileSync(join('upstream-simulation/src', name), 'utf8');
  if (name === 'api.c') {
    source = source.replace('static long query_long(const char *q, const char *key, long def, long lo, long hi)',
      'static int64_t query_long(const char *q, const char *key, int64_t def, int64_t lo, int64_t hi)')
      .replace('long x = strtol(v, &end, 10);', 'int64_t x = strtoll(v, &end, 10);')
      .replaceAll('0x7fffffffffffffffL', 'INT64_MAX')
      .replaceAll('long since = query_long', 'int64_t since = query_long')
      .replaceAll('long since_ms = query_long', 'int64_t since_ms = query_long')
      .replaceAll('long lookup = query_long', 'int64_t lookup = query_long')
      .replaceAll('(long)t->trade_id', '(int64_t)t->trade_id').replaceAll('(long)t->time_ms', '(int64_t)t->time_ms')
      .replace('order_id\\\":%ld,', 'order_id\\\":%lld,').replace('lookup, bk,', '(long long)lookup, bk,');
  }
  if (name === 'auth.c') {
    const start = source.indexOf('void auth_random_bytes('), end = source.indexOf('static void lower_key', start);
    source = source.slice(0, start) + '__attribute__((import_module("env"), import_name("secure_random")))\nextern void browser_random(unsigned char *out, size_t n);\nvoid auth_random_bytes(uint8_t *out, size_t n) { browser_random(out, n); }\n\n' + source.slice(end);
  }
  writeFileSync(join(dir, name), source);
}
const core = ['trace', 'order_list', 'avl', 'hashmap', 'vec', 'engine', 'reference', 'scenario', 'sha256', 'auth', 'sim', 'json', 'api'];
const args = ['--target=wasm32-wasip1', '-mexec-model=reactor', '-std=c11', '-O2', '-Wall', '-Wextra',
  '-D_POSIX_C_SOURCE=200809L', '-I', dir, '-Wl,--allow-undefined', '-Wl,--export=tc_init', '-Wl,--export=tc_request',
  '-Wl,--export=tc_json', '-Wl,--export=tc_events', '-Wl,--export=tc_tick', '-Wl,--export=malloc', '-Wl,--export=free',
  '-Wl,--export-memory', '-Wl,-z,stack-size=1048576', '-Wl,--initial-memory=67108864', '-Wl,--max-memory=536870912',
  ...core.map(name => `${dir}/${name}.c`), 'wasm/simulation-bridge.c', '-lm', '-o', 'frontend/simulation/adapter/engine.wasm'];
const result = spawnSync(resolve(clang), args, { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
