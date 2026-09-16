export type ArxivReference = {
  id: string;
  version: number | null;
  url: string;
};
export function parseArxiv(value: string): ArxivReference | null {
  if (typeof value !== 'string' || value.length > 500) return null;
  let input = value.trim().replace(/^arxiv:\s*/i, '');
  if (/^https?:\/\//i.test(input)) {
    try {
      const u = new URL(input);
      if (
        !['arxiv.org', 'www.arxiv.org', 'export.arxiv.org'].includes(
          u.hostname,
        ) ||
        u.username ||
        u.password ||
        u.port
      )
        return null;
      if (!/^\/(abs|pdf|html)\//.test(u.pathname)) return null;
      input = u.pathname
        .replace(/^\/(abs|pdf|html)\//, '')
        .replace(/\.pdf$/i, '');
    } catch {
      return null;
    }
  }
  const match = input.match(
    /^(\d{2}(?:0[1-9]|1[0-2])\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v([1-9]\d{0,2}))?$/,
  );
  if (!match) return null;
  const version = match[2] ? Number(match[2]) : null;
  return {
    id: match[1],
    version,
    url: `https://arxiv.org/abs/${match[1]}${version ? 'v' + version : ''}`,
  };
}
