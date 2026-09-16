// Remote browser forwarding may omit or rewrite response headers. Validate the
// actual JSON payload, as AI Persona does, without weakening server-side access.
export async function readBackendResponse<T>(response: Response): Promise<T> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new Error(
      `访问入口没有返回后台数据（HTTP ${response.status}）。请刷新连接；远程转发需要同时包含页面和 API。`,
    );
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('后台返回格式无法识别，请刷新连接。');
  const result = value as {
    ok?: boolean;
    error?: string | { message?: string; code?: string };
    message?: string;
    code?: string;
  };
  if (!response.ok || result.ok === false) {
    const message =
      typeof result.error === 'string'
        ? result.error
        : (result.error?.message ?? result.message);
    throw Object.assign(
      new Error(message || `后台请求失败（HTTP ${response.status}），请重试。`),
      {
        code:
          (typeof result.error === 'object' ? result.error?.code : undefined) ??
          result.code,
      },
    );
  }
  return value as T;
}

/** Demo is an explicit build choice; ordinary local startup always connects to the backend. */
export function isStandaloneDemo(
  _location?: { hostname: string; port: string },
  mode = (import.meta as ImportMeta & { env?: Record<string, string> }).env
    ?.VITE_PAPER_RADAR_MODE,
) {
  return mode === 'demo';
}

// crypto.randomUUID requires a secure browser context; getRandomValues also
// works for private HTTP entry points. These IDs are not authentication tokens.
export function browserRequestId(
  source: Pick<Crypto, 'getRandomValues'> = crypto,
): string {
  const bytes = source.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(
    '',
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
