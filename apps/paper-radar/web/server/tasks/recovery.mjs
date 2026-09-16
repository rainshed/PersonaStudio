// Recovery preserves queued work and completed content. It never silently
// retries a paid/model operation or reconstructs a vanished host session.
const interrupted = (message) => ({
  code: 'interrupted',
  message,
  retryable: true,
});

export function recoverAnalyses(store) {
  const rows = store.db
    .prepare("SELECT data FROM jobs WHERE status='running'")
    .all();
  for (const row of rows) {
    const job = JSON.parse(row.data);
    job.status = 'interrupted';
    job.error = interrupted('服务中断，可从已完成步骤重试。');
    job.message = job.error.message;
    for (const stage of job.stages)
      if (['running', 'pending'].includes(stage.status))
        stage.status = 'interrupted';
    const result = store.result(job.result_id);
    store.transaction(() => {
      if (result) {
        for (const key of ['summary', 'personalization'])
          if (result[key]?.status === 'pending')
            result[key] = { status: 'failed', error: job.error };
        store.saveResult(result);
      }
      store.saveJob(job);
    });
  }
}

export function recoverDaily(repo) {
  repo.db
    .prepare(
      "UPDATE daily_screening_claims SET status='interrupted' WHERE status='running'",
    )
    .run();
  for (const row of repo.db
    .prepare("SELECT data FROM daily_runs WHERE status='running'")
    .all()) {
    const run = JSON.parse(row.data);
    run.status = 'interrupted';
    run.error = interrupted('服务中断，可以继续未完成部分。');
    run.message = run.error.message;
    repo.saveRun(run);
  }
}

export function recoverDiscussions(repo) {
  for (const row of repo.db
    .prepare("SELECT data FROM discussion_turns WHERE status='running'")
    .all()) {
    const turn = JSON.parse(row.data);
    turn.status = 'interrupted';
    turn.error = interrupted('服务中断，可以重试本条消息。');
    turn.message = turn.error.message;
    repo.saveTurn(turn);
  }
}
