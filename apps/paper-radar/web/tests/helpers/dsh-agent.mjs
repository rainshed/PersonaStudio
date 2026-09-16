// A deterministic implementation of the public host contract for adapter tests.
// Production integration is separately exercised against the installed DSH.
export function fakeAgents({ onRequest = () => {}, beforeStep = async () => {}, readingSteps = 0 } = {}) {
  const live = new Map();
  return {
    get: (id) => live.get(id),
    async create(options) {
      const listeners = new Map(), tools = new Map(), messages = [];
      let config = options.agentOptions, prompt, work = Promise.resolve(), stopped = false;
      const emit = (name, ...args) => { for (const f of listeners.get(name) ?? []) f(...args); };
      const scope = {
        tools: { register(t) { tools.set(t.name,t); }, restrict() {}, presentAs() {}, guard() {} },
        systemPrompt: { suppressRuntimeContext() {}, section(s) { prompt = s.text; } },
        on(name,fn) { const handlers = listeners.get(name) ?? []; handlers.push(fn); listeners.set(name,handlers); },
      };
      const agent = {
        options: config, session: { id:options.sessionId, deriveMessages:() => messages, requestHeader:() => ({config}) },
        cancel() { stopped = true; }, whenIdle:() => work, steer() {},
        followup(message) {
          messages.push(message);
          work = (async () => {
            try {
              const task = JSON.parse(message.content[0].text); let page = task.persona;
              for (let step=1; step<Math.max(20, readingSteps + 3) && !stopped; step++) {
                await beforeStep({step,sessionId:options.sessionId});
                const batch=step===1?[message]:[];
                for(const fn of listeners.get('agent/pre-step')??[]) {
                  const decision=await fn({agent,step,turn:1,messages:batch,signal:options.signal},async()=>({kind:'enter',messages:batch}));
                  if(step===1&&decision.messages[0]!==message)throw new Error('Pre-step must preserve the pending user message');
                }
                for (const f of listeners.get('agent/request') ?? []) config = await f({agent,step,turn:1,signal:options.signal},async () => config);
                await Promise.resolve(onRequest({...config,messages:[message],system:prompt}));
                const attemptId = `fixture-attempt-${step}`;
                emit('agent/assistant-stream',{agent,frame:{type:'start',attemptId}});
                emit('agent/assistant-stream',{agent,frame:{type:'chunk',chunk:{type:'usage',usage:{inputTokens:20,outputTokens:30}}}});
                emit('agent/assistant-stream',{agent,frame:{type:'chunk',chunk:{type:'finish',reason:{kind:'stop'}}}});
                emit('agent/assistant-stream',{agent,frame:{type:'end'}});
                let name,args;
                if (task.schema === 'paper-radar.autonomous.v1') {
                  if (step <= readingSteps) { name='paper_get_metadata'; args={}; }
                  else if (task.persona_scope && !page) { name=tools.has('search_knowledge')?'search_knowledge':'persona_search'; args={query:''}; }
                  else {
                    name='task_submit_result';
                    const summary={sections:Array.from({length:6},(_,i)=>({title:'章节 '+i,paragraphs:[`第${i+1}节：论文在明确条件下研究测量输运，比较动力学的变化。该结果仅适用于文中模型，尚待进一步验证。`],evidence_ids:[task.paper.source_ref]}))};
                    const ref=page?.data?.hits?.[0]?.citation_ref ?? page?.items?.[0]?.source_ref;
                    const personal={decision:'recommended',reasons:[{text:'论文与所选知识存在方法联系。',paper_evidence_ids:[task.paper.source_ref],persona_evidence_ids:ref?[ref]:[],claims:[]}],connections:[],crossovers:[]};
                    args=config.model==='discussion'?{paragraphs:[{text:'The supplied evidence describes controlled transport.',evidence_ids:[task.paper.source_ref]}],limitations:[],claims:[]}:config.model==='review'?{issues:[]}:config.model==='summary'?summary:config.model==='connections'?personal:{summary,...(task.persona_scope?{personalization:personal}:{})};
                  }
                } else
                if (page.next_offset != null) { name='persona_list_scope'; args={offset:page.next_offset}; }
                else {
                  name='screening_submit_result'; args={schema:task.output.schema,paper_version:task.paper.version,decision:'not_recommended',introduction:'The paper studies controlled transport.',reason:'The scoped knowledge concerns different systems.',criterion_ids:['selected-knowledge'],paper_evidence_ids:[task.paper.source_ref],persona_evidence_ids:[task.persona.records[0].source_ref],persona_coverage_ref:page.source_ref,claims:[],open_questions:[]};
                }
                let complete = false;
                const exec={name,concludeTurn(){complete=true;}};
                const value=await tools.get(name).execute(args,exec);
                messages.push({role:'tool',content:JSON.stringify(value)});
                emit('tools/result',exec,{isError:false});
                if (complete) break;
                page=value;
              }
            } catch (error) { emit('agent/error',{agent,error}); }
          })();
        },
      };
      await options.setup(scope,agent); live.set(options.sessionId,agent);
      return {agent,async dispose(){stopped=true;await work;live.delete(options.sessionId);}};
    },
  };
}
