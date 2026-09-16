'use client';
import { useEffect, useState } from 'react';
import { Download, FolderOpen, RefreshCw } from 'lucide-react';
import { analysisApi } from '@/lib/analysis-api';
import { useUiLanguage } from './ui-language';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog';
import './data-settings.css';

type Backup = { id: string; size: number; created_at: string };
type DataInfo = {
  directory: string;
  backups: Backup[];
  busy: boolean;
  folder_picker_available: boolean;
  counts: Record<string, number>;
};
export function DataSettings({ visible }: { visible: boolean }) {
  const { uiLanguage, locale, ui } = useUiLanguage();
  const zh = uiLanguage === 'zh';
  const [info, setInfo] = useState<DataInfo | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [restore, setRestore] = useState<Backup | null>(null);
  const [restored, setRestored] = useState<{
    directory: string;
    id: string;
  } | null>(null);
  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    void analysisApi<DataInfo>('data', { signal: controller.signal })
      .then((result) => {
        setInfo(result);
        setError('');
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => controller.abort();
  }, [visible, refresh]);
  async function action(name: string, work: () => Promise<void>) {
    setBusy(name);
    setError('');
    setNotice('');
    try {
      await work();
      setRefresh((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy('');
    }
  }
  return (
    <section className="research-section radar-data-settings">
      <h2>{zh ? '数据与维护' : 'Data and maintenance'}</h2>
      <p>
        {zh
          ? '论文、报告、反馈与提示词保存在电脑上。备份包含研究数据与 Persona 连接；模型账号由分析工具保管。'
          : 'Papers, reports, feedback and prompts stay on this computer. Backups include research data and the Persona connection; model accounts remain with your analysis tools.'}
      </p>
      {error && (
        <p className="persona-message error" role="alert">
          {ui(error)}
        </p>
      )}
      {notice && <output className="persona-message success">{notice}</output>}
      <div className="data-actions">
        <button
          className="button-secondary"
          disabled={!!busy}
          onClick={() => setRefresh((value) => value + 1)}
        >
          <RefreshCw size={15} />
          {zh ? '刷新状态' : 'Refresh'}
        </button>
        <button
          className="button-secondary"
          disabled={!!busy || !info?.folder_picker_available}
          onClick={() =>
            void action('open', async () => {
              await analysisApi('data/open', { method: 'POST', body: {} });
            })
          }
        >
          <FolderOpen size={15} />
          {zh ? '打开数据目录' : 'Open data folder'}
        </button>
        <button
          className="button-secondary"
          disabled={!!busy}
          onClick={() =>
            void action('diagnostics', async () => {
              const diagnostic = await analysisApi('diagnostics');
              const url = URL.createObjectURL(
                new Blob([JSON.stringify(diagnostic, null, 2)], {
                  type: 'application/json',
                }),
              );
              const link = document.createElement('a');
              link.href = url;
              link.download = 'paper-radar-diagnostics.json';
              link.click();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
              setNotice(
                zh
                  ? '诊断信息已导出，不包含账号、私人路径或论文内容。'
                  : 'Diagnostics exported without accounts, private paths or paper content.',
              );
            })
          }
        >
          <Download size={15} />
          {zh ? '导出诊断信息' : 'Export diagnostics'}
        </button>
      </div>
      {info && (
        <>
          <p className="data-directory">{info.directory}</p>
          <h3>{zh ? '备份与恢复' : 'Backup and restore'}</h3>
          <p>
            {zh
              ? '备份包含论文缓存，可能需要一些时间。恢复会创建新目录，当前数据保持不变；恢复副本中的自动检查会暂停。'
              : 'Backups include paper caches and may take some time. Restoring creates a new directory and preserves current data. Automatic checks are paused in the recovered copy.'}
          </p>
          <button
            className="button-primary"
            disabled={!!busy || info.busy}
            onClick={() =>
              void action('backup', async () => {
                await analysisApi('data/backups', {
                  method: 'POST',
                  body: {},
                  timeoutMs: 360000,
                });
                setNotice(
                  zh
                    ? '备份已创建，可以下载保存。'
                    : 'Backup created. You can now download it.',
                );
              })
            }
          >
            {busy === 'backup'
              ? zh
                ? '正在备份…'
                : 'Backing up…'
              : zh
                ? '创建备份'
                : 'Create backup'}
          </button>
          {info.busy && (
            <p>
              {zh
                ? '请等待任务完成，然后刷新状态再备份。'
                : 'Wait for tasks to finish, then refresh before backing up.'}
            </p>
          )}
          {info.backups.length === 0 ? (
            <p>{zh ? '还没有手动备份。' : 'No manual backups yet.'}</p>
          ) : (
            <ul className="data-backups">
              {info.backups.map((backup) => (
                <li key={backup.id}>
                  <span>
                    {new Date(backup.created_at).toLocaleString(locale)}
                    <small>{(backup.size / 1024 / 1024).toFixed(1)} MB</small>
                  </span>
                  <a
                    className="button-secondary"
                    href={'/api/data/backups/' + backup.id}
                  >
                    {zh ? '下载' : 'Download'}
                  </a>
                  <button
                    className="button-secondary"
                    disabled={!!busy}
                    onClick={() => setRestore(backup)}
                  >
                    {zh ? '恢复到新目录' : 'Restore to new folder'}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {restored && (
        <div className="persona-message" aria-live="polite">
          <strong>{zh ? '恢复副本已就绪' : 'Recovered copy ready'}</strong>
          <p className="data-directory">{restored.directory}</p>
          <p>
            {zh
              ? '可单独打开副本核对内容。自动检查已暂停，分析工具需要在副本中重新连接。'
              : 'Open the copy separately to review its content. Automatic checks are paused, and analysis tools need to be connected in the copy.'}
          </p>
          <button
            className="button-primary"
            disabled={!!busy}
            onClick={() =>
              void action('open-restored', async () => {
                const result = await analysisApi<{ url: string }>(
                  'data/open-restored',
                  {
                    method: 'POST',
                    body: { id: restored.id },
                    timeoutMs: 60000,
                  },
                );
                window.location.assign(result.url);
              })
            }
          >
            {zh ? '打开恢复副本' : 'Open recovered copy'}
          </button>
        </div>
      )}

      <AlertDialog
        open={!!restore}
        onOpenChange={(open) => {
          if (!open && !busy) setRestore(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {zh ? '恢复这份备份？' : 'Restore this backup?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {zh
                ? '将验证备份并创建独立的恢复目录。当前研究数据继续保留，恢复后需要重新开启自动检查。'
                : 'The backup will be verified and restored into a separate directory. Current research data is preserved. Enable automatic checks again when ready.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error && <p role="alert">{ui(error)}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={!!busy}>
              {zh ? '取消' : 'Cancel'}
            </AlertDialogCancel>
            <button
              className="button-primary"
              disabled={!!busy}
              onClick={() => {
                if (restore)
                  void action('restore', async () => {
                    const result = await analysisApi<{
                      directory: string;
                      id: string;
                    }>('data/restore', {
                      method: 'POST',
                      body: { id: restore.id },
                      timeoutMs: 360000,
                    });
                    setRestored(result);
                    setRestore(null);
                  });
              }}
            >
              {busy === 'restore'
                ? zh
                  ? '正在恢复…'
                  : 'Restoring…'
                : zh
                  ? '恢复副本'
                  : 'Restore copy'}
            </button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
