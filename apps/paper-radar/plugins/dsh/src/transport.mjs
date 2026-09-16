import { request } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PROTOCOL, BridgeError } from '@paper-radar/host-contract/transport';
import { MAX_TOOL_RESPONSE_BYTES } from '@paper-radar/host-contract/tool-content';
export { PROTOCOL, BridgeError };
// Preserve the installed socket location; source and UI use DSH.
export const defaultSocket = () => join(homedir(), '.local/share/paper-radar/harness.sock');
export function bridgeRequest(socketPath, path, input, { signal, timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(input ?? {});
    const req = request({ socketPath, path, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), 'x-paper-radar-protocol': PROTOCOL }, signal: AbortSignal.any([...(timeout === null ? [] : [AbortSignal.timeout(timeout)]), ...(signal ? [signal] : [])]) }, (res) => {
      const chunks = []; let size = 0;
      res.on('data', (chunk) => { size += chunk.length; if (size > MAX_TOOL_RESPONSE_BYTES) req.destroy(new BridgeError('response_too_large', 'DSH 返回内容过大。')); else chunks.push(chunk); });
      res.on('error', reject);
      res.on('end', () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString());
          if (res.statusCode >= 400) reject(new BridgeError(value.code ?? 'dsh_error', value.message ?? 'DSH 请求未完成。', !!value.retryable, res.statusCode));
          else resolve(value);
        } catch { reject(new BridgeError('protocol_error', 'DSH 插件返回格式不兼容。')); }
      });
    });
    req.on('error', (e) => reject(e instanceof BridgeError ? e : new BridgeError(signal?.aborted ? 'cancelled' : e.code === 'ABORT_ERR' ? 'timeout' : 'dsh_unavailable', signal?.aborted ? '任务已取消。' : '无法连接 DSH 的 PaperRadar 插件，请检查宿主是否运行。', false, 503)));
    req.end(data);
  });
}
export async function readJson(req, maxBytes = 1500000) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new BridgeError('input_too_large', '请求内容超过上限。');
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { throw new BridgeError('invalid_request', '请求格式无效。'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BridgeError('invalid_request', '请求必须为对象。');
  return value;
}
export function sendJson(res, status, value) {
  if (res.destroyed) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(value));
}
