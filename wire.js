// Multiplexing wire format shared by hub.js and agent.js.
//
// A single agent<->hub WebSocket carries many terminal sessions at once, so
// every frame must say which session it belongs to:
//   - control frames  : JSON *text* frames, e.g. {t:"create", sid, ...}
//   - terminal bytes  : *binary* frames prefixed with a fixed 8-byte session id
//
// Session ids are randomUUID().slice(0,8) — always 8 ASCII hex chars — so the
// prefix is a clean fixed width with zero parsing overhead.
export const SID_LEN = 8;

export function encodeData(sid, buf) {
  const head = Buffer.alloc(SID_LEN, 0x20); // space-pad just in case
  head.write(String(sid).slice(0, SID_LEN), 'ascii');
  return Buffer.concat([head, Buffer.isBuffer(buf) ? buf : Buffer.from(buf)]);
}

export function decodeData(frame) {
  const sid = frame.subarray(0, SID_LEN).toString('ascii').trim();
  return { sid, data: frame.subarray(SID_LEN) };
}
