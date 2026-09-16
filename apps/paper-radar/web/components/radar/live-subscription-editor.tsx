'use client';
import { useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { analysisApi, type RealTag } from '@/lib/analysis-api';
import type { DailySubscription, SubscriptionDraft } from '@/lib/daily-api';
import {
  STRICTNESS_OPTIONS,
  type RecommendationStrictness,
} from '@/lib/recommendation-policy';
import { subscriptionSubjects } from '@/lib/subscription-subjects';
import { SubjectPicker } from './daily-pickers';
import { useUiLanguage } from './ui-language';

const defaultDraft: SubscriptionDraft = {
  name: '',
  subjects: ['cond-mat.stat-mech'],
  persona_connection_id: null,
  scope: { tag_ids: [], tag_match: 'any' },
  language: 'zh',
  recommendation_strictness: 'balanced',
  summary_length: { min: 800, max: 1200 },
  status: 'enabled',
  include_updates: false,
  max_model_calls: 200,
};
export function LiveSubscriptionEditor({
  subscription,
  onClose,
  onSaved,
  tags,
  personaId,
  personaError,
  subjects,
  onRefreshTags,
}: {
  subscription: DailySubscription | null | undefined;
  onClose: () => void;
  onSaved: (s: DailySubscription) => void;
  tags: RealTag[];
  personaId: string | null;
  personaError: string;
  subjects: { id: string; name: string }[];
  onRefreshTags: () => void;
}) {
  const { ui, uiLanguage } = useUiLanguage();
  const [draft, setDraft] = useState<SubscriptionDraft>(() =>
    subscription
      ? {
          name: subscription.name,
          subjects: subscriptionSubjects(subscription),
          persona_connection_id: subscription.persona_connection_id,
          scope: subscription.scope,
          language: subscription.language,
          recommendation_strictness:
            subscription.recommendation_strictness ?? 'balanced',
          summary_length: subscription.summary_length,
          status: subscription.status,
          include_updates: subscription.include_updates,
          max_model_calls: subscription.max_model_calls,
        }
      : {
          ...defaultDraft,
          language: uiLanguage,
          subjects: [],
          persona_connection_id: personaId,
        },
  );
  const [saving, setSaving] = useState(false),
    [error, setError] = useState('');
  const update = (patch: Partial<SubscriptionDraft>) =>
    setDraft((d) => ({ ...d, ...patch }));
  async function save() {
    setSaving(true);
    setError('');
    try {
      if (
        !draft.subjects.length ||
        draft.subjects.some((id) => !subjects.some((s) => s.id === id))
      )
        throw new Error('请至少从列表选择一个有效的 arXiv subject。');
      const s = await analysisApi<DailySubscription>(
        'subscriptions' + (subscription ? '/' + subscription.id : ''),
        {
          method: subscription ? 'PATCH' : 'POST',
          body: {
            ...draft,
            persona_connection_id: draft.scope.tag_ids.length
              ? personaId
              : null,
            ...(subscription
              ? { expected_revision: subscription.revision }
              : {}),
          },
        },
      );
      onSaved(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : '订阅未保存。');
    } finally {
      setSaving(false);
    }
  }
  return (
    <Dialog
      open={subscription !== undefined}
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogContent className="daily-editor-dialog">
        <DialogHeader>
          <DialogTitle>
            {ui(subscription ? '编辑订阅' : '新建订阅')}
          </DialogTitle>
          <DialogDescription>
            {ui(
              '选择论文范围，以及用于推荐的知识点标签。保存后可生成日报或配置自动检查。',
            )}
          </DialogDescription>
        </DialogHeader>
        <form
          className="daily-editor"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <label>
            <span>{ui('订阅名称')}</span>
            <input
              required
              maxLength={100}
              value={draft.name}
              onChange={(e) => update({ name: e.target.value })}
              placeholder={ui('例如：量子信息与测量')}
            />
          </label>
          <SubjectPicker
            subjects={subjects}
            value={draft.subjects}
            onChange={(selected) => update({ subjects: selected })}
            disabled={saving || !subjects.length}
          />
          <fieldset>
            <legend>{ui('AI Persona 标签')}</legend>
            {subscription?.persona_reselection_required && (
              <p className="daily-notice">
                {ui('知识库连接已更换，请重新选择标签并启用订阅。')}
              </p>
            )}
            <small>
              {ui(
                '多个标签取并集，以这些标签下的全部知识点判断推荐；相关材料仅作辅助依据。',
              )}
            </small>
            <div className="daily-tags">
              {tags.map((t) => (
                <label key={t.id}>
                  <input
                    type="checkbox"
                    checked={draft.scope.tag_ids.includes(t.id)}
                    onChange={(e) =>
                      update({
                        scope: {
                          tag_match: 'any',
                          tag_ids: e.target.checked
                            ? [...draft.scope.tag_ids, t.id]
                            : draft.scope.tag_ids.filter((id) => id !== t.id),
                        },
                      })
                    }
                  />
                  {t.label}
                </label>
              ))}
            </div>
            {draft.scope.tag_ids.some(
              (id) => !tags.some((t) => t.id === id),
            ) && (
              <p className="daily-notice">
                {ui('保存的标签已失效或尚未加载，请重新选择。')}
              </p>
            )}
            {personaError && (
              <p className="daily-notice">
                {ui(personaError)}
                <button type="button" onClick={onRefreshTags}>
                  {ui('刷新标签')}
                </button>
              </p>
            )}
            {!tags.length && !personaError && (
              <small>{ui('正在获取真实标签…')}</small>
            )}
          </fieldset>
          <fieldset>
            <legend>{ui('推荐严格程度')}</legend>
            <select
              aria-label={ui('推荐严格程度')}
              value={draft.recommendation_strictness}
              onChange={(e) =>
                update({
                  recommendation_strictness: e.target
                    .value as RecommendationStrictness,
                })
              }
            >
              {STRICTNESS_OPTIONS.map((o) => (
                <option key={o.id} value={o.id}>
                  {ui(o.label)}
                </option>
              ))}
            </select>
            <small>
              {ui(
                STRICTNESS_OPTIONS.find(
                  (option) => option.id === draft.recommendation_strictness,
                )?.description,
              )}{' '}
              {ui(
                '调整相关性门槛，不固定每天的数量或比例。保存后用于新一轮筛选；当前日报可显式重新筛选。',
              )}
            </small>
          </fieldset>
          <div className="daily-form-row">
            <label>
              <span>{ui('输出语言')}</span>
              <select
                value={draft.language}
                onChange={(e) =>
                  update({ language: e.target.value as 'zh' | 'en' })
                }
              >
                <option value="zh">{ui('中文叙述 · English 术语')}</option>
                <option value="en">English</option>
              </select>
            </label>
            <label>
              <span>{ui('订阅状态')}</span>
              <select
                value={draft.status}
                onChange={(e) =>
                  update({
                    status: e.target.value as SubscriptionDraft['status'],
                  })
                }
              >
                <option value="enabled">{ui('可运行')}</option>
                <option value="draft">{ui('草稿')}</option>
                <option value="paused">{ui('停用')}</option>
                {subscription && <option value="archived">{ui('归档')}</option>}
              </select>
            </label>
          </div>
          <fieldset>
            <legend>
              {ui('研究总结长度（')}
              {ui(draft.language === 'zh' ? '字' : 'words')}
              {ui('）')}
            </legend>
            <div className="daily-form-row">
              <label>
                <span>{ui('至少')}</span>
                <input
                  type="number"
                  min={200}
                  max={2999}
                  required
                  value={draft.summary_length.min || ''}
                  onChange={(e) =>
                    update({
                      summary_length: {
                        ...draft.summary_length,
                        min: Number(e.target.value),
                      },
                    })
                  }
                />
              </label>
              <label>
                <span>{ui('最多')}</span>
                <input
                  type="number"
                  min={201}
                  max={3000}
                  required
                  value={draft.summary_length.max || ''}
                  onChange={(e) =>
                    update({
                      summary_length: {
                        ...draft.summary_length,
                        max: Number(e.target.value),
                      },
                    })
                  }
                />
              </label>
            </div>
            <small>
              {ui(
                '仅在主动开启详细分析后使用；推荐理由和材料联系不占用总结字数。',
              )}
            </small>
          </fieldset>
          <label className="daily-check">
            <input
              type="checkbox"
              checked={draft.include_updates}
              onChange={(e) => update({ include_updates: e.target.checked })}
            />
            {ui('将更新版本也纳入推荐筛选')}
          </label>
          <small>{ui('默认筛选新作和新跨分类，更新版本单列为动态。')}</small>
          <label>
            <span>{ui('每批最多模型请求次数')}</span>
            <input
              type="number"
              min={1}
              max={2000}
              required
              value={draft.max_model_calls || ''}
              onChange={(e) =>
                update({ max_model_calls: Number(e.target.value) })
              }
            />
            <small>
              {ui(
                '仅用于本批初筛及其重试。全文分析单独计量；达到预算后保留未筛选项，可继续。',
              )}
            </small>
          </label>
          {error && (
            <p className="daily-notice" role="alert">
              {ui(error)}
            </p>
          )}
          <div className="daily-actions">
            <button
              type="submit"
              className="button-primary"
              disabled={
                saving ||
                !draft.subjects.length ||
                draft.subjects.some((id) => !subjects.some((s) => s.id === id))
              }
            >
              {saving ? (
                <LoaderCircle className="single-spin" size={16} />
              ) : null}
              {ui(saving ? '正在保存…' : '保存订阅')}
            </button>
            <button
              type="button"
              className="button-secondary"
              disabled={saving}
              onClick={onClose}
            >
              {ui('取消')}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
