import { load } from 'cheerio';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArxiv } from '../../lib/arxiv.ts';
import { AnalysisError, hash } from './contracts.mjs';

export const PARSER_VERSION = 'arxiv-blocks-v2';
const hosts = new Set([
  'arxiv.org',
  'www.arxiv.org',
  'export.arxiv.org',
  'rss.arxiv.org',
]);
const clean = (value) => value.replace(/\s+/gu, ' ').trim();
export function officialURL(value) {
  const u = new URL(value);
  if (
    u.protocol !== 'https:' ||
    !hosts.has(u.hostname) ||
    u.username ||
    u.password ||
    u.port
  )
    throw new AnalysisError('invalid_source', '论文来源地址无效。');
  return u;
}
export class ArxivReader {
  constructor(directory, { fetcher = fetch, interval = 3100 } = {}) {
    this.directory = directory;
    this.fetcher = fetcher;
    this.interval = interval;
    this.tail = Promise.resolve();
    this.last = 0;
  }
  async download(
    url,
    signal,
    accept = 'text/html',
    maxBytes = 8 * 1024 * 1024,
  ) {
    const previous = this.tail;
    let release;
    this.tail = new Promise((r) => {
      release = r;
    });
    await previous;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        await delay(
          Math.max(0, this.last + this.interval - Date.now()),
          undefined,
          { signal },
        );
        this.last = Date.now();
        try {
          let current = officialURL(url).href;
          const combined = AbortSignal.any([
            signal,
            AbortSignal.timeout(45000),
          ]);
          for (let redirect = 0; redirect < 5; redirect++) {
            const res = await this.fetcher(current, {
              signal: combined,
              redirect: 'manual',
              headers: {
                Accept: accept,
                'User-Agent': 'PaperRadar/0.2 (personal research reader)',
              },
            });
            if ([301, 302, 303, 307, 308].includes(res.status)) {
              const next = new URL(res.headers.get('location') || '', current);
              await res.body?.cancel();
              current = officialURL(next.href).href;
              continue;
            }
            if (!res.ok) {
              await res.body?.cancel();
              throw new AnalysisError(
                res.status === 404 ? 'paper_not_found' : 'arxiv_unavailable',
                res.status === 404
                  ? 'arXiv 未找到所请求的论文或格式。'
                  : 'arXiv 暂时无法访问，请稍后重试。',
                res.status === 429 || res.status >= 500,
              );
            }
            if (Number(res.headers.get('content-length')) > maxBytes) {
              await res.body?.cancel();
              throw new AnalysisError(
                'source_too_large',
                '论文来源超过本机读取大小限制。',
              );
            }
            const chunks = [];
            let size = 0;
            for await (const chunk of res.body) {
              size += chunk.length;
              if (size > maxBytes) {
                throw new AnalysisError(
                  'source_too_large',
                  '论文来源超过本机读取大小限制。',
                );
              }
              chunks.push(chunk);
            }
            return {
              bytes: Buffer.concat(chunks),
              url: current,
              type: res.headers.get('content-type') || '',
            };
          }
          throw new AnalysisError('invalid_source', '论文来源重定向过多。');
        } catch (e) {
          signal.throwIfAborted();
          if (attempt || (e instanceof AnalysisError && !e.retryable))
            throw e instanceof AnalysisError
              ? e
              : new AnalysisError(
                  'arxiv_unavailable',
                  'arXiv 网络请求失败或超时。',
                  true,
                );
          await delay(1500, undefined, { signal });
        }
      }
    } finally {
      release();
    }
  }
  async metadata(input, signal) {
    const requested = parseArxiv(input);
    if (!requested) throw new AnalysisError('invalid_arxiv_input', 'arXiv 编号无效。');
    if (requested.version) {
      try {
        const cached = JSON.parse(await readFile(join(this.directory, hash(`${requested.id}v${requested.version}:${PARSER_VERSION}`) + '.json'), 'utf8'));
        if (cached.id === requested.id && cached.version === requested.version && cached.parser_version === PARSER_VERSION && hash(await readFile(join(this.directory, cached.source_hash + '.source'))) === cached.source_hash) {
          const { blocks: _blocks, references: _references, ...meta } = cached; return meta;
        }
      } catch { /* Metadata cache is optional. */ }
    }
    try {
      const atom = await this.download(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(requested.id + (requested.version ? 'v' + requested.version : ''))}`, signal, 'application/atom+xml');
      return parseAtom(atom.bytes.toString('utf8'), requested);
    } catch (error) {
      signal.throwIfAborted(); if (error.code === 'version_mismatch') throw error;
      const abs = await this.download(requested.url, signal);
      return parseAbstract(abs.bytes.toString('utf8'), requested);
    }
  }
  async get(input, signal, onProgress = () => {}) {
    const requested = parseArxiv(input);
    if (!requested)
      throw new AnalysisError('invalid_arxiv_input', 'arXiv 编号无效。');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const key = (p) => hash(`${p.id}v${p.version}:${PARSER_VERSION}`);
    const readCache = async (p) => {
      try {
        const cached = JSON.parse(
          await readFile(join(this.directory, key(p) + '.json'), 'utf8'),
        );
        const raw = await readFile(
          join(this.directory, cached.source_hash + '.source'),
        );
        if (
          cached.id === p.id &&
          cached.version === p.version &&
          hash(raw) === cached.source_hash &&
          cached.parser_version === PARSER_VERSION
        )
          return { ...cached, cache_hit: true };
      } catch {
        /* A missing or corrupt cache is fetched again. */
      }
      return null;
    };
    if (requested.version) {
      const cached = await readCache(requested);
      if (cached) return cached;
    }
    onProgress('获取论文元数据并确认版本');
    let metadata;
    try {
      const atom = await this.download(
        `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(requested.id + (requested.version ? 'v' + requested.version : ''))}`,
        signal,
        'application/atom+xml',
      );
      metadata = parseAtom(atom.bytes.toString('utf8'), requested);
    } catch (e) {
      signal.throwIfAborted();
      if (e.code === 'version_mismatch') throw e;
      const abs = await this.download(requested.url, signal);
      metadata = parseAbstract(abs.bytes.toString('utf8'), requested);
    }
    const cached = await readCache(metadata);
    if (cached) return cached;
    const fullId = `${metadata.id}v${metadata.version}`;
    let source,
      parsed,
      fallbackReason = null;
    onProgress('读取全文、公式、图注和参考文献');
    try {
      source = await this.download(`https://arxiv.org/html/${fullId}`, signal);
      parsed = parseHTML(
        source.bytes.toString('utf8'),
        source.url,
        hash(source.bytes),
      );
      if (
        parsed.blocks.filter((b) => b.kind === 'paragraph').length < 5 ||
        parsed.blocks.reduce((n, b) => n + b.text.length, 0) < 1500
      )
        throw new AnalysisError('insufficient_source', 'HTML 正文不完整。');
    } catch (e) {
      signal.throwIfAborted();
      fallbackReason = e.code || 'html_unavailable';
      onProgress('HTML 不可用，正在读取 PDF 正文');
      source = await this.download(
        `https://arxiv.org/pdf/${fullId}`,
        signal,
        'application/pdf',
        30 * 1024 * 1024,
      );
      if (!source.bytes.subarray(0, 5).equals(Buffer.from('%PDF-')))
        throw new AnalysisError(
          'insufficient_source',
          '下载结果不是可解析的论文 PDF。',
        );
      parsed = await parsePDF(
        source.bytes,
        source.url,
        hash(source.bytes),
        signal,
      );
    }
    if (parsed.blocks.reduce((n, b) => n + b.text.length, 0) < 1500)
      throw new AnalysisError(
        'insufficient_source',
        '未获得足够的可读正文；不会仅凭摘要生成全文分析。',
      );
    const result = {
      ...metadata,
      ...parsed,
      source_url: source.url,
      source_hash: hash(source.bytes),
      parser_version: PARSER_VERSION,
      retrieved_at: new Date().toISOString(),
      fallback_reason: fallbackReason,
      cache_hit: false,
    };
    await this.atomic(
      join(this.directory, result.source_hash + '.source'),
      source.bytes,
    );
    await this.atomic(
      join(this.directory, key(metadata) + '.json'),
      JSON.stringify(result),
    );
    return result;
  }
  async atomic(path, data) {
    const temp = path + '.tmp';
    await writeFile(temp, data, { mode: 0o600 });
    await rename(temp, path);
  }
}
export function parseAtom(xml, requested) {
  const $ = load(xml, { xml: true }),
    entry = $('entry').first();
  const ref = parseArxiv(entry.children('id').text());
  if (!ref || !ref.version || ref.id !== requested.id)
    throw new AnalysisError(
      'invalid_metadata',
      'arXiv 元数据未包含确定的论文版本。',
      true,
    );
  if (requested.version && ref.version !== requested.version)
    throw new AnalysisError('version_mismatch', '返回的论文版本与请求不一致。');
  return {
    ...ref,
    title: clean(entry.children('title').text()),
    authors: entry
      .find('author > name')
      .map((_, el) => clean($(el).text()))
      .get(),
    abstract: clean(entry.children('summary').text()),
    published_at: entry.children('published').text(),
    updated_at: entry.children('updated').text(),
    categories: entry
      .find('category')
      .map((_, el) => $(el).attr('term'))
      .get(),
    license: null,
  };
}
export function parseAbstract(html, requested) {
  const $ = load(html),
    meta = (name) => $(`meta[name="${name}"]`).attr('content') || '';
  const title = meta('citation_title');
  if (!title || !$('blockquote.abstract').length)
    throw new AnalysisError('paper_not_found', '未找到可识别的论文摘要页面。');
  const patterns = [
    ...html.matchAll(
      new RegExp(
        requested.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + 'v([1-9][0-9]*)',
        'g',
      ),
    ),
  ].map((m) => Number(m[1]));
  const version = requested.version || Math.max(0, ...patterns);
  if (!version || (requested.version && !patterns.includes(requested.version)))
    throw new AnalysisError('version_mismatch', '无法确认所请求的论文版本。');
  const canonical = parseArxiv(
    meta('citation_arxiv_id') || meta('citation_pdf_url'),
  );
  if (canonical && canonical.id !== requested.id)
    throw new AnalysisError('version_mismatch', '论文标识与请求不一致。');
  return {
    id: requested.id,
    version,
    url: `https://arxiv.org/abs/${requested.id}v${version}`,
    title,
    authors: $('meta[name="citation_author"]')
      .map((_, el) => $(el).attr('content'))
      .get(),
    abstract: clean(
      $('blockquote.abstract')
        .text()
        .replace(/^\s*Abstract:\s*/, ''),
    ),
    categories: clean($('.subjects').text()).match(/[a-z-]+\.[A-Z]{2}/g) || [],
    published_at: meta('citation_date'),
    updated_at: meta('citation_online_date'),
    license: $('a[href*="creativecommons.org/licenses/"]').attr('href') || null,
  };
}
export function parseHTML(html, url, sourceHash) {
  const $ = load(html);
  $('script,style,nav,header,footer,.ltx_page_navbar').remove();
  $('math').each((_, el) => {
    const value =
      $(el).attr('alttext') ||
      $(el).find('annotation').first().text() ||
      $(el).text();
    $(el).replaceWith($('<span>').text(' $' + clean(value) + '$ '));
  });
  const blocks = [],
    references = [];
  const selected =
    '.ltx_para,.ltx_equation,.ltx_equationgroup,.ltx_caption,.ltx_bibitem,.ltx_tabular';
  $(selected).each((_, el) => {
    const item = $(el);
    if (item.parents(selected).length) return;
    const text = clean(item.text());
    if (text.length < 12) return;
    const kind = item.hasClass('ltx_bibitem')
      ? 'reference'
      : item.hasClass('ltx_caption')
        ? 'caption'
        : item.hasClass('ltx_tabular')
          ? 'table'
          : /ltx_equation/.test(item.attr('class') || '')
            ? 'equation'
            : 'paragraph';
    const anchor = item.attr('id') || item.closest('[id]').attr('id') || '';
    const id = `paper:${sourceHash.slice(0, 16)}:${blocks.length + 1}`;
    const section =
      clean(item.closest('section').children('.ltx_title').first().text()) ||
      (kind === 'reference' ? 'References' : 'Paper');
    const block = {
      id,
      kind,
      section,
      text,
      url: url + (anchor ? '#' + encodeURIComponent(anchor) : ''),
      anchor,
    };
    blocks.push(block);
    if (kind === 'reference')
      references.push({
        evidence_id: id,
        text,
        links: item
          .find('a[href]')
          .map((_, a) => $(a).attr('href'))
          .get(),
        anchor,
      });
  });
  return {
    blocks,
    references,
    coverage: {
      format: 'html',
      main_text: blocks.length > 0,
      reference_count: references.length,
      block_count: blocks.length,
      figures_interpreted: false,
      supplement_detected:
        $('.ltx_appendix').length > 0 ||
        blocks.some(
          (b) =>
            b.kind !== 'reference' &&
            (/appendix|supplement/i.test(b.section) ||
              /^(?:supplement(?:al|ary)?\s+(?:material|information|appendix)|appendix\b)/i.test(
                b.text,
              )),
        ),
      issues: references.length
        ? ['图像未独立分析；正文、公式与图注已抽取。']
        : ['未提取到参考文献，引用匹配可能不完整。', '图像未独立分析。'],
    },
  };
}
export async function parsePDF(bytes, url, sourceHash, signal) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: true,
    isEvalSupported: false,
    disableFontFace: true,
    verbosity: 0,
  });
  const abort = () => {
    void task.destroy().catch(() => {});
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    const pdf = await task.promise;
    if (pdf.numPages > 300)
      throw new AnalysisError(
        'source_too_large',
        'PDF 超过 300 页，请使用可读 HTML 或更短文献。',
      );
    const blocks = [],
      references = [];
    let inReferences = false;
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      signal.throwIfAborted();
      const page = await pdf.getPage(pageNumber),
        content = await page.getTextContent();
      let text = '';
      for (const item of content.items)
        if ('str' in item) text += item.str + (item.hasEOL ? '\n' : ' ');
      for (const part of text
        .split(/\n\s*\n/)
        .flatMap((part) => part.match(/[\s\S]{1,2500}(?:\s|$)/g) || [])) {
        const value = clean(part);
        if (value.length < 20) continue;
        if (/^(?:references|bibliography)\b/i.test(value)) inReferences = true;
        const id = `paper:${sourceHash.slice(0, 16)}:${blocks.length + 1}`;
        blocks.push({
          id,
          kind: 'paragraph',
          section: `PDF page ${pageNumber}`,
          text: value,
          url: url + '#page=' + pageNumber,
          page: pageNumber,
        });
        if (inReferences)
          references.push({
            evidence_id: id,
            text: value,
            links: [],
            anchor: '',
          });
      }
      page.cleanup();
    }
    return {
      blocks,
      references,
      coverage: {
        format: 'pdf',
        main_text: true,
        reference_count: null,
        block_count: blocks.length,
        page_count: pdf.numPages,
        figures_interpreted: false,
        supplement_detected: false,
        issues: [
          'PDF 文本抽取；双栏顺序、数学符号与参考文献识别可能不完整。',
          '图像未分析。',
        ],
      },
    };
  } catch (e) {
    signal.throwIfAborted();
    throw e instanceof AnalysisError
      ? e
      : new AnalysisError(
          'insufficient_source',
          'PDF 无法提取可用正文，可能是扫描件或受限格式。',
        );
  } finally {
    signal.removeEventListener('abort', abort);
    await task.destroy().catch(() => {});
  }
}
