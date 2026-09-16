import { load } from 'cheerio';
import { SaxesParser } from 'saxes';
import { AnalysisError, hash } from '../analyses/contracts.mjs';
import { parseArxiv } from '../../lib/arxiv.ts';
import {
  isAnnouncementDate,
  announcementToday,
} from '../../lib/daily-source.ts';

export const FEED_VERSION = 'arxiv-announcements-v2';
const text = (node, name) =>
  node
    .children()
    .filter((_, e) => e.name === name)
    .first()
    .text()
    .trim();
export function parseFeed(xml, subject) {
  if (
    !/<feed[\s>]/.test(xml) ||
    !/<\/feed>\s*$/.test(xml) ||
    /<!DOCTYPE|<!ENTITY/i.test(xml)
  )
    throw new AnalysisError(
      'invalid_feed',
      '公告来源不是完整的 ATOM 文档。',
      true,
    );
  // Cheerio intentionally repairs malformed markup; coverage must not rely on
  // that recovery. Check XML well-formedness before extracting announcement data.
  try {
    new SaxesParser({ xmlns: true }).write(xml).close();
  } catch {
    throw new AnalysisError(
      'invalid_feed',
      '公告 XML 结构损坏，无法确认来源完整性。',
      true,
    );
  }
  const $ = load(xml, { xml: true }),
    feed = $('feed');
  const feedId = text(feed, 'id');
  if (
    feed.length !== 1 ||
    ![
      `http://rss.arxiv.org/atom/${subject}`,
      `https://rss.arxiv.org/atom/${subject}`,
    ].includes(feedId)
  )
    throw new AnalysisError('invalid_feed', '公告分类与订阅不一致。', true);
  const nodes = feed.children('entry'),
    issues = [],
    entries = [],
    rejected = [];
  if (feed.find('entry').length !== nodes.length)
    throw new AnalysisError(
      'invalid_feed',
      '公告条目嵌套异常，来源结构不完整。',
      true,
    );
  for (const element of nodes.toArray()) {
    const node = $(element),
      rawId = text(node, 'id'),
      parsed = parseArxiv(rawId.replace(/^oai:arXiv.org:/, ''));
    const published = text(node, 'published'),
      title = text(node, 'title');
    const type = text(node, 'arxiv:announce_type').replace('-', '_');
    const categories = node
      .children('category')
      .map((_, e) => $(e).attr('term'))
      .get();
    const abstract = text(node, 'summary')
      .replace(/^arXiv:[\s\S]*?\bAbstract:\s*/, '')
      .trim();
    if (
      !parsed?.version ||
      !title ||
      !abstract ||
      !/^\d{4}-\d{2}-\d{2}T/.test(published) ||
      !Number.isFinite(Date.parse(published)) ||
      new Date(published.slice(0, 10) + 'T00:00:00Z')
        .toISOString()
        .slice(0, 10) !== published.slice(0, 10) ||
      !categories.includes(subject) ||
      !['new', 'cross', 'replace', 'replace_cross'].includes(type)
    ) {
      rejected.push({
        id: rawId,
        title,
        published,
        reason: '条目编号、公告日期、摘要、分类或类型不完整。',
      });
      continue;
    }
    const paper = {
      id: parsed.id,
      version: parsed.version,
      url: parsed.url,
      title,
      abstract,
      authors: text(node, 'dc:creator').split(/,\s*/).filter(Boolean),
      categories: [...new Set(categories)].sort(),
      published,
      date: published.slice(0, 10),
      announce_type: type,
      license: text(node, 'dc:rights'),
    };
    paper.metadata_hash = hash(paper);
    paper.evidence_id = `metadata:${paper.metadata_hash.slice(0, 24)}:abstract`;
    entries.push(paper);
  }
  if (nodes.length >= 2000)
    issues.push('来源达到可能的条目上限，尚不能证明覆盖完整。');
  if (rejected.length)
    issues.push(`${rejected.length} 条公告无法完整解析，已保存待核验。`);
  if (!entries.length)
    throw new AnalysisError(
      'announcement_unknown',
      '来源没有可确定日期的公告条目；不能据此判断今天没有论文。',
      true,
    );
  const groups = [];
  for (const date of [...new Set(entries.map((e) => e.date))].sort((a, b) =>
    a.localeCompare(b),
  )) {
    const byId = new Map(),
      batchIssues = [...issues];
    let duplicates = 0;
    for (const entry of entries.filter((e) => e.date === date)) {
      const old = byId.get(entry.id);
      if (old) {
        duplicates++;
        if (old.metadata_hash !== entry.metadata_hash)
          batchIssues.push(`论文 ${entry.id} 的重复公告内容或版本冲突。`);
      } else byId.set(entry.id, entry);
    }
    const papers = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
    groups.push({
      subject,
      date,
      papers,
      duplicates,
      rejected,
      raw_count:
        entries.filter((e) => e.date === date).length + rejected.length,
      completeness: batchIssues.length ? 'incomplete' : 'complete',
      issues: [...new Set(batchIssues)],
      content_hash: hash({
        papers,
        rejected,
        issues: [...new Set(batchIssues)],
        parser: FEED_VERSION,
      }),
      coverage_basis:
        '完整闭合的官方 subject ATOM 响应；全部条目已解析、低于容量阈值且无未解决冲突。来源未提供独立总数，覆盖限于本次公开 feed。',
    });
  }
  return {
    groups,
    generated_at: text(feed, 'updated'),
    source_hash: hash(xml),
    parser_version: FEED_VERSION,
    entry_count: nodes.length,
  };
}
export class DailyDiscovery {
  constructor(arxiv, repository) {
    this.arxiv = arxiv;
    this.repo = repository;
    this.pending = new Map();
    this.recent = new Map();
  }
  async byDate(subject, date, signal) {
    signal.throwIfAborted();
    if (!isAnnouncementDate(date) || date > announcementToday())
      throw new AnalysisError(
        'invalid_date',
        '请选择有效且不晚于今天的公告日期。',
      );
    const saved = this.repo.announcementForDate(subject, date);
    if (saved?.completeness === 'complete') return saved;
    let sourceError;
    try {
      // The official feed has no historical date parameter. Fetch it once,
      // archive all its dated groups, and select only the exact requested day.
      await this.latest(subject, signal);
    } catch (e) {
      signal.throwIfAborted();
      sourceError = e;
    }
    signal.throwIfAborted();
    const revision = this.repo.announcementForDate(subject, date);
    if (revision) return revision;
    if (sourceError && sourceError.code !== 'announcement_unknown')
      throw new AnalysisError(
        'dated_source_unavailable',
        `${date} 的 ${subject} 公告尚未存档，且本次官方来源读取失败；请稍后重试。`,
        true,
      );
    throw new AnalysisError(
      'announcement_date_unavailable',
      `未找到 ${date} 的 ${subject} 公告：本机尚未存档，官方当前 feed 也未提供该日期。该日可能未发布或已不在 feed 中，不能据此生成空日报；请选择有存档的日期或返回最新公告。`,
      true,
    );
  }
  async latest(subject, signal) {
    // Shared source requests are independent of one subscriber's cancellation.
    if (!this.pending.has(subject)) {
      const cached = this.recent.get(subject);
      if (cached && Date.now() - cached.at < 60000) {
        signal.throwIfAborted();
        return cached.value;
      }
      const task = (async () => {
        const url = `https://rss.arxiv.org/atom/${subject}`;
        const response = await this.arxiv.download(
          url,
          AbortSignal.timeout(60000),
          'application/atom+xml',
          16 * 1024 * 1024,
        );
        const xml = response.bytes.toString('utf8'),
          parsed = parseFeed(xml, subject);
        const revisions = this.repo.archiveFeed({ ...parsed, url, xml });
        const value = {...revisions.at(-1),fetched_at:new Date().toISOString()};
        this.recent.set(subject, { at: Date.now(), value });
        return value;
      })();
      this.pending.set(subject, task);
      task.finally(() => this.pending.delete(subject)).catch(() => {});
    }
    const value = await this.pending.get(subject);
    signal.throwIfAborted();
    return value;
  }
}
