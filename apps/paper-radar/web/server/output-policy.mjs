// Compatibility exports: the registry is the only source of default policy text.
import { defaultText } from './prompts/store.mjs';
export const OUTPUT_POLICY_VERSION = 'english-terms.v1';
export const terminologyPolicy = defaultText('paper-radar.terminology');
export function strictnessPolicy(level = 'balanced') {
  return defaultText('paper-radar.strictness', ['focused', 'balanced', 'exploratory'].includes(level) ? level : 'balanced');
}
