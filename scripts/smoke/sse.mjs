// A minimal SSE client for the smoke suite (bd-console-974.3).
//
// GET /api/events is a response that never ends, so `fetch` — which the rest of
// the suite uses — is the wrong tool: awaiting it awaits a body that will not
// arrive. This is plain node:http plus enough of the text/event-stream grammar
// to tell the three frame shapes apart:
//
//   event: hello\ndata: {...}\n\n   -> { event: 'hello', data: {...} }
//   event: change\ndata: {...}\n\n  -> { event: 'change', data: {...} }
//   : hb\n\n                        -> { comment: ' hb' }
//
// It lives in its own module because three domains need it (routing asserts the
// endpoint contract, issues the per-project change events, scheduler the
// schedule ones) and a third copy of a stream parser is how the three quietly
// stop agreeing on what a frame is.
import http from 'node:http';

// One SSE block ("field: value" lines up to the blank line) -> a frame object.
// Comment-only blocks (heartbeats) are reported as such rather than dropped:
// "the stream said nothing, on purpose, on schedule" is exactly what the
// heartbeat assertion needs to see.
function parseBlock(block) {
  const lines = block.split('\n').filter((l) => l !== '');
  if (lines.length && lines.every((l) => l.startsWith(':'))) {
    return { comment: lines.map((l) => l.slice(1)).join('') };
  }
  const frame = { event: null, data: null, raw: block };
  const dataLines = [];
  for (const line of lines) {
    if (line.startsWith('event:')) frame.event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length) {
    frame.raw_data = dataLines.join('\n');
    try { frame.data = JSON.parse(frame.raw_data); } catch { frame.data = null; }
  }
  return frame;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// openEventStream(url): resolves once the response HEADERS are in (so status and
// content-type are assertable), with the stream still open and accumulating.
// The caller MUST close() it — leaking one keeps the server's event sweeper
// running and, on the shared fixture server, keeps the suite's teardown waiting.
export function openEventStream(url, { timeoutMs = 5000 } = {}) {
  const stream = {
    status: null, headers: null, raw: '', frames: [], ended: false, error: null,
  };
  let buffer = '';
  let req = null;

  const ready = new Promise((resolveP, reject) => {
    const timer = setTimeout(() => reject(new Error(`SSE connect timed out after ${timeoutMs}ms: ${url}`)), timeoutMs);
    req = http.get(url, (res) => {
      clearTimeout(timer);
      stream.status = res.statusCode;
      stream.headers = res.headers;
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        stream.raw += chunk;
        buffer += chunk;
        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          stream.frames.push(parseBlock(buffer.slice(0, idx)));
          buffer = buffer.slice(idx + 2);
        }
      });
      res.on('end', () => { stream.ended = true; });
      res.on('error', (err) => { stream.error = err; });
      resolveP();
    });
    req.on('error', (err) => { clearTimeout(timer); stream.error = err; reject(err); });
  });

  // Frames matching `pred`, from `cursor` onwards. Polled rather than
  // event-driven: a 25ms poll is imperceptible next to the 2s debounce window
  // these tests exercise, and it keeps this file free of waiter bookkeeping.
  stream.waitFor = async (pred, { timeoutMs: wait = 4000, from = 0 } = {}) => {
    const deadline = Date.now() + wait;
    for (;;) {
      for (let i = from; i < stream.frames.length; i++) {
        if (pred(stream.frames[i])) return { frame: stream.frames[i], index: i };
      }
      if (Date.now() >= deadline) return null;
      await sleep(25);
    }
  };
  stream.changes = (kind = null) => stream.frames.filter(
    (f) => f.event === 'change' && (!kind || (f.data && f.data.kind === kind)),
  );
  stream.heartbeats = () => stream.frames.filter((f) => f.comment !== undefined);
  stream.close = () => { try { req.destroy(); } catch { /* already gone */ } };

  return ready.then(() => stream);
}

export { sleep };
