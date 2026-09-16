'use client';
import { useUiLanguage } from '@/components/radar/ui-language';
import { useState } from 'react';
import { Tag, ShieldCheck, Check, Languages } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import {
  AUTHORS,
  SUBJECTS,
  TAGS,
  scopeMaterials,
  validateSubscription,
  type Subscription,
} from '@/lib/radar';
export function SubscriptionEditor({
  initial,
  onClose,
  onSave,
}: {
  initial: Subscription;
  onClose: () => void;
  onSave: (s: Subscription) => void;
}) {
  const { ui, uiLanguage } = useUiLanguage();
  const [draft, setDraft] = useState<Subscription>({
    ...initial,
    tags: [...initial.tags],
    authorIds: [...initial.authorIds],
  });
  const [lengthMin, setLengthMin] = useState(String(initial.summaryLength.min));
  const [lengthMax, setLengthMax] = useState(String(initial.summaryLength.max));
  const [error, setError] = useState('');
  const update = <K extends keyof Subscription>(
    key: K,
    value: Subscription[K],
  ) => setDraft((s) => ({ ...s, [key]: value }));
  const toggle = (key: 'tags' | 'authorIds', id: string) =>
    update(
      key,
      draft[key].includes(id)
        ? draft[key].filter((v) => v !== id)
        : [...draft[key], id],
    );
  function submit(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    const updated = {
      ...draft,
      summaryLength: {
        min: lengthMin.trim() ? Number(lengthMin) : NaN,
        max: lengthMax.trim() ? Number(lengthMax) : NaN,
      },
    };
    const err = validateSubscription(updated);
    if (err) {
      setError(err);
      return;
    }
    onSave({ ...updated, name: draft.name.trim() });
  }
  const materials = scopeMaterials(draft.tags);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="subscription-dialog">
        <DialogHeader>
          <div className="dialog-kicker">YOUR RESEARCH, YOUR SCOPE</div>
          <DialogTitle className="dialog-title">
            {initial.name ? ui('编辑订阅') : ui('新建订阅')}
          </DialogTitle>
          <DialogDescription>
            {ui('定义论文范围，以及用于推荐的 Persona 内容。')}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="subscription-form">
          <div className="field">
            <label htmlFor="subscription-name">{ui('订阅名称')}</label>
            <input
              id="subscription-name"
              autoComplete="off"
              maxLength={50}
              value={draft.name}
              onChange={(e) => update('name', e.target.value)}
              placeholder={ui('例如：量子动力学与输运')}
              required
            />
          </div>
          <div className="field">
            <label id="subject-label" htmlFor="subscription-subject">
              arXiv subject
            </label>
            <Select
              value={draft.subject}
              onValueChange={(v) => {
                if (v) update('subject', String(v));
              }}
            >
              <SelectTrigger
                id="subscription-subject"
                aria-labelledby="subject-label"
                className="form-select"
              >
                <SelectValue>
                  {SUBJECTS.find((s) => s.id === draft.subject)?.zh} ·{' '}
                  {ui(draft.subject)}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {SUBJECTS.map((s) => (
                  <SelectItem value={s.id} key={s.id}>
                    {s.zh} · {s.id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <fieldset className="field">
            <legend>
              {ui('AI Persona 标签')}{' '}
              <span className="field-optional">{ui('可选 · 多选取并集')}</span>
            </legend>
            <div className="tag-picker">
              {TAGS.map((tag) => (
                <label
                  className={
                    'tag-option ' + (draft.tags.includes(tag) ? 'selected' : '')
                  }
                  key={tag}
                >
                  <Checkbox
                    id={'tag-' + tag}
                    checked={draft.tags.includes(tag)}
                    onCheckedChange={() => toggle('tags', tag)}
                    aria-label={ui(tag)}
                  />
                  <Tag size={14} />
                  {ui(tag)}
                </label>
              ))}
            </div>
            <div className="scope-preview">
              <div className="scope-preview-title">
                <ShieldCheck size={15} />
                {ui(
                  draft.tags.length
                    ? ui('仅使用 {0} 份标签内的示例材料', [materials.length])
                    : '通用推荐：不使用 Persona 内容',
                )}
              </div>
              {materials.length > 0 ? (
                <ul>
                  {materials.map((m) => (
                    <li key={m.id}>{m.title[uiLanguage]}</li>
                  ))}
                </ul>
              ) : draft.tags.length > 0 ? (
                <p>
                  {ui(
                    '该标签没有示例材料，匹配结果可能为空。不会改用其他标签。',
                  )}
                </p>
              ) : (
                <p>{ui('依据 subject 展示领域精选，不生成个性化材料联系。')}</p>
              )}
            </div>
          </fieldset>
          <fieldset className="field">
            <legend>
              {ui('关注作者 ')}
              <span className="field-optional">{ui('可选')}</span>
            </legend>
            <div className="author-picker">
              {AUTHORS.map((a) => (
                <label
                  className="author-option"
                  key={a.id}
                  htmlFor={'author-' + a.id}
                >
                  <Checkbox
                    id={'author-' + a.id}
                    checked={draft.authorIds.includes(a.id)}
                    onCheckedChange={() => toggle('authorIds', a.id)}
                    aria-label={a.name}
                  />
                  <span>
                    <strong>{a.name}</strong>
                    <small>{a.field.zh}</small>
                  </span>
                </label>
              ))}
            </div>
            <p className="field-help">
              {ui('作者论文仅在所选 subject 内匹配，单独列在作者动态。')}
            </p>
          </fieldset>
          <div className="field">
            <label id="language-label">
              <Languages size={16} /> {ui(' 内容语言')}
            </label>
            <Select
              value={draft.language}
              onValueChange={(v) => {
                if (v === 'zh' || v === 'en') update('language', v);
              }}
            >
              <SelectTrigger
                aria-labelledby="language-label"
                className="form-select"
              >
                <SelectValue>
                  {ui(draft.language === 'zh' ? '中文' : 'English')}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="zh">{ui('中文')}</SelectItem>
                <SelectItem value="en">English</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <fieldset className="field summary-length-field">
            <legend>
              {ui('研究总结长度 ')}
              <span className="field-optional">{ui('按订阅保存')}</span>
            </legend>
            <p className="summary-length-intro">
              {ui('讲清研究问题、具体方法、关键工作、主要结果与局限。')}
            </p>
            <div className="summary-range-inputs">
              <div>
                <label htmlFor="summary-length-min">{ui('最少')}</label>
                <input
                  id="summary-length-min"
                  type="number"
                  inputMode="numeric"
                  min={200}
                  max={2999}
                  step={1}
                  required
                  value={lengthMin}
                  onChange={(e) => {
                    setLengthMin(e.target.value);
                    setError('');
                  }}
                  aria-describedby="summary-length-help"
                />
                <span>{ui(draft.language === 'zh' ? '字' : '词')}</span>
              </div>
              <span className="range-separator">—</span>
              <div>
                <label htmlFor="summary-length-max">{ui('最多')}</label>
                <input
                  id="summary-length-max"
                  type="number"
                  inputMode="numeric"
                  min={201}
                  max={3000}
                  step={1}
                  required
                  value={lengthMax}
                  onChange={(e) => {
                    setLengthMax(e.target.value);
                    setError('');
                  }}
                  aria-describedby="summary-length-help"
                />
                <span>{ui(draft.language === 'zh' ? '字' : '词')}</span>
              </div>
            </div>
            <fieldset
              className="length-presets"
              aria-label={ui('常用总结字数范围')}
            >
              {[
                [500, 800],
                [800, 1200],
                [1200, 1800],
              ].map(([min, max]) => (
                <button
                  type="button"
                  key={min}
                  aria-pressed={
                    lengthMin === String(min) && lengthMax === String(max)
                  }
                  onClick={() => {
                    setLengthMin(String(min));
                    setLengthMax(String(max));
                    setError('');
                  }}
                >
                  {min}–{max}
                </button>
              ))}
            </fieldset>
            <p id="summary-length-help" className="field-help">
              {ui(
                draft.language === 'zh'
                  ? '中文按正文非空白字符计数（含标点），不含小标题。'
                  : '英文按正文词数计数，不含小标题。',
              )}
              {ui('支持 200–3000 ')}
              {ui(draft.language === 'zh' ? '字' : '词')}
              {ui('。该设置只影响研究总结。')}
            </p>
            <p className="summary-demo-note">
              {ui('当前按范围展示预写示例；AI 按字数生成将在接入后端后实现。')}
            </p>
          </fieldset>
          {error && (
            <p role="alert" className="form-error">
              {ui(error)}
            </p>
          )}
          <div className="form-actions">
            <p>{ui('配置仅保存在当前浏览器')}</p>
            <div>
              <button
                type="button"
                className="button-secondary"
                onClick={onClose}
              >
                {ui('取消')}
              </button>
              <button type="submit" className="button-primary">
                <Check size={16} />
                {ui('保存订阅')}
              </button>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
