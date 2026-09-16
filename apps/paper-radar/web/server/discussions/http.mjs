export async function discussionRoute(service, req, url, readBody) {
  const p = url.pathname.split('/').filter(Boolean).map(decodeURIComponent),
    m = req.method,
    key = req.headers['idempotency-key'];
  const ok = (body) => ({ status: 200, body }),
    accepted = (body) => ({ status: 202, body });
  if (p[1] === 'discussions') {
    if (p.length === 2 && m === 'POST')
      return ok(service.create(await readBody(req)));
    if (p.length === 3 && m === 'GET') return ok(service.get(p[2]));
    if (p.length === 3 && m === 'DELETE') return ok(await service.delete(p[2]));
    if (p.length === 4 && p[3] === 'messages' && m === 'POST')
      return accepted(service.send(p[2], await readBody(req), key));
    if (
      p.length === 7 &&
      p[3] === 'messages' &&
      p[5] === 'evidence' &&
      m === 'GET'
    )
      return ok(service.evidence(p[2], p[4], p[6]));
  }
  if (p[1] === 'discussion-messages' && p.length === 4 && m === 'POST') {
    if (p[3] === 'retry') return accepted(service.retry(p[2], key));
    if (p[3] === 'cancel') return ok(service.cancel(p[2]));
  }
  return { status: 404, body: { code: 'not_found', error: '接口不存在' } };
}
