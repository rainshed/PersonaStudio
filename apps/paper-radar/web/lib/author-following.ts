import {
  subscriptionSubjects,
  type SubjectScope,
} from './subscription-subjects.ts';

export const cleanAuthorName = (name: string) =>
  name.normalize('NFC').trim().replace(/\s+/gu, ' ');
export const authorNameKey = (name: string) =>
  cleanAuthorName(name).toLowerCase();

export function uniqueAuthorNames(names: string[]): string[] {
  const seen = new Set<string>();
  return names.map(cleanAuthorName).filter((name) => {
    const key = authorNameKey(name);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Names are compared in full. Initials, punctuation and name order are preserved.
export function matchedFollowedAuthors(
  paper: { authors: string[]; categories: string[] },
  scope: SubjectScope & { followed_authors?: string[] },
): string[] {
  if (!subscriptionSubjects(scope).some((s) => paper.categories.includes(s)))
    return [];
  const names = new Set(paper.authors.map(authorNameKey));
  return uniqueAuthorNames(scope.followed_authors ?? []).filter((name) =>
    names.has(authorNameKey(name)),
  );
}
