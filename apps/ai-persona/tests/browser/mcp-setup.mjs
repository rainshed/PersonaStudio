// Service diagnosis and a separate real stdio read against an isolated workspace.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium, expect} from '@playwright/test';

const directory=dirname(fileURLToPath(import.meta.url)), app=resolve(directory,'../..');
const scratch=await mkdtemp(join(tmpdir(),'persona-mcp-ui-')), python=join(app,'.venv/bin/python');
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('AI_PERSONA_')));
Object.assign(env,{PYTHONPATH:join(app,'src'),PYTHONUNBUFFERED:'1',PYTHONNOUSERSITE:'1',
  AI_PERSONA_CONFIG:join(scratch,'config.toml'),AI_PERSONA_MODEL_DATA_DIR:join(scratch,'models'),
  AI_PERSONA_MODEL_RUNTIME_CACHE_DIR:join(scratch,'runtime'),AI_PERSONA_LEARNING_DIR:join(scratch,'learning'),
  AI_PERSONA_SEMANTIC_SEARCH:'0',CODEX_HOME:join(scratch,'codex')});
const serverCode=`import socket
from pathlib import Path
import uvicorn
from ai_persona.initialization import initialize_persona
from ai_persona.web import create_app
data, state = Path.cwd() / 'persona-data', Path.cwd() / 'persona-state'
initialize_persona(data, state, persona_id='browser-mcp-test')
app = create_app(data, state)
with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
    listener.bind(('127.0.0.1', 0))
    port = listener.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app, host='127.0.0.1', port=port,
                                         proxy_headers=False, log_level='warning'))
    print(f'READY http://127.0.0.1:{port}', flush=True)
    server.run(sockets=[listener])
`;
const server=spawn(python,['-c',serverCode],{cwd:scratch,env,stdio:['ignore','pipe','pipe']});
let log='',browser;const errors=[];
server.stdout.on('data',v=>log+=v);server.stderr.on('data',v=>log+=v);
try {
  await expect.poll(()=>log.match(/READY (http:\/\/127\.0\.0\.1:\d+)/)?.[1],{timeout:30000}).toBeTruthy();
  const url=log.match(/READY (http:\/\/127\.0\.0\.1:\d+)/)[1];
  browser=await chromium.launch({headless:true});
  const context=await browser.newContext({locale:'zh-CN',viewport:{width:1280,height:1000}});
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.goto(url+'/settings?tab=sources#mcp-setup');
  await page.locator('#mcp-manual > summary').click();
  const panel=page.locator('[data-mcp-setup]');
  await expect(panel).toContainText('服务尚未自检');
  await panel.getByRole('button',{name:'运行服务自检',exact:true}).click();
  await expect(panel).toContainText('服务自检通过',{timeout:20000});
  assert.equal((await (await page.request.get(url+'/api/studio/mcp-setup')).json()).client_read,null);
  await panel.getByRole('button',{name:'生成查询测试消息',exact:true}).click();
  await expect(panel.locator('textarea')).toHaveValue(/get_knowledge_map/);
  const state=await (await page.request.get(url+'/api/studio/mcp-setup')).json();
  const code=`import asyncio, json, os, sys, tomllib
from mcp import Client, StdioServerParameters
settings=tomllib.loads(json.load(sys.stdin)['config'])['mcp_servers']['ai_persona']
settings.pop('enabled_tools')
client_env={**os.environ, **settings.pop('env', {})}
async def run():
    async with Client(StdioServerParameters(**settings, env=client_env)) as client:
        tools=await client.list_tools()
        assert len(tools.tools)==6
        result=await client.call_tool('get_knowledge_map', {'scope': {'tag_ids': []}, 'max_chars': 1000})
        assert not result.is_error and result.structured_content['data']['nodes']==[]
asyncio.run(run())
`;
  const client=spawn(python,['-c',code],{cwd:scratch,env,stdio:['pipe','ignore','pipe']});
  let clientErrors='';client.stderr.on('data',v=>clientErrors+=v);client.stdin.end(JSON.stringify(state));
  const exit=await new Promise((resolve,reject)=>{client.on('error',reject);client.on('exit',resolve);});
  assert.equal(exit,0,clientErrors);
  await panel.getByRole('button',{name:'刷新查询记录',exact:true}).click();
  await expect(panel).toContainText('已收到成功查询');
  const observed=await (await page.request.get(url+'/api/studio/mcp-setup')).json();
  assert.equal(observed.client_read.tool,'get_knowledge_map');
  assert.equal(observed.service_check.ok,true);
  const output=resolve(app,'../../browser-results');await mkdir(output,{recursive:true});
  await panel.screenshot({path:join(output,'mcp-setup-readonly.png')});
  await context.addCookies([{name:'ai_persona_locale',value:'en',url}]);
  await page.reload();await page.locator('#mcp-manual > summary').click();await expect(panel).toContainText('Successful read observed');
  await expect(panel).toContainText('Service self-check passed');
  assert.deepEqual(errors,[]);
  console.log('MCP setup: six tools, isolated self-check, empty-scope client read, and bilingual status passed');
} finally {
  if(browser)await browser.close();
  if(server.exitCode===null){const stopped=new Promise(resolve=>server.once('exit',resolve));server.kill('SIGTERM');await stopped;}
  await rm(scratch,{recursive:true,force:true});
}
