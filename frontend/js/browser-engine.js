// One worker and one isolated C engine per browser tab; refresh resets the session.
let worker;
let ready;
let nextId = 0;
const pending = new Map();
const subscribers = new Set();

function send(message) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, ...message });
  });
}

function start() {
  if (ready) return ready;
  worker = new Worker(new URL('./engine-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    if (data.id == null) {
      subscribers.forEach(fn => fn(data.type, data.data));
      return;
    }
    const request = pending.get(data.id);
    if (!request) return;
    pending.delete(data.id);
    if (data.error) request.reject(new Error(data.error));
    else request.resolve(data.result);
  };
  worker.onerror = () => {
    const error = new Error('The browser C engine stopped. Reload to restart the session.');
    pending.forEach(request => request.reject(error));
    pending.clear();
    subscribers.forEach(fn => fn('error', error));
  };
  ready = send({ type: 'init' });
  return ready;
}

export async function request(method, path, body) {
  await start();
  return send({ method, path, body: body == null ? '' : JSON.stringify(body) });
}

export function connect(callback) {
  subscribers.add(callback);
  start().then(() => {
    if (subscribers.has(callback)) callback('hello', {});
  }).catch(error => { if (subscribers.has(callback)) callback('error', error); });
  return () => subscribers.delete(callback);
}
