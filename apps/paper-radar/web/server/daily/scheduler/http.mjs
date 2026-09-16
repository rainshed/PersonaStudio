import { pageParams } from '../contracts.mjs';
export async function schedulerRoute(service, req, url, readBody) {
  const p = url.pathname.split('/').filter(Boolean).map(decodeURIComponent),
    method = req.method;
  const key = req.headers['idempotency-key'];
  const ok = (body) => ({ status: 200, body });
  if (p[1] === 'subscriptions' && p[3] === 'schedule') {
    const id = p[2];
    service.daily.repo.get('subscriptions', id);
    if (p.length === 4 && method === 'GET') return ok(service.status(id));
    if (p.length === 4 && method === 'PATCH')
      return ok(await service.save(id, await readBody(req)));
    if (p.length === 5 && p[4] === 'check' && method === 'POST')
      return { status: 202, body: service.check(id, key) };
    const { limit, offset } = pageParams(url);
    if (p.length === 5 && p[4] === 'checks' && method === 'GET')
      return ok({
        checks: service.repo
          .checks(id, limit, offset)
          .map((c) => service.publicCheck(c)),
      });
    if (p.length === 5 && p[4] === 'updates' && method === 'GET')
      return ok({
        updates: service.listUpdates(
          id,
          limit,
          offset,
          url.searchParams.get('needs_action') === '1',
        ),
      });
  }
  if (p[1] === 'schedule-checks' && p.length === 3 && method === 'GET')
    return ok({ check: service.publicCheck(service.repo.getCheck(p[2])) });
  if (
    p[1] === 'schedule-updates' &&
    p.length === 4 &&
    p[3] === 'process' &&
    method === 'POST'
  )
    return { status: 202, body: service.process(p[2], key) };
  return { status: 404, body: { code: 'not_found', error: '接口不存在。' } };
}
