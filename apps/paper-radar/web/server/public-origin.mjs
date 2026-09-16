export function parsePublicOrigin(value) {
  if (value === undefined || value === '') return null;
  try {
    const url = new URL(value);
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      throw new Error();
    return url;
  } catch {
    throw new Error(
      'PAPER_RADAR_PUBLIC_ORIGIN 必须是完整的 HTTP/HTTPS 来源地址，不得包含账号、路径、查询参数或片段',
    );
  }
}
