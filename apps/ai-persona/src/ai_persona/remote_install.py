"""Install an explicitly requested remote Codex connection without copying Persona data."""

from __future__ import annotations

import json
import re
import secrets
import subprocess
from pathlib import Path

from .conversation_learning.contracts import SourceConnection
from .conversation_learning.repository import LearningRepository
from .preference_application.repository import ApplicationRepository
from .remote_gateway import private_json


def write_private(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(path.name + ".tmp")
    with temporary.open("w") as stream:
        temporary.chmod(0o600)
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
    temporary.replace(path)


REMOTE_INSTALL = r'''
import json,os,re,shlex,socket,time,tomllib
from pathlib import Path
payload=PAYLOAD
home=Path.home()
hostname=socket.gethostname()
codex=Path(os.environ.get('CODEX_HOME') or home/'.codex').expanduser()
if not codex.is_absolute(): raise ValueError('CODEX_HOME must be absolute')
codex.mkdir(parents=True,exist_ok=True,mode=0o700)
if codex.stat().st_uid!=os.getuid(): raise ValueError('CODEX_HOME belongs to another user')
root=home/'.config/ai-persona/remote'/payload['name']
root.mkdir(parents=True,exist_ok=True,mode=0o700)
root.chmod(0o700)
script=root/'client.py'
config=root/'client.json'
stamp=time.strftime('%Y%m%d-%H%M%S')
def save(path,text,mode=0o600):
    if path.is_symlink(): raise ValueError('Refusing to replace a symlink')
    if path.exists() and path.read_text()!=text:
        backup=path.with_name(path.name+'.backup-'+stamp)
        backup.write_bytes(path.read_bytes()); backup.chmod(0o600)
    temporary=path.with_name(path.name+'.tmp')
    fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_TRUNC|os.O_NOFOLLOW,mode)
    with os.fdopen(fd,'w') as stream: stream.write(text)
    temporary.chmod(mode); temporary.replace(path)
old=json.loads(config.read_text()) if config.exists() else {}
token=old.get('token') or payload['token']
settings={'connection_id':payload['connection_id'],'hostname':hostname,
          'url':'http://127.0.0.1:'+str(payload['remote_port']), 'token':token,
          'timeout_seconds':65, 'transcript_roots':list(dict.fromkeys([
              str(codex/'sessions'),str(home/'.codex/sessions')]))}
save(script,payload['script'],0o700)
save(config,json.dumps(settings,ensure_ascii=False,indent=2)+'\n')
toml_path=codex/'config.toml'
shared_config=(home/'.codex/config.toml').resolve()
linked_config=toml_path.is_symlink() and toml_path.resolve()==shared_config
if toml_path.is_symlink() and not linked_config:
    raise ValueError('Unrecognized Codex configuration symlink')
toml_target=toml_path.resolve() if linked_config else toml_path
if toml_target.exists() and toml_target.stat().st_uid!=os.getuid():
    raise ValueError('Codex configuration belongs to another user')
original=toml_path.read_text() if toml_path.exists() else ''
begin='# BEGIN AI Persona remote '+payload['name']
end='# END AI Persona remote '+payload['name']
clean=original
if begin in original and end in original:
    # Codex may write trust-state tables between our markers. Preserve those tables.
    clean=re.sub(r'(?m)^'+re.escape(begin)+r'\n?|^'+re.escape(end)+r'\n?','',clean)
    clean=re.sub(r'(?ms)^\[mcp_servers\.ai_persona\][^\n]*\n.*?(?=^\[|\Z)','',clean)
parsed=tomllib.loads(clean)
if 'ai_persona' in parsed.get('mcp_servers',{}):
    raise ValueError('Existing ai_persona MCP configuration requires a manual merge')
helper=shlex.join(['/usr/bin/python3',str(script),'headers','--config',str(config)])
block=(begin+'\n[mcp_servers.ai_persona]\nurl = '+json.dumps(settings['url']+'/mcp')+
       '\nhttp_headers_helper = '+json.dumps(helper)+'\nrequired = false\nstartup_timeout_sec = 12\n'+end+'\n')
updated=clean.rstrip()+'\n\n'+block
tomllib.loads(updated)
hooks_path=codex/'hooks.json'
shared_hooks=home/'.codex/hooks.json'
link_hooks=linked_config and not hooks_path.exists() and not hooks_path.is_symlink()
if hooks_path.is_symlink() and hooks_path.resolve()!=shared_hooks.resolve():
    raise ValueError('Unrecognized Codex hooks symlink')
hooks_target=shared_hooks if link_hooks else hooks_path.resolve()
if hooks_target.exists() and hooks_target.stat().st_uid!=os.getuid():
    raise ValueError('Codex hooks belong to another user')
hooks=json.loads(hooks_target.read_text()) if hooks_target.exists() else {'hooks':{}}
command=shlex.join(['/usr/bin/python3',str(script),'hook','--config',str(config)])
groups=hooks.setdefault('hooks',{}).setdefault('UserPromptSubmit',[])
for group in groups:
    group['hooks']=[h for h in group.get('hooks',[]) if str(script) not in h.get('command','')]
groups[:]=[g for g in groups if g.get('hooks')]
groups.append({'hooks':[{'type':'command','command':command,'timeout':70,
                        'additionalContextLimit':0,'statusMessage':'正在处理本机 AI Persona（SSH）'}]})
save(toml_target,updated)
save(hooks_target,json.dumps(hooks,ensure_ascii=False,indent=2)+'\n')
if link_hooks: hooks_path.symlink_to(shared_hooks)
import hashlib
print(json.dumps({'hostname':hostname,'home':str(home),'client':str(script),'config':str(config),
                  'token_sha256':hashlib.sha256(token.encode()).hexdigest(),
                  'codex_home':str(codex),'transcript_roots':settings['transcript_roots'],
                  'codex_config':str(toml_path),'hooks_path':str(hooks_path)},ensure_ascii=False))
'''


def setup(workspace, ssh_host, config_path):
    if not ssh_host or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,99}", ssh_host):
        raise ValueError("Provide an SSH config host alias.")
    connection_id = "codex_remote_" + ssh_host.replace("-", "_").replace(".", "_")
    root = config_path.parent
    registry_path = root / "remote-clients.json"
    payload = {"name": ssh_host, "connection_id": connection_id, "remote_port": 18766,
               "token": secrets.token_urlsafe(48),
               "script": Path(__file__).with_name("remote_client.py").read_text()}
    script = REMOTE_INSTALL.replace("PAYLOAD", repr(payload), 1)
    result = subprocess.run(["/usr/bin/ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
                             ssh_host, "bash -lc 'exec /usr/bin/python3 -'"],
                            input=script, text=True, capture_output=True, timeout=60)
    if result.returncode:
        # Never include stdin or generated credentials in diagnostics.
        raise RuntimeError("Remote installation failed: " + result.stderr[-1500:])
    installed = json.loads(result.stdout)
    registry = private_json(registry_path) if registry_path.exists() else {"clients": []}
    registry["clients"] = [c for c in registry["clients"] if c["connection_id"] != connection_id]
    registry["clients"].append({"connection_id": connection_id, "enabled": True,
                                "token_sha256": installed["token_sha256"]})
    write_private(registry_path, registry)
    repository = LearningRepository(workspace.data_root)
    existing = next((c for c in repository.connections() if c.id == connection_id), None)
    connection = existing or SourceConnection(
        id=connection_id, name="Codex · " + installed["hostname"], adapter="codex",
        enabled=True, scope_mode="all", trust_user_messages=True,
    )
    connection.adapter_config.update(remote_host=installed["hostname"],
                                     codex_home=installed["codex_home"],
                                     transcript_roots=installed["transcript_roots"])
    repository.save_connection(connection)
    applications = ApplicationRepository(workspace.state_root)
    settings = applications.settings()
    if connection_id not in settings.connection_ids:
        settings.connection_ids.append(connection_id)
    settings.enabled = True
    applications.save_settings(settings)
    session = {"connection_id": connection_id, "ssh_host": ssh_host,
               "workspace": str(workspace.root), "registry": str(registry_path),
               "local_port": 8766, "remote_port": 18766,
               "review_url": "http://127.0.0.1:8765", "remote_client": installed["client"],
               "remote_config": installed["config"]}
    if config_path.exists():
        previous = private_json(config_path)
        if previous.get("connection_id") == connection_id:
            session["review_url"] = previous.get("review_url", session["review_url"])
    write_private(config_path, session)
    return {"ok": True, "connection_id": connection_id, "hostname": installed["hostname"],
            "remote_config": installed["config"], "hooks_path": installed["hooks_path"],
            "hook_review_required": True, "learning_enabled": repository.settings().enabled}
