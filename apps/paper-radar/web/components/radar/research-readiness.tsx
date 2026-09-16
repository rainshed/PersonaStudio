'use client';
import { useEffect, useState } from 'react';
import { analysisApi } from '@/lib/analysis-api';
import { useUiLanguage } from './ui-language';
import type { HostRouterConfig } from './host-model-settings';

export function ResearchReadiness({
  visible,
  onSettings,
}: {
  visible: boolean;
  onSettings: () => void;
}) {
  const { uiLanguage } = useUiLanguage();
  const zh = uiLanguage === 'zh';
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    void analysisApi<HostRouterConfig>('models/config', {
      signal: controller.signal,
    })
      .then((config) => {
        if (!controller.signal.aborted)
          setUnavailable(!config.backends[config.activeBackend]?.connected);
      })
      .catch(() => {
        if (!controller.signal.aborted) setUnavailable(true);
      });
    return () => controller.abort();
  }, [visible]);
  if (!visible || !unavailable) return null;
  return (
    <section
      className="persona-message"
      aria-label={zh ? '开始生成推荐' : 'Start generating recommendations'}
    >
      <strong>
        {zh
          ? '接入分析工具，开始生成论文推荐'
          : 'Connect an analysis tool to generate recommendations'}
      </strong>
      <p>
        {zh
          ? '订阅已保存在本机。选择 Codex 或 DSH 并完成连接后，就可以生成日报与详细报告；关注作者的论文检查无需模型。'
          : 'Your subscription is saved locally. Connect Codex or DSH to generate daily recommendations and detailed reports. Checking followed authors needs no model.'}
      </p>
      <button className="button-primary" onClick={onSettings}>
        {zh ? '设置分析工具' : 'Set up analysis tool'}
      </button>
    </section>
  );
}
