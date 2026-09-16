import { isDeepStrictEqual } from 'node:util';
import { ResearchTools } from '../agents/research-tools.mjs';
import { autonomousInput } from '../agents/task-input.mjs';
import { storeScreeningInput } from './repository.mjs';
import { AnalysisError } from '../analyses/contracts.mjs';

// Capture source material, never the generated report, notes or human answer.
export function captureAnalysisInput(service, job, reader) {
  const variables = {
    task: JSON.stringify(
      autonomousInput({
        task: 'single',
        reader,
        snapshot: job.prompt_snapshot,
      }),
    ),
  };
  const task = JSON.parse(variables.task);
  task.available_results = {
    report: false,
    history_messages: 0,
    notes_total: 0,
    notes: [],
    source_ref: 'paper-radar:task-context',
  };
  variables.task = JSON.stringify(task);
  return storeScreeningInput(service.db.db, {
    schema: 'paper-radar.screening-input/v1',
    workflow: 'analysis-recommendation/v1',
    item: { id: job.id, paper: reader.paper },
    subscription: reader.input,
    context: reader.persona,
    variables,
    prompt: { prompt_id: 'paper-radar.task-single' },
    full_paper: reader.full,
    persona_responses: reader.feedbackReplayResponses,
    query_mode: !!service.persona.scopeReader,
  });
}

export async function analysisReplayReader(input, signal, onUnavailable) {
  const unavailable = () => {
    onUnavailable();
    throw new AnalysisError(
      'input_unavailable',
      '本次测试需要原分析未保存的材料。',
    );
  };
  const reader = await new ResearchTools({
    analyses: { arxiv: { get: unavailable }, persona: {} },
    input: structuredClone(input.subscription),
    paper: structuredClone(input.full_paper ?? input.item.paper),
    persona: structuredClone(input.context),
    signal,
  }).prepare();
  const liveCall = reader.call.bind(reader);
  reader.call = async (name, args) => {
    if (
      name.startsWith('persona') ||
      input.persona_responses?.some((r) => r.name === name)
    ) {
      const response = input.persona_responses?.find(
        (r) => r.name === name && isDeepStrictEqual(r.args, args),
      );
      if (!response) return unavailable();
      reader.persona = structuredClone(response.persona);
      for (const e of response.evidence) {
        reader.delivered.set(e.id, structuredClone(e));
        reader.known.set(e.id, structuredClone(e));
      }
      return structuredClone(response.value);
    }
    return liveCall(name, args);
  };
  // The tool contract is the one used by the original analysis.
  if (input.query_mode) reader.analyses.persona.scopeReader = unavailable;
  return reader;
}
