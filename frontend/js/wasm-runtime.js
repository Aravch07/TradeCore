// Minimal WASI host for the unchanged C engine and JSON API.
export async function createEngine(bytes) {
  let memory;
  const view = () => new DataView(memory.buffer);
  const wasi = {
    clock_time_get(clock, precision, output) {
      const ns = clock === 0 ? BigInt(Date.now()) * 1000000n : BigInt(Math.floor(performance.now() * 1e6));
      view().setBigUint64(output, ns, true);
      return 0;
    },
    fd_write(fd, iov, count, written) {
      let total = 0;
      for (let i = 0; i < count; i++) total += view().getUint32(iov + i * 8 + 4, true);
      view().setUint32(written, total, true);
      return 0;
    },
    fd_close: () => 8,
    fd_seek: () => 8,
    environ_sizes_get(count, size) {
      view().setUint32(count, 0, true);
      view().setUint32(size, 0, true);
      return 0;
    },
    environ_get: () => 0,
    proc_exit(code) { throw new Error(`The C engine stopped (code ${code}). Reload to start a new session.`); },
  };
  const { instance } = await WebAssembly.instantiate(bytes, { wasi_snapshot_preview1: wasi });
  const c = instance.exports;
  memory = c.memory;
  c._initialize();
  if (c.tc_init() !== 0) throw new Error('The C engine could not allocate a browser session.');
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const read = ptr => {
    const heap = new Uint8Array(memory.buffer);
    let end = ptr;
    while (heap[end]) end++;
    return decoder.decode(heap.subarray(ptr, end));
  };
  return {
    request(method, path, body = '') {
      const url = new URL(path, 'https://tradecore.local');
      const allocated = [];
      const put = text => {
        const data = encoder.encode(text);
        const ptr = c.malloc(data.length + 1);
        if (!ptr) throw new Error('Browser engine memory is full. Reload to start a new session.');
        allocated.push(ptr);
        const heap = new Uint8Array(memory.buffer);
        heap.set(data, ptr);
        heap[ptr + data.length] = 0;
        return ptr;
      };
      try {
        const args = [method, url.pathname, url.search.slice(1), body].map(put);
        const status = c.tc_request(...args);
        const data = JSON.parse(read(c.tc_json()));
        const events = read(c.tc_events()).split('\n\n').filter(Boolean).flatMap(block => {
          const lines = block.split('\n');
          const type = lines.find(line => line.startsWith('event: '))?.slice(7);
          const payload = lines.filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n');
          return type && payload ? [{ type, data: JSON.parse(payload) }] : [];
        });
        return { status, data, events };
      } finally {
        allocated.forEach(ptr => c.free(ptr));
      }
    },
  };
}
