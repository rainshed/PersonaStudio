'use client';

import type { ReactNode } from 'react';
import { ChevronRight, Info } from 'lucide-react';
import { SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import type { RadarView } from '@/lib/radar-location';
import { ResearchNavigation } from './research-navigation';
import { LanguageSwitcher, useUiLanguage } from './ui-language';
import { TaskNotifications } from './task-notifications';

export function ResearchShell({
  view,
  onView,
  demo = false,
  children,
}: {
  view: RadarView;
  onView: (view: RadarView) => void;
  demo?: boolean;
  children: ReactNode;
}) {
  return (
    <SidebarProvider className="app-shell">
      <ResearchNavigation view={view} onView={onView} demo={demo} />
      {children}
    </SidebarProvider>
  );
}

export function ResearchTopbar({
  view,
  onAbout,
}: {
  view: RadarView;
  onAbout?: () => void;
}) {
  const { ui } = useUiLanguage();
  return (
    <header className="topbar">
      <div className="breadcrumb">
        <SidebarTrigger
          className="mobile-menu"
          aria-label={ui('打开导航菜单')}
        />
        <span>{ui('工作台')}</span>
        <ChevronRight size={14} />
        <strong>
          {ui(
            {
              daily: '每日论文',
              subscriptions: '我的订阅',
              single: '论文分析',
              models: '设置',
              authors: '关注作者',
              evaluations: '评测与反馈',
            }[view],
          )}
        </strong>
      </div>
      <div className="top-actions">
        {!onAbout && <TaskNotifications />}
        <LanguageSwitcher />
        {onAbout ? (
          <button className="top-demo" onClick={onAbout}>
            {ui(view === 'single' ? '分析与数据说明' : '每日论文 · 模拟数据')}{' '}
            <Info size={12} />
          </button>
        ) : (
          <span className="daily-nav-live">{ui('本机服务')}</span>
        )}
        <div className="avatar">PR</div>
      </div>
    </header>
  );
}
