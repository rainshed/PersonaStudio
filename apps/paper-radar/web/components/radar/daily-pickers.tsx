'use client';
import { useUiLanguage } from '@/components/radar/ui-language';
import { useState } from 'react';
import { CalendarDays, X } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { enUS, zhCN } from 'date-fns/locale';
import {
  Combobox,
  ComboboxTrigger,
  ComboboxInput,
  ComboboxContent,
  ComboboxList,
  ComboboxItem,
  ComboboxEmpty,
} from '@/components/ui/combobox';
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { announcementToday } from '@/lib/daily-source';

type Subject = { id: string; name: string };
export function SubjectPicker({
  subjects,
  value,
  onChange,
  disabled,
}: {
  subjects: Subject[];
  value: string[];
  onChange: (value: string[]) => void;
  disabled: boolean;
}) {
  const { ui } = useUiLanguage();
  const [open, setOpen] = useState(false);
  const selected = subjects.filter((s) => value.includes(s.id));
  return (
    <div className="daily-subject-field">
      <span id="daily-subject-label">{ui('arXiv subjects（可多选）')}</span>
      <Combobox
        multiple
        open={open}
        onOpenChange={setOpen}
        items={subjects}
        value={selected}
        onValueChange={(items) => onChange(items.map((s) => s.id).sort())}
        itemToStringLabel={(s) => `${s.id} · ${s.name}`}
        itemToStringValue={(s) => s.id}
        isItemEqualToValue={(a, b) => a.id === b.id}
        disabled={disabled}
      >
        <ComboboxTrigger
          aria-labelledby="daily-subject-label"
          className="daily-subject-trigger"
        >
          <span>
            {ui(
              selected.length
                ? ui('已选 {0} 个分类 · 点击添加或移除', [selected.length])
                : subjects.length
                  ? '请选择分类'
                  : '正在读取分类…',
            )}
          </span>
        </ComboboxTrigger>
        <ComboboxContent className="daily-subject-popup">
          <ComboboxInput
            aria-label={ui('搜索 arXiv 分类')}
            placeholder={ui('输入代码或英文名称')}
            showTrigger={false}
          />
          <ComboboxEmpty>
            {ui('没有匹配的分类，请尝试代码或英文名称。')}
          </ComboboxEmpty>
          <ComboboxList>
            {(s: Subject) => (
              <ComboboxItem key={s.id} value={s}>
                <span>
                  <strong>{s.id}</strong>
                  <span className="daily-subject-name">{s.name}</span>
                </span>
              </ComboboxItem>
            )}
          </ComboboxList>
          <div className="daily-subject-done">
            <span>
              {ui('已选 ')}
              {selected.length} {ui(' 个')}
            </span>
            <button
              type="button"
              className="button-secondary"
              onClick={() => setOpen(false)}
            >
              {ui('完成选择')}
            </button>
          </div>
        </ComboboxContent>
      </Combobox>
      <div className="daily-selected-subjects">
        {value.map((id) => (
          <span key={id} title={subjects.find((s) => s.id === id)?.name}>
            {ui(id)}
            <button
              type="button"
              aria-label={ui('移除分类 {0}', [id])}
              disabled={disabled}
              onClick={() => onChange(value.filter((v) => v !== id))}
            >
              <X size={14} />
            </button>
          </span>
        ))}
      </div>
      <small>
        {ui(
          value.length
            ? '分类取并集，同一篇论文只推荐一次。'
            : '请至少选择一个分类。',
        )}
      </small>
    </div>
  );
}

export function ReportDatePicker({
  value,
  currentDate,
  dates,
  availableDates,
  onChange,
}: {
  value: string;
  currentDate?: string;
  dates: string[];
  availableDates: string[];
  onChange: (value: string) => void;
}) {
  const { ui, uiLanguage } = useUiLanguage();
  const [open, setOpen] = useState(false);
  const selected = value || currentDate;
  return (
    <div className="daily-date-field">
      <span id="daily-date-label">{ui('公告日期 · 查看或生成日报')}</span>
      <div className="daily-actions">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger
            className="button-secondary"
            aria-label={ui('选择公告日期：{0}', [
              value || (currentDate ? ui('最新 · {0}', [currentDate]) : ui('最新公告')),
            ])}
          >
            <CalendarDays size={16} />
            {ui(
              value ||
                (currentDate ? ui('最新 · {0}', [currentDate]) : '最新公告'),
            )}
          </PopoverTrigger>
          <PopoverContent className="daily-calendar-popup" align="start">
            <Calendar
              mode="single"
              locale={uiLanguage === 'zh' ? zhCN : enUS}
              selected={selected ? parseISO(selected) : undefined}
              defaultMonth={selected ? parseISO(selected) : undefined}
              disabled={{ after: parseISO(announcementToday()) }}
              onSelect={(day) => {
                if (day) {
                  onChange(format(day, 'yyyy-MM-dd'));
                  setOpen(false);
                }
              }}
              modifiers={{
                saved: dates.map((d) => parseISO(d)),
                available: availableDates.map((d) => parseISO(d)),
              }}
              modifiersClassNames={{
                saved: 'daily-saved-date',
                available: 'daily-available-date',
              }}
            />
            <p className="daily-meta">
              {ui(
                '圆点表示已有日报，下划线表示有完整公告存档。选好日期后，点击“生成所选日期日报”。未存档且已不在官方当前公告中的日期暂不可补查。',
              )}
            </p>
          </PopoverContent>
        </Popover>
        {value && (
          <button className="daily-link" onClick={() => onChange('')}>
            {ui('返回最新')}
          </button>
        )}
      </div>
    </div>
  );
}
