'use client';

import { useEffect, useState } from 'react';
import { ArrowRight, Check, Radar, RefreshCw } from 'lucide-react';
import { analysisApi } from '@/lib/analysis-api';
import { defaultLocation, radarHash } from '@/lib/radar-location';
import { StudioSwitcher } from './studio-switcher';
import { PersonaSettingsPage } from './persona-settings';
import { LiveSubscriptionEditor } from './live-subscription-editor';
import { usePersonaTags } from './use-persona-tags';
import { LanguageSwitcher, useUiLanguage } from './ui-language';
import './first-use.css';

export function FirstUse({ onFinished }: { onFinished: () => void }) {
  const { uiLanguage, ui } = useUiLanguage();
  const zh = uiLanguage === 'zh';
  const [connected, setConnected] = useState(false);
  const [editingConnection, setEditingConnection] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [subjects, setSubjects] = useState<{ id: string; name: string }[]>([]);
  const [error, setError] = useState('');
  const { tags, personaId, personaError } = usePersonaTags(refresh);
  const step = connected && !editingConnection ? 2 : 1;

  useEffect(() => {
    const controller = new AbortController();
    void analysisApi<{ connected: boolean }>('persona/status', {
      signal: controller.signal,
    })
      .then((result) => {
        if (!controller.signal.aborted) setConnected(result.connected);
      })
      .catch(() => {});
    void analysisApi<{ subjects: { id: string; name: string }[] }>(
      'arxiv/subjects',
      { signal: controller.signal },
    )
      .then((result) => {
        if (!controller.signal.aborted) {
          setSubjects(result.subjects);
          setError('');
        }
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => controller.abort();
  }, [refresh]);

  return (
    <main className="radar-first-use">
      <header className="first-use-header">
        <span className="first-use-brand">
          <Radar aria-hidden="true" size={24} /> Paper Radar{' '}
          <small>PersonaStudio</small>
        </span>
        <LanguageSwitcher segmented />
      </header>
      <section className="first-use-content" aria-labelledby="first-use-title">
        <h1 id="first-use-title">
          {zh ? '从你的研究兴趣开始' : 'Start with your research interests'}
        </h1>
        <p className="first-use-intro">
          {zh
            ? '连接 AI Persona，选择你关心的知识范围，再创建第一份论文订阅。'
            : 'Connect AI Persona, choose your knowledge scope, and create your first paper subscription.'}
        </p>
        <ol
          className="first-use-steps"
          aria-label={zh ? '首次设置进度' : 'Setup progress'}
        >
          <li aria-current={step === 1 ? 'step' : undefined}>
            <span>{connected ? <Check size={16} /> : '1'}</span>
            {zh ? '接入 AI Persona' : 'Connect AI Persona'}
          </li>
          <li aria-current={step === 2 ? 'step' : undefined}>
            <span>2</span>
            {zh ? '创建订阅' : 'Create a subscription'}
          </li>
        </ol>
        {step === 1 ? (
          <>
            <p>
              {zh
                ? '已有 Persona 时，确认下面的连接信息；还没有时，先打开 AI Persona 创建知识库，再回到这里继续。'
                : 'If you already have a Persona, confirm the connection below. Otherwise, open AI Persona to create one, then return here.'}
            </p>
            <StudioSwitcher />
            <PersonaSettingsPage
              onConnected={() => {
                setConnected(true);
                setEditingConnection(false);
                setRefresh((value) => value + 1);
              }}
            />
            {connected && (
              <button
                className="button-primary"
                onClick={() => setEditingConnection(false)}
              >
                {zh ? '继续创建订阅' : 'Continue to subscription'}{' '}
                <ArrowRight size={16} />
              </button>
            )}
          </>
        ) : (
          <section className="research-section first-subscription">
            <div className="first-use-connected">
              <Check size={18} />
              <strong>
                {zh ? 'AI Persona 已连接' : 'AI Persona connected'}
              </strong>
              <button
                className="button-secondary"
                onClick={() => setEditingConnection(true)}
              >
                {zh ? '修改连接' : 'Edit connection'}
              </button>
            </div>
            <h2>
              {zh
                ? '创建第一份论文订阅'
                : 'Create your first paper subscription'}
            </h2>
            <p>
              {zh
                ? '选择 arXiv 学科分类和 Persona 知识标签，保存你的研究方向。随后可检查论文，并设置 Codex 或 DSH 来生成推荐。'
                : 'Choose arXiv subjects and Persona knowledge tags. You can then check papers and connect Codex or DSH to generate recommendations.'}
            </p>
            {personaId && tags.length === 0 && (
              <p className="persona-message">
                {zh
                  ? '当前 Persona 还没有知识标签。可以先保存订阅，添加知识后再选择标签。'
                  : 'This Persona has no knowledge tags yet. Save a subscription now, then select tags after adding knowledge.'}
              </p>
            )}
            {(error || personaError) && (
              <p className="persona-message error" role="alert">
                {ui(error || personaError)}{' '}
                <button
                  className="button-secondary"
                  onClick={() => setRefresh((value) => value + 1)}
                >
                  <RefreshCw size={14} />
                  {zh ? '重新读取' : 'Reload'}
                </button>
              </p>
            )}
            <button
              className="button-primary"
              disabled={!subjects.length || !personaId}
              onClick={() => setEditorOpen(true)}
            >
              {zh ? '创建订阅' : 'Create subscription'} <ArrowRight size={16} />
            </button>
            {(!subjects.length || !personaId) && !error && !personaError && (
              <output>
                {zh
                  ? '正在读取学科分类与知识标签…'
                  : 'Loading subjects and knowledge tags…'}
              </output>
            )}
          </section>
        )}
      </section>
      {editorOpen && (
        <LiveSubscriptionEditor
          subscription={null}
          tags={tags}
          personaId={personaId}
          personaError={personaError}
          subjects={subjects}
          onRefreshTags={() => setRefresh((value) => value + 1)}
          onClose={() => setEditorOpen(false)}
          onSaved={(subscription) => {
            window.location.hash = radarHash({
              ...defaultLocation,
              subscription: subscription.id,
            });
            onFinished();
          }}
        />
      )}
    </main>
  );
}
