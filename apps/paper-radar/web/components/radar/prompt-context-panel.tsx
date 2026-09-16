'use client';
import { useEffect, useState } from 'react';
import {
  promptSettingsApi,
  type AgentContext,
  type ContextRun,
  type ContextRunSummary,
} from '@/lib/prompt-settings';
import { useUiLanguage } from './ui-language';

const text = (value: unknown) =>
  typeof value === 'string' ? value : JSON.stringify(value, null, 2);
const stages: Record<string, string> = {
  initial: '启动时',
  during_run: '运行中',
};
const statuses: Record<string, string> = {
  included: '已加入',
  omitted: '未加入',
  conditional: '满足条件后加入',
  prepared: '已准备',
  completed: '已完成',
  failed: '失败',
  interrupted: '已中断',
  legacy: '旧记录',
};
const eventNames: Record<string, string> = {
  host_input: '运行环境已接收输入',
  tool_call: '工具调用',
  tool_result: '工具返回',
  tool_error: '工具或校验反馈',
  additional_message: '追加消息',
  compaction: '上下文压缩',
  restart: '切换备用模型',
  recording_limit: '记录不完整',
};

export function ContextInspector({
  context,
  compact = false,
  historical = false,
  onEdit,
}: {
  context: AgentContext;
  compact?: boolean;
  historical?: boolean;
  onEdit?: (id: string) => void;
}) {
  const { ui } = useUiLanguage();
  const sections = compact
    ? context.sections.filter((s) => s.kind !== 'prompt')
    : context.sections;
  return (
    <section
      className="prompt-context-inspector"
      aria-label={ui('Agent 输入组成')}
    >
      <div className="prompt-context-heading">
        <h3>{ui(compact ? '自动加入的输入' : 'Agent 输入组成')}</h3>
        <span className="prompt-badge">
          {context.runtime.backend === 'unconfigured'
            ? ui('未选择运行环境')
            : context.runtime.backend === 'codex'
              ? 'Codex'
              : 'DSH'}
        </span>
      </div>
      {sections.map((section) => (
        <details
          className="prompt-context-section"
          key={section.id}
          open={
            !compact &&
            section.kind === 'prompt' &&
            section.status !== 'omitted'
          }
        >
          <summary>
            <strong>{ui(section.title)}</strong>
            <small>
              {ui(stages[section.stage] ?? section.stage)} ·{' '}
              {ui(statuses[section.status] ?? section.status)} ·{' '}
              {ui(section.editable && !historical ? '可编辑' : '只读')}
            </small>
          </summary>
          <p className="prompt-context-source">
            {ui('来源：{0}', [ui(section.source.label)])}
            {section.source.version &&
              ` · ${section.source.version.slice(0, 10)}`}
          </p>
          {section.condition && <p>{ui(section.condition)}</p>}
          {section.content !== null && section.content !== '' && (
            <pre>{text(section.content)}</pre>
          )}
          {section.id === 'output' && (
            <p>
              {ui(
                '输出字段与章节结构由程序校验；提示词不能覆盖这些约束。语言、长度和知识范围在任务设置中修改。',
              )}
            </p>
          )}
          {section.editable &&
            !historical &&
            section.source.prompt_id &&
            onEdit && (
              <button
                type="button"
                onClick={() => onEdit(section.source.prompt_id!)}
              >
                {ui('查看并编辑')}
              </button>
            )}
          {section.edit_target && !historical && (
            <p>
              {ui('修改入口：{0}', [
                ui(
                  (
                    {
                      daily: '每日筛选的订阅设置',
                      single: '单篇任务的输入设置',
                      persona: '任务中的个人知识范围选择',
                      discussion: '论文讨论的消息与内容选择',
                    } as Record<string, string>
                  )[section.edit_target] ?? section.edit_target,
                ),
              ])}
            </p>
          )}
        </details>
      ))}
      {!compact && (
        <details className="prompt-raw">
          <summary>{ui('查看实际消息、工具和结果接口')}</summary>
          <h4>{ui('消息')}</h4>
          <pre>{text(context.runtime.messages)}</pre>
          <h4>{ui('工具定义')}</h4>
          <pre>{text(context.request.tools)}</pre>
          {context.runtime.response_schema !== undefined && (
            <>
              <h4>{ui('运行环境的完成回执格式')}</h4>
              <pre>{text(context.runtime.response_schema)}</pre>
            </>
          )}
        </details>
      )}
      <p className="prompt-help">
        {ui(
          '展示 Paper Radar 提供给运行环境的内容；模型服务内部指令与未开放的压缩内容不可获取。',
        )}
      </p>
    </section>
  );
}

