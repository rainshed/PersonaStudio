'use client';
import { useRequestPolling } from './use-request-polling';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Bell,
  Check,
  CheckCheck,
  CircleAlert,
  ExternalLink,
  X,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { analysisApi } from '@/lib/analysis-api';
import { browserRequestId } from '@/lib/backend-response';
import {
  notificationLabel,
  notificationTitle,
  type NotificationPage,
  type TaskNotification,
} from '@/lib/task-notifications';
import { useUiLanguage } from './ui-language';
import './task-notifications.css';

const deviceKey = 'paper-radar.notifications.device.v1';
const cursorKey = 'paper-radar.notifications.cursor.v1';
const desktopKey = 'paper-radar.notifications.desktop.v1';
const readLocal = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const writeLocal = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* Keep this tab working without storage. */
  }
};
const empty: NotificationPage = {
  items: [],
  unread_count: 0,
  latest_id: 0,
  cursor: 0,
  next_before: null,
};

export function TaskNotifications() {
  const { ui, locale, uiLanguage } = useUiLanguage();
  const [open, setOpen] = useState(false),
    [page, setPage] = useState(empty);
  const [older, setOlder] = useState<TaskNotification[]>([]),
    [before, setBefore] = useState<number | null>(null);
  const [toast, setToast] = useState<TaskNotification[]>([]),
    [error, setError] = useState('');
  const [desktop, setDesktop] = useState(false),
    [permission, setPermission] = useState<
      NotificationPermission | 'unsupported'
    >('unsupported');
  const [busy, setBusy] = useState(false),
    [tick, setTick] = useState(0);
  const cursor = useRef<number | null>(null),
    device = useRef('');
  const current = useRef({ ui, locale, uiLanguage, desktop });
  useEffect(() => {
    current.current = { ui, locale, uiLanguage, desktop };
  }, [ui, locale, uiLanguage, desktop]);
  const refresh = useCallback(() => setTick((v) => v + 1), []);
  const visit = useCallback((item: TaskNotification) => {
    void analysisApi<NotificationPage>('notifications/read', {
      method: 'POST',
      body: { ids: [item.id] },
    })
      .then(setPage)
      .catch(() => setError('无法更新通知，请重试。'));
    setOlder((rows) =>
      rows.map((row) =>
        row.id === item.id
          ? { ...row, read_at: new Date().toISOString() }
          : row,
      ),
    );
    setOpen(false);
    setToast([]);
    window.location.hash = item.href;
  }, []);
  useEffect(() => {
    device.current = readLocal(deviceKey) ?? browserRequestId();
    writeLocal(deviceKey, device.current);
    const saved = readLocal(cursorKey);
    cursor.current =
      saved !== null && /^\d+$/.test(saved) ? Number(saved) : null;
    let active = true;
    void Promise.resolve().then(() => {
      if (!active) return;
      setDesktop(readLocal(desktopKey) === 'true');
      setPermission(
        'Notification' in window && window.isSecureContext
          ? Notification.permission
          : 'unsupported',
      );
    });
    return () => {
      active = false;
    };
  }, []);
  useRequestPolling({
    identity: String(tick),
    intervalMs: 4000,
    run: async (signal) => {
      const request = <T,>(path: string, body?: unknown) =>
        analysisApi<T>(path, {
          ...(body === undefined ? {} : { method: 'POST', body }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
        });
      try {
        const latest = await request<NotificationPage>('notifications');
        if (signal.aborted) return;
        setPage(latest);
        setError('');
        if (cursor.current === null || cursor.current > latest.latest_id) {
          cursor.current = latest.latest_id;
          writeLocal(cursorKey, String(cursor.current));
        }
        const desktopReady =
          current.current.desktop &&
          'Notification' in window &&
          Notification.permission === 'granted';
        if (document.visibilityState === 'visible' || desktopReady) {
          const fresh = await request<NotificationPage>(
            'notifications?after=' + cursor.current + '&limit=100',
          );
          const candidates = fresh.items.filter(
            (item) => !item.read_at && item.status !== 'cancelled',
          );
          const { claimed } = candidates.length
            ? await request<{ claimed: number[] }>('notifications/claim', {
                device_id: device.current,
                ids: candidates.map((item) => item.id),
              })
            : { claimed: [] };
          if (signal.aborted) return;
          const alerts = candidates.filter((item) => claimed.includes(item.id));
          if (alerts.length) {
            setToast(alerts);
            if (desktopReady && document.visibilityState !== 'visible') {
              const item = alerts.at(-1)!,
                copy = current.current.ui;
              const label = notificationLabel(item);
              try {
                const notification = new Notification(
                  alerts.length > 1
                    ? copy('{0} 个任务有新结果', [alerts.length])
                    : copy(label.kind) + ' · ' + copy(label.status),
                  {
                    body: notificationTitle(item, current.current.uiLanguage),
                    tag: 'paper-radar-tasks',
                  },
                );
                notification.onclick = () => {
                  window.focus();
                  visit(item);
                  notification.close();
                };
              } catch {
                /* The persistent inbox remains available on unsupported browsers. */
              }
            }
          }
          cursor.current = fresh.cursor;
          writeLocal(cursorKey, String(fresh.cursor));
        }
      } catch (error) {
        if (!signal.aborted) throw error;
      }
    },
    onError: () => setError('暂时无法读取通知，正在重新连接。'),
  });
  useEffect(() => {
    if (!toast.length || open) return;
    const timer = setTimeout(() => setToast([]), 10000);
    return () => clearTimeout(timer);
  }, [toast, open]);
  async function markAll() {
    setBusy(true);
    try {
      setPage(
        await analysisApi<NotificationPage>('notifications/read', {
          method: 'POST',
          body: { through_id: page.latest_id },
        }),
      );
      setOlder((rows) =>
        rows.map((row) => ({
          ...row,
          read_at: row.read_at ?? new Date().toISOString(),
        })),
      );
      setToast([]);
      setError('');
    } catch {
      setError('无法更新通知，请重试。');
    } finally {
      setBusy(false);
    }
  }
  async function loadOlder() {
    setBusy(true);
    try {
      const result = await analysisApi<NotificationPage>(
        'notifications?before=' + (before ?? page.next_before),
      );
      setOlder((rows) => [...rows, ...result.items]);
      setBefore(result.next_before);
      setError('');
    } catch {
      setError('无法读取更早的通知，请重试。');
    } finally {
      setBusy(false);
    }
  }
  async function toggleDesktop() {
    if (desktop) {
      setDesktop(false);
      writeLocal(desktopKey, 'false');
      return;
    }
    if (!('Notification' in window)) return;
    try {
      const granted = await Notification.requestPermission();
      setPermission(granted);
      setDesktop(granted === 'granted');
      writeLocal(desktopKey, String(granted === 'granted'));
    } catch {
      setError('无法启用桌面提醒，请检查浏览器设置。');
    }
  }
  const rows = [
    ...new Map(
      [...page.items, ...older].map((item) => [item.id, item]),
    ).values(),
  ].sort((a, b) => b.id - a.id);
  const latestToast = toast.at(-1),
    latestLabel = latestToast && notificationLabel(latestToast);
  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          setOpen(value);
          if (value) {
            setOlder([]);
            setBefore(null);
            refresh();
          }
        }}
      >
        <DialogTrigger
          className="task-notification-bell"
          aria-label={ui('任务通知，{0} 条未读', [page.unread_count])}
          title={ui('任务通知')}
        >
          <Bell size={18} />
          {page.unread_count > 0 && (
            <span>{page.unread_count > 99 ? '99+' : page.unread_count}</span>
          )}
        </DialogTrigger>
        <DialogContent className="task-notification-panel">
          <DialogHeader>
            <DialogTitle>{ui('任务通知')}</DialogTitle>
            <DialogDescription>
              {ui('任务完成、部分完成或失败后，通知会保留在这里。')}
            </DialogDescription>
          </DialogHeader>
          <div className="task-notification-toolbar">
            <span>{ui('{0} 条未读', [page.unread_count])}</span>
            <button
              onClick={() => void markAll()}
              disabled={busy || !page.unread_count}
            >
              <CheckCheck size={14} />
              {ui('全部标为已读')}
            </button>
          </div>
          {error && (
            <output className="task-notification-error">
              {ui(error)} <button onClick={refresh}>{ui('重试')}</button>
            </output>
          )}
          <div className="task-notification-list">
            {!rows.length && (
              <div className="task-notification-empty">
                <Bell size={24} />
                <p>{ui('暂无任务通知')}</p>
                <span>{ui('可以先去做其他事，结果会保存在这里。')}</span>
              </div>
            )}
            {rows.map((item) => {
              const label = notificationLabel(item);
              return (
                <button
                  key={item.id}
                  className={
                    'task-notification-item' + (!item.read_at ? ' unread' : '')
                  }
                  onClick={() => visit(item)}
                >
                  <span className={'task-notification-icon ' + item.status}>
                    {['succeeded', 'completed'].includes(item.status) ? (
                      <Check size={17} />
                    ) : (
                      <CircleAlert size={17} />
                    )}
                  </span>
                  <span className="task-notification-copy">
                    <span>
                      <strong>
                        {ui(label.kind)} · {ui(label.status)}
                      </strong>
                      <time dateTime={item.created_at}>
                        {new Date(item.created_at).toLocaleString(locale, {
                          month: 'short',
                          day: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </time>
                    </span>
                    <span className="task-notification-title">
                      {notificationTitle(item, uiLanguage)}
                    </span>
                    <span className="task-notification-view">
                      {ui('查看结果')} <ExternalLink size={12} />
                    </span>
                  </span>
                  {!item.read_at && (
                    <span
                      className="task-notification-dot"
                      aria-label={ui('未读')}
                    />
                  )}
                </button>
              );
            })}
            {(older.length ? before : page.next_before) != null && (
              <button
                className="task-notification-more"
                disabled={busy}
                onClick={() => void loadOlder()}
              >
                {ui('更早的通知')}
              </button>
            )}
          </div>
          <div className="task-notification-desktop">
            {permission === 'unsupported' ? (
              <p>{ui('当前浏览器不支持桌面提醒，通知仍会保存在这里。')}</p>
            ) : permission === 'denied' ? (
              <p>{ui('桌面提醒已被浏览器关闭，可以在浏览器设置中开启。')}</p>
            ) : (
              <button onClick={() => void toggleDesktop()}>
                <Bell size={14} />
                {ui(desktop ? '关闭桌面提醒' : '开启桌面提醒')}
              </button>
            )}
            <p>
              {ui(
                '桌面提醒需要保持页面打开。关闭页面后，可在回来时查看未读通知。',
              )}
            </p>
          </div>
        </DialogContent>
      </Dialog>
      {latestToast && !open && (
        <output className="task-notification-toast">
          <Bell size={19} />
          <span>
            <strong>
              {toast.length > 1
                ? ui('{0} 个任务有新结果', [toast.length])
                : ui(latestLabel!.kind) + ' · ' + ui(latestLabel!.status)}
            </strong>
            <span className="task-toast-title">
              {notificationTitle(latestToast, uiLanguage)}
            </span>
            <button
              onClick={() =>
                toast.length > 1 ? setOpen(true) : visit(latestToast)
              }
            >
              {ui(toast.length > 1 ? '查看通知' : '查看结果')}
            </button>
          </span>
          <button
            className="task-toast-close"
            onClick={() => setToast([])}
            aria-label={ui('关闭')}
          >
            <X size={16} />
          </button>
        </output>
      )}
    </>
  );
}
