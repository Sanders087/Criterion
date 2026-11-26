// Test-process-only network boundary: every outbound fetch must be mocked by the parent.
let nextId = 0;
const pending = new Map();
process.on('message', message => {
  if (message?.type !== 'fetch-result') return;
  const call = pending.get(message.id);
  if (!call) return;
  pending.delete(message.id); call.cleanup();
  if (message.timeout) call.reject(new DOMException('Test provider deadline', 'TimeoutError'));
  else if (message.error) call.reject(new Error(message.error));
  else call.resolve(new Response(message.body, { status: message.status, headers: message.headers }));
});
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init), id = ++nextId, body = await request.text();
  return new Promise((resolve, reject) => {
    const abort = () => finish(request.signal.reason);
    const timer = setTimeout(() => finish(new Error('Mock request timed out')), 10000);
    const cleanup = () => { clearTimeout(timer); request.signal.removeEventListener('abort', abort); };
    function finish(error) { pending.delete(id); cleanup(); reject(error); }
    if (request.signal.aborted) { abort(); return; }
    request.signal.addEventListener('abort', abort, { once: true });
    pending.set(id, { resolve, reject, cleanup });
    process.send({ type: 'fetch', id, url: request.url, method: request.method,
      headers: Object.fromEntries(request.headers), body });
  });
};
