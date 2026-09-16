import { AnalysisError, hash, safeError } from '../analyses/contracts.mjs';

const unique = (values) =>
  [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
const announcementRank = { new: 0, cross: 1, replace_cross: 2, replace: 3 };

// Source snapshots remain immutable. A bundle is a separate, reproducible public
// revision, keyed by the category set and announcement date, never by a user.
export function mergeSubjectSources(subjects, results, requestedDate) {
  const selected = unique(subjects);
  const successes = results.filter((r) => r.revision);
  if (
    !successes.length ||
    (requestedDate && !successes.some((r) => r.revision.date === requestedDate))
  )
    throw new AnalysisError(
      requestedDate ? 'announcement_date_unavailable' : 'sources_unavailable',
      requestedDate
        ? `${requestedDate} 的所选分类公告均不可用，未生成日报。${results.find((r) => r.error?.message)?.error.message ?? '请检查公告存档或稍后重试。'}`
        : '所有所选分类的公告均未能读取，请稍后重试。',
      true,
    );
  const date =
    requestedDate ??
    successes
      .map((r) => r.revision.date)
      .sort()
      .at(-1);
  const issues = [],
    sources = [],
    entries = [],
    rejected = [];
  let rawCount = 0,
    duplicates = 0,
    crossDuplicates = 0;
  for (const subject of selected) {
    const result = results.find((r) => r.subject === subject);
    const revision = result?.revision;
    const source = {
      subject,
      source_url:
        revision?.source_url ?? `https://rss.arxiv.org/atom/${subject}`,
      revision_id: revision?.id ?? null,
      fetched_at: revision?.fetched_at ?? null,
      date: revision?.date ?? null,
      raw_count: revision?.raw_count ?? 0,
      completeness: revision?.completeness ?? 'incomplete',
      status: !revision
        ? 'failed'
        : revision.date === date
          ? 'included'
          : 'different_date',
      issues: revision?.issues ?? [
        result?.error?.message ?? '未能读取该分类公告。',
      ],
    };
    sources.push(source);
    if (!revision) {
      issues.push(`${subject}：${source.issues.join('；')}`);
      continue;
    }
    if (revision.date !== date) {
      issues.push(
        `${subject} 的来源公告为 ${revision.date}，与本批 ${date} 不同，未混入其他日期的论文。`,
      );
      continue;
    }
    issues.push(...revision.issues.map((issue) => `${subject}：${issue}`));
    if (revision.completeness !== 'complete' && !revision.issues.length)
      issues.push(`${subject} 的公告覆盖尚未确认完整。`);
    rawCount += revision.raw_count;
    duplicates += revision.duplicates;
    rejected.push(...revision.rejected.map((r) => ({ ...r, subject })));
    for (const paper of revision.papers) entries.push({ subject, paper });
  }
  const byId = new Map();
  for (const entry of entries) {
    const matches = byId.get(entry.paper.id) ?? [];
    matches.push(entry);
    byId.set(entry.paper.id, matches);
  }
  const papers = [...byId.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, matches]) => {
      crossDuplicates += matches.length - 1;
      const versions = unique(matches.map((m) => m.paper.version));
      const version = Math.max(...versions);
      if (versions.length > 1)
        issues.push(
          `论文 ${id} 在所选分类中版本不一致，保留 v${version} 并标记来源缺口。`,
        );
      const current = matches.filter((m) => m.paper.version === version);
      const contentHashes = new Set(
        current.map(({ paper }) =>
          hash({
            title: paper.title,
            abstract: paper.abstract,
            authors: paper.authors,
          }),
        ),
      );
      if (contentHashes.size > 1)
        issues.push(`论文 ${id}v${version} 的跨分类元数据不一致，请核对原文。`);
      // A new/cross announcement in any selected category makes that version
      // eligible, even when another category calls it a replacement.
      const announceType = current
        .map((m) => m.paper.announce_type)
        .sort((a, b) => announcementRank[a] - announcementRank[b])[0];
      const {
        metadata_hash: _hash,
        evidence_id: _evidence,
        ...metadata
      } = current[0].paper;
      const paper = {
        ...metadata,
        announce_type: announceType,
        categories: unique(current.flatMap((m) => m.paper.categories)),
        matched_subjects: unique(matches.map((m) => m.subject)),
        source_matches: matches.map((m) => ({
          subject: m.subject,
          version: m.paper.version,
          announce_type: m.paper.announce_type,
        })),
      };
      paper.metadata_hash = hash(paper);
      paper.evidence_id = `metadata:${paper.metadata_hash.slice(0, 24)}:abstract`;
      return paper;
    });
  const group = {
    subject: 'multi:' + hash(selected).slice(0, 24),
    subjects: selected,
    date,
    papers,
    sources,
    duplicates: duplicates + crossDuplicates,
    cross_subject_duplicates: crossDuplicates,
    raw_count: rawCount,
    rejected,
    issues: unique(issues),
    completeness: issues.length ? 'incomplete' : 'complete',
    coverage_basis:
      '按所选分类读取官方 ATOM 公告，仅合并同一公告日期的论文，按 arXiv 编号去重。各分类的来源、日期和读取缺口分别记录。',
  };
  return {
    ...group,
    content_hash: hash({ ...group, parser: 'arxiv-subject-bundle-v1' }),
  };
}

export async function discoverSubjects(
  discovery,
  repo,
  subjects,
  signal,
  onProgress = () => {},
  date,
) {
  const selected = unique(subjects);
  const fetchSubject = (subject) =>
    date
      ? discovery.byDate(subject, date, signal)
      : discovery.latest(subject, signal);
  if (selected.length === 1) return fetchSubject(selected[0]);
  const results = [];
  // Keep concurrency bounded even for subscriptions spanning many categories.
  for (let offset = 0; offset < selected.length; offset += 3) {
    signal.throwIfAborted();
    onProgress(
      `读取分类公告 ${offset + 1}–${Math.min(offset + 3, selected.length)}/${selected.length}`,
    );
    const chunk = selected.slice(offset, offset + 3);
    const fetched = await Promise.allSettled(chunk.map(fetchSubject));
    signal.throwIfAborted();
    fetched.forEach((result, index) => {
      const subject = chunk[index];
      if (result.status === 'fulfilled' && result.value.subject === subject)
        results.push({ subject, revision: result.value });
      else
        results.push({
          subject,
          error:
            result.status === 'rejected'
              ? safeError(result.reason)
              : { message: '公告来源返回的分类不一致。' },
        });
    });
  }
  const bundle = mergeSubjectSources(selected, results, date);
  signal.throwIfAborted();
  return repo.archiveSubjectBundle(bundle);
}
