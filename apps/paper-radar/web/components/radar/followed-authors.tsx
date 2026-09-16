'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, LoaderCircle, Plus, RefreshCw, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import { analysisApi } from '@/lib/analysis-api';
import { academicName } from '@/lib/academic-text';
import { authorNameKey, cleanAuthorName } from '@/lib/author-following';
import type { DailySubscription, FollowedAuthorFeed } from '@/lib/daily-api';
import { subjectLabel } from '@/lib/subscription-subjects';
import { useRequestPolling } from './use-request-polling';
import { useUiLanguage } from './ui-language';
import './followed-authors.css';

export function FollowedAuthors({
  subscription,
  subscriptions,
  onSelect,
  onSaved,
  onReload,
  onSubscriptions,
}: {
  subscription?: DailySubscription;
  subscriptions: DailySubscription[];
  onSelect: (id: string) => void;
  onSaved: (subscription: DailySubscription) => void;
  onReload: () => void;
  onSubscriptions: () => void;
}) {
  const { ui } = useUiLanguage();
  const nameInput = useRef<HTMLInputElement>(null);
  const subscriptionId = subscription?.id;
  useEffect(() => {
    if (subscriptionId) nameInput.current?.focus();
  }, [subscriptionId]);
  const [name, setName] = useState('');
  const [author, setAuthor] = useState('');
  const [offset, setOffset] = useState(0);
  const [feed, setFeed] = useState<FollowedAuthorFeed | null>(null);
  const [feedKey, setFeedKey] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState<'save' | 'refresh' | null>(null);
  const [tick, setTick] = useState(0);
  const [checkSources, setCheckSources] = useState<
    FollowedAuthorFeed['sources'] | null
  >(null);
  const [checkScope, setCheckScope] = useState('');
  const action = useRef<AbortController | null>(null);
  useEffect(() => () => action.current?.abort(), []);
  const names = subscription?.followed_authors ?? [];
  const identity = JSON.stringify([
    subscription?.id,
    subscription?.revision,
    author,
    offset,
    tick,
  ]);
  const endpoint = subscription
    ? `subscriptions/${encodeURIComponent(subscription.id)}/author-papers?limit=25&offset=${offset}&author=${encodeURIComponent(author)}`
    : '';
  useRequestPolling({
    identity,
    enabled: !!subscription && !busy,
    intervalMs: 30000,
    run: async (signal) => {
      const value = await analysisApi<FollowedAuthorFeed>(endpoint, { signal });
      if (signal.aborted) return;
      setFeed(value);
      setFeedKey(identity);
    },
    onError: (failure) =>
      setError(
        failure instanceof Error ? failure.message : ui('无法读取作者论文。'),
      ),
  });

  async function save(next: string[]) {
    if (!subscription || action.current) return;
    const controller = new AbortController();
    action.current = controller;
    setBusy('save');
    setError('');
    setNotice('');
    try {
      const saved = await analysisApi<DailySubscription>(
        `subscriptions/${encodeURIComponent(subscription.id)}/followed-authors`,
        {
          method: 'PUT',
          signal: controller.signal,
          body: {
            expected_revision: subscription.revision,
            followed_authors: next,
          },
        },
      );
      if (controller.signal.aborted) return;
      onSaved(saved);
      setName('');
      setOffset(0);
      if (!next.some((n) => authorNameKey(n) === authorNameKey(author)))
        setAuthor('');
      setNotice(ui('作者名单已保存。'));
    } catch (failure) {
      if (!controller.signal.aborted)
        setError(
          failure instanceof Error ? failure.message : ui('作者名单未保存。'),
        );
    } finally {
      if (!controller.signal.aborted) setBusy(null);
      action.current = null;
    }
  }
  async function refresh() {
    if (!subscription || action.current) return;
    const controller = new AbortController();
    action.current = controller;
    setBusy('refresh');
    setError('');
    setNotice('');
    try {
      const value = await analysisApi<FollowedAuthorFeed>(endpoint, {
        method: 'POST',
        body: {},
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setFeed(value);
      setFeedKey(identity);
      setCheckSources(value.sources);
      setCheckScope(subjectLabel(subscription));
      setNotice(
        ui(
          value.sources.some((s) => s.completeness !== 'complete')
            ? '部分分类暂未完整读取，已保留可用论文。'
            : '已读取所选分类的最新公告。',
        ),
      );
    } catch (failure) {
      if (!controller.signal.aborted)
        setError(
          failure instanceof Error ? failure.message : ui('无法读取作者论文。'),
        );
    } finally {
      if (!controller.signal.aborted) setBusy(null);
      action.current = null;
    }
  }
  const loading = !!subscription && feedKey !== identity;
  const sources = loading
    ? []
    : ((checkScope === subjectLabel(subscription ?? {})
        ? checkSources
        : null) ??
      feed?.sources ??
      []);
  return (
    <section className="followed-authors">
      <div className="page-heading">
        <div>
          <h1>{ui('关注作者')}</h1>
          <p>
            {ui(
              '姓名匹配，且论文属于当前订阅所选的任一 subject，即收入此列表。',
            )}
          </p>
        </div>
        <Button variant="outline" onClick={onSubscriptions}>
          {ui('管理论文订阅')}
        </Button>
      </div>
      {!subscription ? (
        <div className="daily-empty">
          <h2>{ui('先创建一个论文订阅')}</h2>
          <p>{ui('选择 subject 后，即可在该订阅中添加关注作者。')}</p>
          <Button onClick={onSubscriptions}>{ui('管理论文订阅')}</Button>
        </div>
      ) : (
        <>
          <div className="followed-author-scope">
            <label>
              <span>{ui('当前订阅')}</span>
              <NativeSelect
                value={subscription.id}
                disabled={!!busy}
                onChange={(event) => onSelect(event.target.value)}
              >
                {subscriptions
                  .filter(
                    (s) => s.status !== 'archived' || s.id === subscription.id,
                  )
                  .map((s) => (
                    <NativeSelectOption key={s.id} value={s.id}>
                      {s.name}
                    </NativeSelectOption>
                  ))}
              </NativeSelect>
            </label>
            <p>{subjectLabel(subscription)}</p>
          </div>
          <div className="followed-author-settings">
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const value = cleanAuthorName(name);
                if (
                  names.some((n) => authorNameKey(n) === authorNameKey(value))
                ) {
                  setNotice(ui('已经关注这个姓名。'));
                  return;
                }
                if (value) void save([...names, value]);
              }}
            >
              <label htmlFor="followed-author-name">{ui('添加作者姓名')}</label>
              <div className="followed-author-add">
              <Input
                ref={nameInput}
                id="followed-author-name"
                  required
                  maxLength={150}
                  value={name}
                  placeholder={ui('输入论文中的完整作者姓名')}
                  disabled={!!busy || names.length >= 200}
                  onChange={(event) => setName(event.target.value)}
                />
                <Button
                  type="submit"
                  disabled={!!busy || !name.trim() || names.length >= 200}
                >
                  {busy === 'save' ? (
                    <LoaderCircle className="single-spin" />
                  ) : (
                    <Plus />
                  )}
                  {ui('关注作者')}
                </Button>
              </div>
            </form>
            <p className="followed-author-hint">
              {ui('完整姓名匹配，忽略大小写和多余空格；缩写与全名分别添加。')}
            </p>
            <div
              className="followed-author-names"
              aria-label={ui('已关注的作者姓名')}
            >
              {names.map((n) => (
                <span key={authorNameKey(n)}>
                  {n}
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled={!!busy}
                    aria-label={ui('取消关注 {0}', [n])}
                    onClick={() =>
                      void save(names.filter((value) => value !== n))
                    }
                  >
                    <X />
                  </Button>
                </span>
              ))}
              {!names.length && (
                <p>{ui('还没有关注作者，添加后会匹配已读取的论文。')}</p>
              )}
            </div>
          </div>
          {error && (
            <div className="daily-notice" role="alert">
              {ui(error)}
              <Button
                variant="ghost"
                onClick={() => {
                  setError('');
                  onReload();
                  setTick((v) => v + 1);
                }}
              >
                {ui('重试')}
              </Button>
            </div>
          )}
          {notice && (
          <output className="daily-success">
            {ui(notice)}
          </output>
          )}
          <div className="followed-author-toolbar">
            <h2>
              {ui('作者论文')} <span>{loading ? '…' : (feed?.total ?? 0)}</span>
            </h2>
            <label>
              <span className="sr-only">{ui('筛选关注作者')}</span>
              <NativeSelect
                value={author}
                disabled={!!busy}
                onChange={(event) => {
                  setAuthor(event.target.value);
                  setOffset(0);
                }}
              >
                <NativeSelectOption value="">
                  {ui('全部关注作者')}
                </NativeSelectOption>
                {names.map((n) => (
                  <NativeSelectOption key={n} value={n}>
                    {n}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </label>
            <Button
              variant="outline"
              onClick={() => void refresh()}
              disabled={!!busy || !names.length}
            >
              {busy === 'refresh' ? (
                <LoaderCircle className="single-spin" />
              ) : (
                <RefreshCw />
              )}
              {ui(busy === 'refresh' ? '正在检查最新公告…' : '检查最新论文')}
            </Button>
          </div>
          <p className="followed-author-hint">
            {ui('显示已读取公告中的匹配论文，不受 Persona 推荐结果影响。')}
          </p>
          {!!sources.length && (
            <details className="followed-author-sources">
              <summary>
                {ui(
                  sources.some((s) => s.completeness !== 'complete')
                    ? '来源尚未完整读取'
                    : '查看来源日期',
                )}
              </summary>
              <ul>
                {sources.map((source) => (
                  <li key={source.subject}>
                    <strong>{source.subject}</strong> ·{' '}
                    {source.date ?? ui('尚未读取')}
                    {source.completeness === 'failed' && (
                      <> · {ui('本次读取失败')}</>
                    )}
                    {source.issues.map((issue) => (
                      <p key={issue}>{ui(issue)}</p>
                    ))}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {loading ? (
          <output>{ui('正在读取作者论文…')}</output>
          ) : !feed?.papers.length ? (
            <div className="daily-empty">
              <h3>{ui('暂未找到匹配的作者论文')}</h3>
              <p>
                {ui(
                  '检查关注姓名和所选 subject，或点击“检查最新论文”读取当前公告。',
                )}
              </p>
            </div>
          ) : (
            <div className="followed-author-papers">
              {feed.papers.map((paper) => (
                <article key={paper.id}>
                  <div className="followed-author-paper-meta">
                    <time dateTime={paper.date}>{paper.date}</time>
                    <span>{paper.matched_subjects.join(' · ')}</span>
                    <span>
                      arXiv:{paper.id}v{paper.version}
                    </span>
                  </div>
                  <h3>
                    <a href={paper.url} target="_blank" rel="noreferrer">
                      {paper.title}
                      <ArrowUpRight size={17} />
                    </a>
                  </h3>
                  <p>{paper.authors.map(academicName).join(' · ')}</p>
                  <p className="followed-author-match">
                    {ui('匹配关注姓名：')}
                    {paper.matched_authors.join(' · ')}
                  </p>
                  <details>
                    <summary>{ui('查看摘要')}</summary>
                    <p className="followed-author-abstract">{paper.abstract}</p>
                  </details>
                </article>
              ))}
            </div>
          )}
          {((feed?.total ?? 0) > 25 || offset > 0) && (
            <div className="followed-author-pagination">
              <Button
                variant="outline"
                disabled={!!busy || loading || offset === 0}
                onClick={() => setOffset(Math.max(0, offset - 25))}
              >
                {ui('上一页')}
              </Button>
              <Button
                variant="outline"
                disabled={!!busy || loading || feed?.next_offset == null}
                onClick={() => setOffset(feed?.next_offset ?? offset)}
              >
                {ui('下一页')}
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
