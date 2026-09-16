import { previewApplication, applyConfiguration } from './applications.mjs';
import { AnalysisError } from '../analyses/contracts.mjs';
export async function evaluationRoute(service, req, url, body) {
  const path = decodeURIComponent(
      url.pathname.slice('/api/evaluations/v1'.length),
    ),
    method = req.method;
  const input = method === 'GET' ? {} : await body(req);
  let match;
  if (method === 'GET' && path === '/experiment-options')
    return service.experimentOptions(
      url.searchParams.get('suite_id'),
      url.searchParams.get('scope_key'),
    );
  if (path === '/drafts') {
    if (method === 'GET')
      return { items: service.repo.all('evaluation_drafts') };
    if (method === 'POST') {
      await service.experimentOptions(input.configuration?.suite_id);
      return service.saveDraft(input);
    }
  }

  if (method === 'GET' && path === '/dataset')
    return { items: service.dataset(), suite: service.datasetSuite() };
  if (method === 'POST' && path === '/dataset/snapshot')
    return service.freezeDataset(input);
  if (method === 'PUT' && (match = path.match(/^\/cases\/([^/]+)\/answer$/))) {
    const c = service.repo.get('evaluation_cases', match[1]);
    if (!['recommended', 'not_recommended'].includes(input.expected_outcome))
      throw new AnalysisError('invalid_request', '测试答案无效。');
    return service.feedback(c.source.version_id, {
      ...input,
      value:
        c.original_outcome === input.expected_outcome ? 'positive' : 'negative',
    });
  }
  if (method === 'GET' && path === '/options') return service.options();
  if (method === 'GET' && path === '/cases') return { items: service.cases() };
  if ((match = path.match(/^\/cases\/([^/]+)$/))) {
    if (method === 'GET') return service.repo.get('evaluation_cases', match[1]);
    if (method === 'DELETE')
      return service.withdraw(match[1], { ...input, remove: true });
  }
  if ((match = path.match(/^\/subjects\/([^/]+)(\/feedback)?$/))) {
    if (method === 'GET') return service.subject(match[1]);
    if (method === 'PUT') return service.feedback(match[1], input);
    if (method === 'DELETE')
      return service.feedback(match[1], null, {
        expected_revision: input.expected_feedback_revision,
        idempotency_key: input.idempotency_key,
      });
  }
  if (
    (match = path.match(/^\/runs\/([^/]+)\/(apply-preview|apply)$/)) &&
    method === 'POST'
  )
    return match[2] === 'apply-preview'
      ? previewApplication(service, match[1], input)
      : applyConfiguration(service, match[1], input);
  if (path === '/suites') {
    if (method === 'GET')
      return { items: service.repo.all('evaluation_suites') };
    if (method === 'POST') return service.freeze(input);
  }
  if (path === '/runs/preview' && method === 'POST') {
    if (input.candidates?.some((c) => c.selection))
      await service.experimentOptions(input.suite_id);
    return service.preview(input);
  }
  if (path === '/runs') {
    if (method === 'GET')
      return {
        items: service.repo
          .all('evaluation_runs')
          .map((r) => service.report(r.id)),
      };
    if (method === 'POST') {
      if (!input.preview_id && input.candidates?.some((c) => c.selection))
        await service.experimentOptions(input.suite_id);
      return service.start(input);
    }
  }
  if ((match = path.match(/^\/runs\/([^/]+)(?:\/(cancel|resume))?$/))) {
    if (method === 'GET') return service.report(match[1]);
    if (method === 'POST' && match[2] === 'cancel')
      return service.cancel(match[1]);
    if (method === 'POST' && match[2] === 'resume')
      return service.resume(match[1], input);
  }
  if (method === 'POST' && path === '/imports/legacy-feedback')
    return service.importLegacy();
  if (method === 'POST' && path === '/exports') return service.export();
  if (method === 'POST' && path === '/imports') return service.import(input);
  throw new AnalysisError('not_found', '评测接口不存在。', false, 404);
}
