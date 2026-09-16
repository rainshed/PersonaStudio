export type SubjectScope = { subject?: string; subjects?: string[] };

// Keep old saved subscriptions and immutable report snapshots readable.
export function subscriptionSubjects(scope: SubjectScope): string[] {
  return [
    ...new Set(scope.subjects ?? (scope.subject ? [scope.subject] : [])),
  ].sort();
}
export const subjectLabel = (scope: SubjectScope) =>
  subscriptionSubjects(scope).join(' + ');
export const sameSubjects = (a: SubjectScope, b: SubjectScope) =>
  JSON.stringify(subscriptionSubjects(a)) ===
  JSON.stringify(subscriptionSubjects(b));
