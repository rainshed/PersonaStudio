'use client';
import { useState } from 'react';
import { DataSettings } from './data-settings';
import type { SettingsTab } from '@/lib/radar-location';
import { ModelSettingsPage } from './model-settings';
import { PersonaSettingsPage } from './persona-settings';
import { PromptSettingsPage } from './prompt-settings';
import { useUiLanguage, LanguageSwitcher } from './ui-language';

export function SettingsWorkspace({
  demo = false,
  tab: controlledTab,
  onTab,
}: {
  demo?: boolean;
  tab?: SettingsTab;
  onTab?: (tab: SettingsTab) => void;
}) {
  const { ui } = useUiLanguage();
  const [localTab, setLocalTab] = useState<SettingsTab>('models');
  const tab = controlledTab ?? localTab;
  const setTab = (value: SettingsTab) => {
    setLocalTab(value);
    onTab?.(value);
  };
  return (
    <div className="settings-workspace">
      <div className="page-heading">
        <div>
          <h1>{ui('设置')}</h1>
          <p>{ui('管理模型、提示词、个人知识连接和界面偏好。')}</p>
        </div>
      </div>
      <nav className="research-section-tabs" aria-label={ui('设置分类')}>
        {(
          [
            ['models', '模型'],
            ['persona', 'AI Persona'],
            ['prompts', '提示词'],
            ['data', '数据与偏好'],
          ] as const
        ).map(([id, label]) => (
          <button
            type="button"
            key={id}
            aria-current={tab === id ? 'page' : undefined}
            className={tab === id ? 'active' : ''}
            onClick={() => setTab(id)}
          >
            {ui(label)}
          </button>
        ))}
      </nav>
      <div hidden={tab !== 'models'}>
        <ModelSettingsPage />
      </div>
      <div hidden={tab !== 'persona'}>
        <PersonaSettingsPage demo={demo} visible={tab === 'persona'} />
      </div>
      <div hidden={tab !== 'prompts'}>
        <PromptSettingsPage demo={demo} visible={tab === 'prompts'} />
      </div>
      <div hidden={tab !== 'data'}>
        <section className="research-section">
          <h2>{ui('界面语言')}</h2>
          <div className="settings-language">
            <LanguageSwitcher segmented />
          </div>
          <p>{ui('界面语言即时生效。报告的生成语言由任务设置决定。')}</p>
        </section>
        {!demo && <DataSettings visible={tab === 'data'} />}
        <section className="research-section">
          <h2>{ui('数据保存')}</h2>
          <p>
            {ui(
              demo
                ? '演示订阅与反馈保存在当前浏览器。'
                : '论文、报告和反馈保存在本机服务。界面偏好保存在当前浏览器。',
            )}
          </p>
          <p>{ui('报告删除在对应内容页操作。')}</p>
        </section>
      </div>
    </div>
  );
}
