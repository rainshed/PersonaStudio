import { pageParams } from './contracts.mjs';
import { subscriptionSubjects } from '../../lib/subscription-subjects.ts';

export async function dailyRoute(service, req, url, readBody) {
  const path = url.pathname.split('/').filter(Boolean).map(decodeURIComponent),
    method = req.method,
    key = req.headers['idempotency-key'];
  const body = () => readBody(req),
    ok = (value) => ({ status: 200, body: value }),
    accepted = (value) => ({ status: 202, body: value });
  if (method === 'GET' && path.join('/') === 'api/arxiv/subjects')
    return ok(service.catalog());
  if (path[1] === 'subscriptions') {
    if (path.length === 4 && path[3] === 'followed-authors' && method === 'PUT')
      return ok(service.saveFollowedAuthors(path[2], await body()));
    if (path.length === 4 && path[3] === 'author-papers' && ['GET', 'POST'].includes(method)) {
      const options = { ...pageParams(url), author: url.searchParams.get('author') ?? '' };
      return ok(method === 'POST'
        ? await service.refreshFollowedAuthors(path[2], options)
        : service.followedAuthorFeed(path[2], options));
    }
    if (path.length === 2 && method === 'GET')
      return ok({ subscriptions: service.repo.subscriptions() });
    if (path.length === 2 && method === 'POST')
      return {
        status: 201,
        body: await service.saveSubscription(await body()),
      };
    if (path.length === 3 && method === 'GET')
      return ok(service.repo.get('subscriptions', path[2]));
    if (path.length === 3 && method === 'PATCH')
      return ok(await service.saveSubscription(await body(), path[2]));
  }
  if (path[1] === 'daily-runs') {
    if (path.length === 2 && method === 'POST')
      return accepted(service.create(await body(), key));
    if (path.length === 2 && method === 'GET') {
      const page = pageParams(url),
        runs = service.listRuns({
          ...page,
          subscriptionId: url.searchParams.get('subscription_id') ?? undefined,
        });
      return ok({
        runs,
        next_offset:
          runs.length === page.limit ? page.offset + page.limit : null,
      });
    }
    if (path.length === 3 && method === 'GET')
      return ok(service.getRun(path[2]));
    if (path.length === 4 && path[3] === 'cancel' && method === 'POST')
      return ok(service.cancel(path[2]));
    if (path.length === 4 && path[3] === 'retry' && method === 'POST')
      return accepted(service.retry(path[2], await body(), key));
    if (path.length === 4 && path[3] === 'items' && method === 'GET')
      return ok(
        service.items(path[2], {
          ...pageParams(url),
          decision: url.searchParams.get('decision'),
          status: url.searchParams.get('status'),
          query: url.searchParams.get('query') ?? '',
        }),
      );
  }
  if (path[1] === 'daily-reports') {
    if (path.length === 2 && method === 'GET') {
      const page = pageParams(url),
        reports = service.repo.reports({
          ...page,
          subscriptionId: url.searchParams.get('subscription_id'),
          date: url.searchParams.get('date'),
        });
      return ok({
        dates: service.repo.reportDates(
          url.searchParams.get('subscription_id'),
        ),
        available_dates: url.searchParams.get('subscription_id')
          ? service.repo.availableAnnouncementDates(
              subscriptionSubjects(
                service.repo.get(
                  'subscriptions',
                  url.searchParams.get('subscription_id'),
                ),
              ),
            )
          : [],
        reports: reports.map((r) => ({
          ...r,
          current_run: service.getRun(r.current_run_id),
        })),
        next_offset:
          reports.length === page.limit ? page.offset + page.limit : null,
      });
    }
    if (path.length === 3 && method === 'GET')
      return ok(service.getReport(path[2]));
    if (path.length === 3 && method === 'DELETE')
      return ok(await service.deleteReport(path[2]));
  }
  if (path[1] === 'daily-items') {
    if (path.length === 3 && method === 'GET')
      return ok(service.getItem(path[2]));
    if (path.length === 4 && path[3] === 'analyze' && method === 'POST')
      return accepted(service.analyzeItem(path[2], key, await body()));
    if (path.length === 4 && path[3] === 'rescreen' && method === 'POST')
      return accepted(service.rescreenItem(path[2], key, await body()));
  }
  if (path[1] === 'daily-item-versions') {
    if (path.length === 3 && method === 'GET')
      return ok(service.getVersion(path[2]));
    if (path.length === 5 && path[3] === 'evidence' && method === 'GET')
      return ok(service.evidence(path[2], path[4]));
    if (
      path.length === 5 &&
      path[3] === 'feedback' &&
      ['PUT', 'DELETE'].includes(method)
    )
      return ok(
        service.feedback(
          path[2],
          path[4],
          method === 'DELETE' ? null : await body(),
        ),
      );
  }
  return { status: 404, body: { code: 'not_found', error: '接口不存在' } };
}
