import { AnalysisError } from './contracts.mjs';
import { listResearchFeedback } from './research-feedback.mjs';

function pageParams(url) {
  const limit = Number(url.searchParams.get('limit') ?? 25),
    offset = Number(url.searchParams.get('offset') ?? 0);
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isInteger(offset) ||
    offset < 0 ||
    offset > 100000
  )
    throw new AnalysisError('invalid_request', '分页参数无效。');
  return { limit, offset };
}
export async function analysisRoute(service, req, url, readBody, signal) {
  if (
    !service ||
    !(
      url.pathname === '/api/capabilities' ||
      /^\/api\/(persona|jobs|analyses)(?:\/|$)/.test(url.pathname)
    )
  )
    return null;
  const path = url.pathname.split('/').filter(Boolean).map(decodeURIComponent),
    method = req.method;
  const body = () => readBody(req),
    key = req.headers['idempotency-key'];
  if (path[1] === 'persona' && path[2] === 'settings') {
    if (!service.personaSettings)
      throw new AnalysisError('unavailable', '此服务尚不支持本机连接设置，请更新 Paper Radar。', false, 503);
    if (method === 'GET' && path.length === 3)
      return { status: 200, body: service.personaSettings.settings() };
    if (method === 'POST' && path[3] === 'pick' && path.length === 4)
      return { status: 200, body: await service.personaSettings.pathPicker.pick(await body(), signal) };
    if (method === 'POST' && path[3] === 'test' && path.length === 4)
      return { status: 200, body: await service.personaSettings.test(await body()) };
    if (method === 'PUT' && path.length === 3)
      return { status: 200, body: await service.personaSettings.save(await body()) };
    if (method === 'DELETE' && path[3] === 'pending' && path.length === 4)
      return { status: 200, body: service.personaSettings.cancel(await body()) };
    throw new AnalysisError('not_found', '接口不存在。', false, 404);
  }
  if (method === 'GET' && path[1] === 'capabilities')
    return {
      status: 200,
      body: {
        mode: 'local',
        single_analysis: true,
        version: '0.5.0',
        persona_query_schema: 'ai-persona.query-result/v2',
        recommendation_basis: 'selected_tag_knowledge',
        language: ['zh', 'en'],
        summary_length: {
          min: 200,
          max: 3000,
          default: { min: 800, max: 1200 },
        },
      },
    };
  if (method === 'GET' && path[1] === 'persona') {
    if (path[2] === 'status' && path.length === 3)
      return { status: 200, body: await service.persona.status() };
    if (path[2] === 'tags' && path.length === 3)
      return {
        status: 200,
        body: await service.persona.tags(
          {
            query: url.searchParams.get('query') ?? '',
            cursor: url.searchParams.get('cursor') ?? undefined,
            expected_persona_revision: url.searchParams.has('revision')
              ? Number(url.searchParams.get('revision'))
              : undefined,
          },
          AbortSignal.timeout(90000),
        ),
      };
  }
  if (path[1] === 'jobs') {
    if (method === 'GET' && path.length === 2) {
      const { limit, offset } = pageParams(url);
      const jobs = service.listJobs(limit, offset);
      return {
        status: 200,
        body: {
          jobs,
          next_offset: jobs.length === limit ? offset + limit : null,
        },
      };
    }
    if (method === 'GET' && path.length === 3)
      return { status: 200, body: service.getJob(path[2]) };
    if (method === 'POST' && path[3] === 'cancel' && path.length === 4)
      return { status: 200, body: service.cancel(path[2]) };
    if (method === 'POST' && path[3] === 'retry' && path.length === 4)
      return { status: 202, body: service.retry(path[2], key) };
  }
  if (path[1] === 'analyses') {
    if (method === 'GET' && path[2] === 'feedback' && path.length === 3)
      return {
        status: 200,
        body: listResearchFeedback(service.db.db, {
          ...pageParams(url),
          dimension: url.searchParams.get('dimension') ?? '',
          value: url.searchParams.get('value') ?? '',
          query: (url.searchParams.get('query') ?? '').slice(0, 500),
        }),
      };
    if (method === 'POST' && path.length === 2)
      return { status: 202, body: service.create(await body(), key) };
    if (method === 'GET' && path.length === 2) {
      const { limit, offset } = pageParams(url);
      const rows = service.db.db
        .prepare(
          'SELECT id,job_id,created_at FROM results ORDER BY created_at DESC LIMIT ? OFFSET ?',
        )
        .all(limit, offset);
      return {
        status: 200,
        body: {
          results: rows,
          next_offset: rows.length === limit ? offset + limit : null,
        },
      };
    }
    if (method === 'GET' && path.length === 3)
      return { status: 200, body: service.getResult(path[2]) };
    if (method === 'GET' && path[3] === 'evidence' && path.length === 5)
      return { status: 200, body: service.evidence(path[2], path[4]) };
    if (
      ['PUT', 'DELETE'].includes(method) &&
      path[3] === 'feedback' &&
      path.length === 5
    )
      return {
        status: 200,
        body: service.feedback(
          path[2],
          path[4],
          method === 'DELETE' ? null : await body(),
        ),
      };
    if (method === 'DELETE' && path.length === 3) {
      service.db.deleteResult(path[2]);
      return { status: 200, body: { ok: true } };
    }
  }
  return { status: 404, body: { code: 'not_found', error: '接口不存在' } };
}
