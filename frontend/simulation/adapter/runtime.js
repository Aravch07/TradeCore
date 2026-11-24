// Runs the upstream C auth, simulation, matching, API and trace code in a browser.
export async function createSimulation(bytes, { now = Date.now } = {}) {
  let memory;
  const view = () => new DataView(memory.buffer);
  const wasi = {
    clock_time_get(clock, precision, output) { view().setBigUint64(output, clock === 0 ? BigInt(now()) * 1000000n : BigInt(Math.floor(performance.now() * 1e6)), true); return 0; },
    fd_write(fd, iov, count, written) { let total = 0; for (let i = 0; i < count; i++) total += view().getUint32(iov + i * 8 + 4, true); view().setUint32(written, total, true); return 0; },
    fd_close: () => 8, fd_seek: () => 8,
    proc_exit(code) { throw new Error(`Simulation stopped (${code}). Reload to start a new session.`); },
  };
  const { instance } = await WebAssembly.instantiate(bytes, { wasi_snapshot_preview1: wasi,
    env: { secure_random(pointer, length) { crypto.getRandomValues(new Uint8Array(memory.buffer, pointer, length)); } } });
  const c = instance.exports; memory = c.memory; c._initialize();
  if (c.tc_init()) throw new Error('Could not initialize the simulation.');
  const encoder = new TextEncoder(), decoder = new TextDecoder();
  function read(ptr) { const heap = new Uint8Array(memory.buffer); let end = ptr; while (heap[end]) end++; return decoder.decode(heap.subarray(ptr, end)); }
  function events(text) { return text.split('\n\n').filter(Boolean).flatMap(block => {
    const lines = block.split('\n'), type = lines.find(line => line.startsWith('event: '))?.slice(7);
    const data = lines.filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n');
    return type && data ? [{ type, data: JSON.parse(data) }] : [];
  }); }
  return {
    request(method, path, body = '', token = '') {
      const url = new URL(path, 'https://simulation.local'), allocated = [];
      try {
        const args = [method, url.pathname, url.search.slice(1), body, token].map(text => {
          const data = encoder.encode(text), ptr = c.malloc(data.length + 1);
          if (!ptr) throw new Error('Simulation memory is full. Reload to restart.');
          allocated.push(ptr); const heap = new Uint8Array(memory.buffer); heap.set(data, ptr); heap[ptr + data.length] = 0; return ptr;
        });
        const status = c.tc_request(...args);
        return { status, data: JSON.parse(read(c.tc_json())), events: events(read(c.tc_events())) };
      } finally { allocated.forEach(ptr => c.free(ptr)); }
    },
    tick() { return events(read(c.tc_tick(BigInt(now())))); },
  };
}
