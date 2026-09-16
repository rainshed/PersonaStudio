import { AnalysisError } from '../analyses/contracts.mjs';
import { DataManagement } from './data-management.mjs';
import { openPersona } from './studio.mjs';

export function createManagement(
  analyses,
  daily,
  personaSettings,
  modelService,
  version,
) {
  const data = new DataManagement(analyses, daily, {
    busy: () => personaSettings?.isBusy() ?? false,
  });
  return async function management(req, url, body, response, json, local) {
    if (!/^\/api\/(data|diagnostics|studio)(?:\/|$)/.test(url.pathname))
      return false;
    if (!local) {
      json(response, 403, {
        error: '请在运行 Paper Radar 的电脑上管理数据和应用。',
      });
      return true;
    }
    try {
      const path = url.pathname;
      let result;
      if (req.method === 'GET' && path === '/api/data') result = data.list();
      else if (req.method === 'POST' && path === '/api/data/backups')
        result = await data.createBackup();
      else if (req.method === 'POST' && path === '/api/data/open')
        result = await data.openDirectory();
      else if (req.method === 'POST' && path === '/api/data/open-restored')
        result = await data.openRestored((await body(req)).id);
      else if (req.method === 'POST' && path === '/api/data/restore')
        result = await data.restore((await body(req)).id);
      else if (req.method === 'GET' && path.startsWith('/api/data/backups/')) {
        data.download(
          decodeURIComponent(path.slice('/api/data/backups/'.length)),
          response,
        );
        return true;
      } else if (req.method === 'POST' && path === '/api/studio/persona') {
        const settings = personaSettings?.settings();
        result = await openPersona(
          settings?.current?.workspace || settings?.draft?.workspace,
        );
      } else if (req.method === 'GET' && path === '/api/diagnostics') {
        const settings = personaSettings?.settings();
        const models = await modelService.config();
        const tasks = analyses.taskRuntime.snapshot();
        // Deliberate allowlist: excludes account names, paths, prompts, papers and raw errors.
        result = {
          schema: 'personastudio.radar-diagnostics/v1',
          app_version: version,
          node: process.version,
          platform: process.platform,
          persona: {
            configured: !!settings?.configured,
            connected: !!settings?.connected,
          },
          hosts: Object.fromEntries(
            ['codex', 'dsh'].map((name) => [
              name,
              { connected: !!models.backends?.[name]?.connected },
            ]),
          ),
          tasks: { running: tasks.active.length, queued: tasks.queued.length },
          counts: data.list().counts,
        };
      } else {
        json(response, 404, { error: '接口不存在。' });
        return true;
      }
      json(response, 200, result);
      return true;
    } catch (error) {
      if (error instanceof AnalysisError) throw error;
      console.error('Paper Radar maintenance:', error.message);
      throw new AnalysisError(
        'maintenance_failed',
        '维护操作未能完成，请检查文件、磁盘空间或本机日志。',
        true,
        503,
      );
    }
  };
}
