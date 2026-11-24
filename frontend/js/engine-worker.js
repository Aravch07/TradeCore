import { createEngine } from './wasm-runtime.js';

const ready = (async () => {
  const response = await fetch(new URL('../wasm/engine.wasm', import.meta.url));
  if (!response.ok) throw new Error(`Cannot load the C engine (${response.status}).`);
  return createEngine(await response.arrayBuffer());
})();

// Promise chaining preserves command order while the WebAssembly file is loading.
let queue = Promise.resolve();
self.onmessage = ({ data: message }) => {
  queue = queue.then(async () => {
    try {
      const engine = await ready;
      const result = message.type === 'init' ? null : engine.request(message.method, message.path, message.body);
      for (const event of result?.events || []) self.postMessage(event);
      self.postMessage({ id: message.id, result: result?.data ?? { ok: true } });
    } catch (error) {
      self.postMessage({ id: message.id, error: error.message });
    }
  });
};
