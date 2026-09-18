#!/usr/bin/env python3
"""Run inside the installed release, never against checkout imports or real accounts."""

import argparse
import asyncio
import json
import os
import shutil
import subprocess
import tomllib
from pathlib import Path
from types import SimpleNamespace

from ai_persona import codex_setup
from ai_persona.compiler import PersonaCompiler
from ai_persona.conversation_learning.contracts import SourceConnection
from ai_persona.conversation_learning.repository import LearningRepository
from ai_persona.demo import demo_seed
from ai_persona.store import PersonaStore
from ai_persona.workspace import save_configured_workspace
from mcp import Client, StdioServerParameters


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["seed", "check"])
    parser.add_argument("--directory", type=Path, required=True)
    args = parser.parse_args()
    directory = args.directory.resolve()
    workspace = directory / "Existing Persona"
    data, state = workspace / "persona-data", workspace / "persona-state"
    home = Path(os.environ["CODEX_HOME"])
    if args.action == "seed":
        shutil.copytree(demo_seed(), data)
        # Reuse fictional records in a normal workspace; Demo deliberately rejects Hooks.
        (data / "demo.json").unlink()
        state.mkdir(parents=True)
        (home / "sessions").mkdir(parents=True)
        save_configured_workspace(workspace)
    repository = LearningRepository(data)
    service = SimpleNamespace(repository=repository, data_root=data, state_root=state)
    identifier = "release-upgrade"
    if args.action == "seed":
        repository.save_connection(SourceConnection(
            id=identifier, name="Release upgrade fixture", adapter="codex", scope_mode="all",
            adapter_config={"codex_home": str(home), "transcript_roots": [str(home / "sessions")]},
        ))
        preview = codex_setup.installation(service, identifier)
        codex_setup.install(service, identifier, preview["revision"])
        (home / "config.toml").write_text(
            '[mcp_servers.persona]\ncommand = ' + json.dumps(os.environ["AI_PERSONA_MCP_COMMAND"])
            + '\nargs = ' + json.dumps(["--workspace", str(workspace)]) + '\n'
        )
    PersonaCompiler(data, state).build()
    store = PersonaStore(data).load()
    knowledge = [key for key, item in store.records.items()
                 if item.record.entity_type == "knowledge_node"]
    preferences = [key for key, item in store.records.items()
                   if item.record.entity_type == "preference"]
    assert knowledge and preferences, "Fixture must include existing knowledge and preferences"
    probe = codex_setup.begin_probe(repository, identifier)
    transcript = home / "sessions" / "upgrade.jsonl"
    transcript.write_text('\n'.join(json.dumps(entry) for entry in [
        {"type": "session_meta", "payload": {"id": "upgrade"}},
        {"type": "response_item", "payload": {"type": "message", "role": "user",
            "content": [{"type": "input_text", "text": "Explain this saved knowledge."}]}},
    ]) + '\n')
    handler = json.loads((home / "hooks.json").read_text())["hooks"]["UserPromptSubmit"][0]["hooks"][0]
    payload = {"hook_event_name": "UserPromptSubmit", "session_id": "upgrade", "turn_id": "probe",
               "cwd": str(directory), "transcript_path": str(transcript), "prompt": probe["message"]}
    subprocess.run(["/bin/sh", "-c", handler["command"]], input=json.dumps(payload),
                   text=True, check=True, timeout=75, cwd=directory)
    result = codex_setup.probe_state(repository, repository.connection(identifier))
    assert result["status"] == "received" and result["scope_ok"], result
    assert result["context_status"] == "readable" and result["context_messages"] == 1, result

    async def mcp_check():
        config = tomllib.loads((home / "config.toml").read_text())["mcp_servers"]["persona"]
        parameters = StdioServerParameters(**config, env=dict(os.environ))
        async with Client(parameters, read_timeout_seconds=30) as client:
            tools = await client.list_tools()
            assert len(tools.tools) == 6
            response = await client.call_tool("get_persona_records", {"record_ids": [knowledge[0]]})
            assert not response.is_error, response
            value = response.structured_content
            value = value.get("result", value)
            assert value["ok"] and value["data"]["items"][0]["record"]["id"] == knowledge[0]

    asyncio.run(mcp_check())
    print(json.dumps({"hook": "received", "mcp": "read_success", "knowledge": len(knowledge),
                      "preferences": len(preferences)}))


if __name__ == "__main__":
    main()
