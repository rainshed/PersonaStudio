'use client';
import {
  Radar,
  LayoutGrid,
  FileText,
  SlidersHorizontal,
  FlaskConical,
  Settings2,
} from 'lucide-react';
import {
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarFooter,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  useSidebar,
} from '@/components/ui/sidebar';
import { LanguageSwitcher, useUiLanguage } from './ui-language';
import { StudioSwitcher } from './studio-switcher';
import type { RadarView } from '@/lib/radar-location';

export function ResearchNavigation({
  view,
  onView,
  demo = false,
}: {
  view: RadarView;
  onView: (view: RadarView) => void;
  demo?: boolean;
}) {
  const { ui } = useUiLanguage();
  const { setOpenMobile } = useSidebar();
  const nav = (value: RadarView) => {
    onView(value);
    setOpenMobile(false);
  };
  return (
    <Sidebar className="research-sidebar">
      <SidebarHeader>
        <button
          className="research-brand"
          onClick={() => nav('daily')}
          aria-label={ui('Paper Radar 每日论文')}
        >
          <span className="research-brand-mark">
            <Radar size={21} />
          </span>
          <span className="research-brand-copy">
            <strong>Paper Radar</strong>
            <small>RESEARCH STUDIO</small>
          </span>
        </button>
      </SidebarHeader>
      <SidebarContent>
        <SidebarMenu>
          {(
            [
              ['daily', '每日论文', LayoutGrid],
              ['single', '论文分析', FileText],
              ['subscriptions', '我的订阅', SlidersHorizontal],
              ['evaluations', '评测与反馈', FlaskConical],
              ['models', '设置', Settings2],
            ] as const
          ).map(([id, label, Icon]) => (
            <SidebarMenuItem key={id}>
              <SidebarMenuButton
                className="research-nav-item"
                isActive={view === id}
                onClick={() => nav(id)}
              >
                <Icon size={18} />
                <span>{ui(label)}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarContent>
      <SidebarFooter className="research-nav-footer">
        {!demo && <StudioSwitcher />}
        <LanguageSwitcher segmented />
        <output className="research-footnote">
          {ui(demo ? '演示内容 · 保存在当前浏览器' : '本机数据 · 研究工作台')}
        </output>
      </SidebarFooter>
    </Sidebar>
  );
}