export function PromptRunHistory({
  task,
  language,
}: {
  task: string;
  language: string;
}) {
  const { ui } = useUiLanguage();
  const [runs, setRuns] = useState<ContextRunSummary[]>([]);
  const [selected, setSelected] = useState('');
  const [record, setRecord] = useState<ContextRun | null>(null);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    void promptSettingsApi<{ runs: ContextRunSummary[] }>(
      'runs',
      undefined,
      controller.signal,
    )
      .then((value) => {
        setRuns(value.runs);
        setError('');
        setLoading(false);
      })
      .catch((e) => {
        if (!controller.signal.aborted) {
          setError(e.message);
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [refresh]);
  const filtered = runs.filter(
    (r) => r.task === task && r.language === language,
  );
  const active = filtered.some((r) => r.id === selected)
    ? selected
    : (filtered[0]?.id ?? '');
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    void promptSettingsApi<ContextRun>(
      `runs/${encodeURIComponent(active)}`,
      undefined,
      controller.signal,
    )
      .then((value) => {
        setRecord(value);
        setError('');
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [active, refresh]);
  const current = record?.id === active ? record : null;
  const more = async () => {
    if (!current || current.next_after === null) return;
    try {
      const next = await promptSettingsApi<ContextRun>(
        `runs/${encodeURIComponent(current.id)}?after=${current.next_after}`,
      );
      setRecord((previous) =>
        previous?.id === next.id
          ? { ...next, events: [...previous.events, ...next.events] }
          : previous,
      );
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <section className="prompt-run-history" aria-label={ui('运行记录')}>
      <div className="prompt-context-heading">
        <h3>{ui('运行记录')}</h3>
        <button type="button" onClick={() => setRefresh((n) => n + 1)}>
          {ui('刷新记录')}
        </button>
      </div>
      <p>
        {ui(
          '查看当时保存的输入与追加内容；后续提示词修改不会改变历史记录。最近保留 30 次运行输入。',
        )}
      </p>
      {error && (
        <p className="prompt-error" role="alert">
          {ui(error)}
        </p>
      )}
      {loading ? (
        <output>{ui('正在读取运行记录…')}</output>
      ) : !filtered.length ? (
        <p>{ui('当前任务和语言暂无运行记录。新任务执行后会在这里显示。')}</p>
      ) : (
        <label>
          {ui('选择运行记录')}
          <select value={active} onChange={(e) => setSelected(e.target.value)}>
            {filtered.map((r) => (
              <option value={r.id} key={r.id}>
                {r.created_at.slice(0, 16).replace('T', ' ')} ·{' '}
                {r.title ?? ui('未命名任务')} ·{' '}
                {ui(statuses[r.status] ?? r.status)}
                {r.experiment ? ` · ${ui('试跑')}` : ''}
              </option>
            ))}
          </select>
        </label>
      )}
      {active && !current && !error && (
        <output>{ui('正在读取运行输入…')}</output>
      )}
      {current && (
        <>
          {current.status === 'legacy' && (
            <>
              <p className="prompt-notice">
                {ui(
                  '旧记录仅保存了初始提示词；当时的工具定义、运行环境补充和工具返回未记录。',
                )}
              </p>
              <details>
                <summary>{ui('查看当时的初始提示词')}</summary>
                <pre>{text(current.prepared?.rendered)}</pre>
              </details>
            </>
          )}
          {current.context && (
            <details>
              <summary>{ui('启动输入与版本快照')}</summary>
              <ContextInspector context={current.context} historical />
            </details>
          )}
          {current.error && (
            <p className="prompt-error">{ui(current.error.message)}</p>
          )}
          {current.recording_limited && (
            <p className="prompt-notice">
              {ui('记录达到存储上限，部分运行内容未保存。')}
            </p>
          )}
          <ol className="prompt-context-timeline">
            {current.events.map((event) => (
              <li key={event.seq}>
                <details>
                  <summary>
                    <strong>{ui(eventNames[event.kind] ?? event.kind)}</strong>
                    <small>
                      {event.at.slice(11, 19)} · {event.source}
                    </small>
                  </summary>
                  <pre>{text(event.content)}</pre>
                  {event.delivery && (
                    <p>
                      {ui(
                        event.delivery === 'returned_to_host'
                          ? '此内容已返回运行环境；后续是否进入模型请求由运行环境管理。'
                          : event.delivery === 'queued_in_host'
                            ? '此消息已加入运行环境的消息队列。'
                            : '运行环境已接收这些内容。',
                      )}
                    </p>
                  )}
                </details>
              </li>
            ))}
          </ol>
          {current.next_after !== null && (
            <button type="button" onClick={() => void more()}>
              {ui('加载更多记录')}
            </button>
          )}
          {current.context &&
            !current.events.some((e) => e.kind === 'host_input') && (
              <p className="prompt-help">
                {ui('此页已保存应用侧输入；当前运行环境尚未提供接收确认记录。')}
              </p>
            )}
        </>
      )}
    </section>
  );
}
