import { hash } from '../../analyses/contracts.mjs';
import { subscriptionSubjects } from '../../../lib/subscription-subjects.ts';
import { resolveConnection } from '../../../lib/host-models.ts';
export const CONTENT_VERSION = 'announcement-content-v1';
const text = (s) =>
  String(s ?? '')
    .replace(/\r\n?/g, '\n')
    .trim()
    .normalize('NFC');
const sorted = (a) =>
  [...new Set(a ?? [])].sort((x, y) => String(x).localeCompare(String(y)));
export const sourceScope = (s) => hash(sorted(subscriptionSubjects(s)));
export function paperContent(p) {
  return {
    id: p.id,
    version: p.version,
    date: p.date,
    announce_type: p.announce_type,
    title: text(p.title),
    abstract: text(p.abstract),
    authors: (p.authors ?? []).map(text),
    categories: sorted(p.categories),
    license: text(p.license),
    matched_subjects: sorted(p.matched_subjects),
    source_matches: [...(p.source_matches ?? [])].sort((a, b) =>
      a.subject.localeCompare(b.subject),
    ),
  };
}
export const paperFingerprint = (p) => hash(paperContent(p));
export function contentFingerprint(revision) {
  return hash({
    subjects: sorted(subscriptionSubjects(revision)),
    date: revision.date,
    papers: revision.papers
      .map(paperContent)
      .sort((a, b) => a.id.localeCompare(b.id) || a.version - b.version),
  });
}
export function analysisConfig(s) {
  return {
    subjects: sorted(subscriptionSubjects(s)),
    persona_connection_id: s.persona_connection_id,
    scope: { tag_ids: sorted(s.scope.tag_ids), tag_match: s.scope.tag_match },
    language: s.language,
    recommendation_strictness: s.recommendation_strictness ?? 'balanced',
    include_updates: !!s.include_updates,
  };
}
export function screenModelFingerprint(settings) {
  const primary = resolveConnection(settings, 'screen');
  const fallback = settings.fallback?.enabled
    ? settings.connections.find((c) => c.id === settings.fallback.connectionId)
    : null;
  const project = (c) =>
    c
      ? {
          id: c.id,
          revision: c.revision,
          modelId: c.modelId,
          providerId: c.providerId,
          maxTokens: c.maxTokens,
          temperature: c.temperature,
          reasoningEffort: c.reasoningEffort,
        }
      : null;
  return hash({
    host:
      settings.codex?.protocol ?? settings.dsh?.protocol ?? 'unsupported',
    primary: project(primary),
    fallback: project(fallback),
  });
}
export const eligiblePapers = (rev, sub) =>
  rev.papers.filter(
    (p) =>
      sub.include_updates ||
      !['replace', 'replace_cross'].includes(p.announce_type),
  );
