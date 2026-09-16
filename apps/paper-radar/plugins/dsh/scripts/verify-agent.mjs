import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir, homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { bridgeRequest } from '../src/transport.mjs';
import { DshModelService } from '../../../web/server/hosts/dsh/models.mjs';
import { fixture } from '../../../web/tests/helpers/daily-fixture.mjs';
import { DiscussionService } from '../../../web/server/discussions/service.mjs';
import { ArxivReader } from '../../../web/server/analyses/arxiv.mjs';

const runtime = process.argv[2];
if (!runtime) throw new Error('Provide the installed DSH node_modules directory.');
const directory = await mkdtemp(join(tmpdir(),'radar-agent-'));
const socket = join(directory,'host.sock'), overlay=join(directory,'overlay.yml');
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
await writeFile(overlay,`- id: session-persistence-jsonl\n  config:\n    root: ${join(directory,'sessions')}\n- id: storage-json\n  config:\n    root: ${join(directory,'storages')}\n- id: paper-radar\n  disabled: true\n- insert:\n    - id: paper-radar-agent-verification\n      name: ${JSON.stringify(join(root,'src/index.mjs'))}\n      inject: [webServer]\n      config:\n        socketPath: ${socket}\n        paperRadarUrl: http://127.0.0.1:4317\n`);
const child=spawn(process.execPath,[join(runtime,'@deepseek-ai/dsh/lib/bin.js'),'--profile','web','--patch',overlay,'--no-open','--port','0']);
let logs='',exited=false,models;const cleanup=[];
const collect=(chunk)=>{logs=(logs+String(chunk).replace(/https?:\/\/[^\s]+/g,'[URL redacted]').replace(/(token|key|secret)=\S+/gi,'$1=[redacted]')).slice(-16000);};
child.stdout.on('data',collect);child.stderr.on('data',collect);child.on('exit',()=>{exited=true;});
try {
  let ready=false;
  for(let i=0;i<60&&!exited;i++){try{const status=await bridgeRequest(socket,'/status',{}, {timeout:1000});if(status.screeningAgent){ready=true;break;}}catch{}await delay(500);}
  if(!ready)throw new Error(`Isolated DSH did not load the Agent plugin:\n${logs}`);
  models=await new DshModelService({socketPath:socket,directory:join(directory,'prefs')}).open();
  const catalog=(await models.config()).catalog;
  const candidate=catalog.groups.flatMap(g=>g.models).find(m=>m.provider==='openai-codex'&&m.model==='gpt-5.6-luna');
  if(!candidate)throw new Error('The existing Luna route is unavailable for the bounded verification.');
  const routes=structuredClone(models.routes);routes.tasks.screen={model:{provider:candidate.provider,model:candidate.model},reasoningEffort:'low'};await models.routing(routes);
  const savedSample = process.argv.includes('--saved-sample');
  const f=await fixture({after(fn){cleanup.push(fn);}},{count:savedSample?2:1,maxCalls:savedSample?24:6});
  f.daily.models=models;
  const execute = models.runAgent.bind(models);
  models.runAgent = (request,options) => execute(request,{...options,onTool:async(name,args)=>{
    try { return await options.onTool(name,args); }
    catch(e) {
      if(name==='screening_submit_result') console.log(JSON.stringify({rejected_submission:{paper_version:args.paper_version,paper_evidence_ids:args.paper_evidence_ids,persona_evidence_ids:args.persona_evidence_ids,error:e.message}}));
      throw e;
    }
  }});
  if (savedSample) {
    const source = new DatabaseSync(join(homedir(),'.local/share/paper-radar/data/radar.sqlite'),{readOnly:true});
    try {
      const runs = source.prepare('SELECT data FROM daily_runs ORDER BY rowid DESC LIMIT 30').all().map(r=>JSON.parse(r.data)).filter(r=>r.context?.coverage?.complete_knowledge_scan);
      runs.sort((a,b)=>b.context.knowledge_ids.length-a.context.knowledge_ids.length);
      const saved = runs[0]; if (!saved) throw new Error('No complete saved Persona scope is available.');
      const items = source.prepare('SELECT data FROM daily_items WHERE run_id=?').all(saved.id).map(r=>JSON.parse(r.data)).filter(i=>!i.excluded);
      const selected = [items.find(i=>i.final_decision==='recommended')??items[0],items.find(i=>i.final_decision==='not_recommended')??items[1]];
      if (!selected[0] || !selected[1] || selected[0].id===selected[1].id) throw new Error('Two distinct saved papers are required.');
      Object.assign(f.sub,{scope:saved.context.scope,persona_connection_id:saved.context.identity,language:saved.subscription.language,recommendation_strictness:saved.subscription.recommendation_strictness??'balanced'});
      f.repo.saveSubscription(f.sub);
      f.daily.persona.screeningSnapshot=async()=>structuredClone(saved.context);
      f.analyses.arxiv=new ArxivReader(join(directory,'papers'));
      f.revision.papers=selected.map(i=>i.paper);
      f.db.db.prepare('UPDATE arxiv_batch_revisions SET data=? WHERE id=?').run(JSON.stringify(f.revision),f.revision.id);
      console.log(JSON.stringify({sample:'two saved real papers; full saved selected knowledge scope',knowledge_records:saved.context.knowledge_ids.length,context_chars:JSON.stringify(saved.context).length,papers:selected.map(i=>i.paper.id)}));
    } finally { source.close(); }
  } else {
    const original=f.analyses.prompts.version('paper-radar.screen-autonomous');
    const variant=f.analyses.prompts.saveVersion('paper-radar.screen-autonomous',{...original.templates,system:original.templates.system+'\nVerification requirement: before submitting, call persona_read_record with view=screening on the supplied knowledge record. This exercises the real domain tool path.'});
    f.analyses.prompts.activate([{prompt_id:variant.prompt_id,version:variant.id,expected_active:original.id}]);
  }
  const runId=f.create('real-agent-verification').run.id;
  let run;
  for(let i=0;i<720;i++){
    run=f.daily.getRun(runId);
    if(!['running','queued'].includes(run.status))break;
    if(i%15===0)console.log(JSON.stringify({status:run.status,requests:run.actual_attempts}));
    await delay(500);
  }
  const items=f.repo.items(runId).map(i=>f.daily.getItem(i.id));
  if(run.status!=='completed')throw new Error(JSON.stringify({run:run.status,error:run.error,items:items.map(i=>({error:i.error,progress:i.agent_progress})),logs:logs.slice(-6000)}));
  console.log(JSON.stringify({verified:true,mode:savedSample?'real DSH, provider, saved papers and complete saved Persona scope':'real DSH and provider; synthetic paper and scoped knowledge',status:run.status,requests:run.actual_attempts,items:items.map(item=>({paper:item.paper.id,title:item.paper.title,decision:item.final_decision,reason:item.screening.data.reason,model:item.screening.model,coverage:item.screening.reading_coverage,tools:item.agent_progress?.tools}))},null,2));
  if(process.argv.includes('--autonomous')) {
    f.analyses.models=models;
    const autonomousRoutes=structuredClone(models.routes);
    for(const task of ['single','discussion'])autonomousRoutes.tasks[task]={model:{provider:candidate.provider,model:candidate.model},reasoningEffort:'low'};
    await models.routing(autonomousRoutes);
    const input={arxiv_input:'2501.10000v1',persona_connection_id:f.sub.persona_connection_id,scope:f.sub.scope,language:'zh',summary_length:{min:200,max:400}};
    async function finishJob(id){for(let i=0;i<720;i++){const j=f.analyses.getJob(id);if(!['queued','running'].includes(j.status))return j;if(i%30===0)console.log(JSON.stringify({single:j.status,requests:j.actual_attempts,message:j.message}));await delay(500);}throw new Error('Single analysis did not settle');}
    const job=await finishJob(f.analyses.create(input,'verify-autonomous-single').job.id);
    if(job.status!=='succeeded')throw new Error(JSON.stringify({single:job,logs:logs.slice(-4000)}));
    const result=f.analyses.getResult(job.result_id);
    const reuse=await finishJob(f.analyses.create(input,'verify-autonomous-reuse').job.id);
    if(reuse.status!=='succeeded'||reuse.actual_attempts!==0)throw new Error('Result reuse did not avoid model calls');
    const discussion=new DiscussionService(f.analyses,f.daily);cleanup.push(()=>discussion.close());
    const topic=discussion.create({analysis_id:result.id,anchor:{kind:'summary',index:0}}).conversation;
    const turn=discussion.send(topic.id,{question:'这一段有哪些证据支持，又有哪些内容尚未验证？'},'verify-autonomous-discuss').turn;
    for(let i=0;i<600&&['queued','running'].includes(discussion.repo.turn(turn.id).status);i++)await delay(500);
    const answer=discussion.repo.turn(turn.id);
    if(answer.status!=='succeeded')throw new Error(JSON.stringify({discussion:answer.error,logs:logs.slice(-4000)}));
    console.log(JSON.stringify({autonomous_verified:true,single:{status:job.status,requests:job.actual_attempts,summary:result.summary.status,personalization:result.personalization.status,tools:result.agent_context.coverage.tools.map(t=>t.name)},reuse:{requests:reuse.actual_attempts},discussion:{status:answer.status,requests:answer.actual_attempts,tools:answer.coverage.tools.map(t=>t.name)}},null,2));
  }
} catch(e){console.error(e.message);process.exitCode=1;}
finally {
  for(const close of cleanup.reverse())await close();
  await models?.close();child.kill('SIGTERM');
  for(let i=0;i<30&&!exited;i++)await delay(100);
  if(!exited)child.kill('SIGKILL');
  await rm(directory,{recursive:true,force:true});
}
