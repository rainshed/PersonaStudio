export type RadarView =
  | 'daily'
  | 'subscriptions'
  | 'single'
  | 'models'
  | 'authors'
  | 'evaluations';
export type SettingsTab = 'models' | 'persona' | 'prompts' | 'data';
export type RadarLocation = {
  view: RadarView;
  subscription: string;
  run: string | null;
  date: string;
  filter: string;
  paper?: string | null;
  section?: 'overview' | 'report';
  expanded?: boolean;
  job?: string | null;
  settingsTab?: SettingsTab;
};
export const defaultLocation: RadarLocation = {
  view: 'daily',
  subscription: '',
  run: null,
  date: '',
  filter: 'recommended',
};
const paths: Record<RadarView, string> = {
  daily: 'daily',
  subscriptions: 'subscriptions',
  single: 'single-analysis',
  models: 'models',
  authors: 'authors',
  evaluations: 'evaluations',
};
export function readRadarLocation(hash: string): RadarLocation {
  const [path, search] = hash.replace(/^#/, '').split('?');
  const params = new URLSearchParams(search);
  const view =
    (Object.keys(paths) as RadarView[]).find((v) => paths[v] === path) ??
    'daily';
  const date = params.get('date') ?? '';
  const filter = params.get('filter') ?? 'recommended';
  return {
    view,
    ...(view === 'models' &&
    ['models', 'persona', 'prompts', 'data'].includes(params.get('tab') ?? '')
      ? { settingsTab: params.get('tab') as SettingsTab }
      : {}),
    ...(params.has('paper') ? { paper: params.get('paper') } : {}),
    ...(params.has('job') ? { job: params.get('job') } : {}),
    ...(params.has('section')
      ? {
          section: (['overview', 'report'].includes(params.get('section')!)
            ? params.get('section')
            : 'overview') as RadarLocation['section'],
        }
      : {}),
    ...(params.has('expanded')
      ? { expanded: params.get('expanded') === '1' }
      : {}),
    subscription: params.get('subscription') ?? '',
    run: params.get('run') || null,
    date:
      /^\d{4}-\d{2}-\d{2}$/.test(date) &&
      !Number.isNaN(Date.parse(date)) &&
      new Date(date).toISOString().slice(0, 10) === date
        ? date
        : '',
    filter: [
      'recommended',
      'followed_authors',
      'not_recommended',
      'unscreened',
      'needs_confirmation',
      'excluded',
      'pending',
    ].includes(filter)
      ? filter
      : 'recommended',
  };
}
export function radarHash(value: RadarLocation) {
  const params = new URLSearchParams();
  if (
    value.view === 'models' &&
    value.settingsTab &&
    value.settingsTab !== 'models'
  )
    params.set('tab', value.settingsTab);
  if (value.paper) params.set('paper', value.paper);
  if (value.job) params.set('job', value.job);
  if (value.section && value.section !== 'overview')
    params.set('section', value.section);
  if (value.expanded) params.set('expanded', '1');
  if (value.subscription) params.set('subscription', value.subscription);
  if (value.run) params.set('run', value.run);
  if (value.date) params.set('date', value.date);
  if (value.filter !== 'recommended') params.set('filter', value.filter);
  return '#' + paths[value.view] + (params.size ? '?' + params : '');
}
