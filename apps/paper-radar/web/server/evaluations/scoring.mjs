export const SCORING_VERSION = 'binary-feedback/v1';
export const binary = (value) =>
  ['recommended', 'not_recommended'].includes(value);
export function expectedOutcome(original, value) {
  if (!binary(original) || !['positive', 'negative'].includes(value))
    throw new Error(
      'A binary original decision and explicit feedback are required',
    );
  return value === 'positive'
    ? original
    : original === 'recommended'
      ? 'not_recommended'
      : 'recommended';
}
const ratio = (numerator, denominator) => ({
  numerator,
  denominator,
  value: denominator ? numerator / denominator : null,
});
export function scoreItems(items) {
  let TP = 0,
    TN = 0,
    FP = 0,
    FN = 0;
  const states = {},
    labels = {
      recommended: { total: 0, valid: 0, correct: 0 },
      not_recommended: { total: 0, valid: 0, correct: 0 },
    };
  for (const item of items) {
    states[item.status] = (states[item.status] ?? 0) + 1;
    const group = labels[item.expected_outcome];
    if (group) group.total++;
    if (!group || item.status !== 'completed' || !binary(item.outcome))
      continue;
    const correct = item.outcome === item.expected_outcome;
    group.valid++;
    group.correct += Number(correct);
    if (item.expected_outcome === 'recommended') {
      if (correct) TP++;
      else FN++;
    } else if (correct) TN++;
    else FP++;
  }
  const valid = TP + TN + FP + FN,
    correct = TP + TN,
    total = items.length;
  return {
    total,
    valid,
    correct,
    TP,
    TN,
    FP,
    FN,
    states,
    labels,
    pass_rate: ratio(correct, total),
    coverage: ratio(valid, total),
    accuracy: ratio(correct, valid),
    false_positive_rate: ratio(FP, TN + FP),
    false_negative_rate: ratio(FN, TP + FN),
  };
}
export function compareItems(a, b) {
  const pairs = new Map(
    b.map((v) => [`${v.case_id}:${v.benchmark_revision}`, v]),
  );
  return a.flatMap((left) => {
    const right = pairs.get(`${left.case_id}:${left.benchmark_revision}`);
    if (!right) return [];
    const passes = (v) =>
      v.status === 'completed' &&
      binary(v.outcome) &&
      v.outcome === v.expected_outcome;
    const x = passes(left),
      y = passes(right);
    return [
      {
        case_id: left.case_id,
        benchmark_revision: left.benchmark_revision,
        change: x
          ? y
            ? 'both_pass'
            : 'regression'
          : y
            ? 'improvement'
            : 'neither_pass',
        both_valid: left.status === 'completed' && right.status === 'completed',
        a: { status: left.status, outcome: left.outcome },
        b: { status: right.status, outcome: right.outcome },
      },
    ];
  });
}

export function usageForItems(items) {
  const attempts = [
    ...new Map(
      items
        .flatMap((item) => item.attempts ?? [])
        .map((attempt) => [attempt.id, attempt]),
    ).values(),
  ];
  const known = attempts.filter((a) => typeof a.usage?.cost === 'number');
  const knownCost = known.reduce((n, a) => n + a.usage.cost, 0);
  return {
    input: attempts.reduce((n, a) => n + (a.usage?.input ?? 0), 0),
    output: attempts.reduce((n, a) => n + (a.usage?.output ?? 0), 0),
    calls: attempts.length,
    token_usage_complete: attempts.every(
      (a) =>
        typeof a.usage?.input === 'number' &&
        typeof a.usage?.output === 'number',
    ),
    known_cost: knownCost,
    cost_complete: known.length === attempts.length,
    unknown_cost_calls: attempts.length - known.length,
    cost: known.length === attempts.length ? knownCost : null,
  };
}
