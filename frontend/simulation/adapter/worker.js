import { createSimulation } from './runtime.js';
const ready = (async () => {
  const response = await fetch(new URL('./engine.wasm', import.meta.url));
  if (!response.ok) throw new Error('The simulation engine could not be loaded.');
  const simulation = await createSimulation(await response.arrayBuffer());
  setInterval(() => { try { for (const event of simulation.tick()) self.postMessage(event); } catch (error) { self.postMessage({ type: 'error', data: error.message }); } }, 200);
  return simulation;
})();
let queue = Promise.resolve();
self.onmessage = ({ data: message }) => {
  queue = queue.then(async () => {
    try {
      const simulation = await ready;
      const result = message.type === 'init' ? { status: 200, data: { ok: true } } : simulation.request(message.method, message.path, message.body, message.token);
      for (const event of result.events || []) self.postMessage(event);
      self.postMessage({ id: message.id, result: { status: result.status, data: result.data } });
    } catch (error) { self.postMessage({ id: message.id, error: error.message }); }
  });
};
