import { PERSONA_QUERY_TOOLS } from './persona-tools.mjs';
// Shared wire contract. No credentials, business callbacks or other papers enter the prompt.
export const AGENT_SCREEN_VERSION = 'screening.autonomous.v1';
export const SCREEN_AGENT_PROMPT = 'paper-radar.screen-autonomous';
export const SCREEN_READING_VERSION = 'autonomous-tools.v2';
const string = { type: 'string' };
const strings = { type: 'array', items: string };
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
export const SCREEN_RESULT_SCHEMA = object({
  schema: { type: 'string', enum: [AGENT_SCREEN_VERSION] },
  paper_version: string,
  decision: { type: 'string', enum: ['recommended', 'not_recommended', 'needs_review'] },
  introduction: string, reason: string, criterion_ids: strings,
  paper_evidence_ids: strings, persona_evidence_ids: strings,
  persona_coverage_ref: string,
  claims: { type: 'array', items: object({ record_id: string, field: { type: 'string', enum: ['interest_level', 'knowledge_level', 'preference_level', 'user_relationships'] }, value: string }) },
  open_questions: strings,
});
const offset = { type: 'integer', minimum: 0 };
export const LEGACY_SCREEN_TOOLS = [
  { name: 'paper_get_metadata', description: 'Read the fixed paper metadata and abstract, with source IDs.', parameters: object({}) },
  { name: 'paper_get_outline', description: 'Read a bounded page of the fixed paper outline.', parameters: object({ offset }, []) },
  { name: 'paper_read_section', description: 'Read a bounded slice of a section; next_offset identifies remaining content.', parameters: object({ section_id: string, offset }, ['section_id']) },
  { name: 'persona_list_scope', description: 'List records in the selected scope; next_offset identifies the next page. detail_required means this card contains partial fields.', parameters: object({ offset }, []) },
  { name: 'persona_read_record', description: 'Read a bounded slice of an allowed record. screening returns record fields, body returns original notes.', parameters: object({ record_id: string, view: { type: 'string', enum: ['screening', 'body'] }, offset }, ['record_id', 'view']) },
  { name: 'screening_submit_result', description: 'Submit the judgment with source IDs and the supplied coverage_ref. Returns saved status or field errors.', parameters: SCREEN_RESULT_SCHEMA },
];
export const SCREEN_TOOLS = [...LEGACY_SCREEN_TOOLS.filter(t => !t.name.startsWith('persona_') && t.name !== 'screening_submit_result'), ...PERSONA_QUERY_TOOLS, LEGACY_SCREEN_TOOLS.at(-1)];
