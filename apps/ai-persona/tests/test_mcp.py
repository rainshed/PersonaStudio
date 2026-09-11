from __future__ import annotations

import asyncio
import shutil
import sys
from pathlib import Path
from typing import Any

from mcp import Client, StdioServerParameters
from persona_fixture import demo_workspace

from ai_persona.compiler import PersonaCompiler
from ai_persona.mcp_server import create_mcp_server
from ai_persona.query_mcp import PUBLIC_QUERY_TOOLS
from ai_persona.store import PersonaStore


def mcp_workspace(tmp_path: Path) -> tuple[Path, Path]:
    demo = demo_workspace().data_root
    assert demo is not None
    data_root = tmp_path / "persona-data"
    state_root = tmp_path / "persona-state"
    shutil.copytree(demo, data_root)
    PersonaCompiler(data_root, state_root).build()
    return data_root, state_root


def structured(result: Any) -> dict[str, Any]:
    assert result.structured_content is not None
    # The MCP Python SDK wraps a union return schema in its standard `result` field.
    return result.structured_content.get("result", result.structured_content)


def test_mcp_exposes_only_public_read_capabilities(tmp_path: Path) -> None:
    data_root, state_root = mcp_workspace(tmp_path)

    async def scenario() -> None:
        async with Client(create_mcp_server(data_root, state_root)) as client:
            listed = await client.list_tools()
            expected = (
                "get_knowledge_map", "search_knowledge", "get_persona_records",
                "list_source_files", "search_source_content", "read_source",
            )
            assert tuple(tool.name for tool in listed.tools) == expected == PUBLIC_QUERY_TOOLS
            for tool in listed.tools:
                assert tool.input_schema["additionalProperties"] is False
                assert tool.annotations is not None
                assert tool.annotations.destructive_hint is False
                assert tool.annotations.open_world_hint is False
                assert tool.annotations.idempotent_hint is True
                assert tool.annotations.read_only_hint is True

            removed = (
                "verify_persona_connection", "resolve_persona_activation", "prepare_preference_context",
                "ingest_conversation_event", "get_conversation_learning_status", "search_preferences",
                "get_preference_records", "propose_change_set", "get_proposal_status", "list_persona_changes",
            )
            for name in removed:
                assert (await client.call_tool(name, {})).is_error

            injected = await client.call_tool(
                "search_knowledge", {"query": "TEBD", "admin": True}
            )
            assert injected.is_error

    asyncio.run(scenario())


def test_mcp_reads_declared_files_without_host_paths(tmp_path: Path) -> None:
    data_root, state_root = mcp_workspace(tmp_path)

    async def scenario():
        async with Client(create_mcp_server(data_root, state_root)) as client:
            listing = structured(await client.call_tool(
                "list_source_files", {"source_id": "src_demo_note"}))
            file = listing["data"]["entries"][0]
            assert file["relative_path"] == "original.md"
            assert "path" not in file
            result = await client.call_tool("read_source", {
                "source_id": "src_demo_note", "file_id": file["file_id"], "view": "text"})
            assert not result.is_error
            assert "TEBD" in structured(result)["data"]["text"]
            missing = await client.call_tool("list_source_files", {"source_id": "src_missing"})
            assert missing.is_error
            assert structured(missing)["error"]["code"] == "not_found_or_not_visible"
            bad = await client.call_tool("read_source", {
                "source_id": "src_demo_note", "file_id": "../../config/persona.toml"})
            assert bad.is_error

    asyncio.run(scenario())


def test_mcp_reads_reviewed_context_and_returns_domain_errors(tmp_path: Path) -> None:
    data_root, state_root = mcp_workspace(tmp_path)

    async def scenario():
        async with Client(create_mcp_server(data_root, state_root)) as client:
            search = structured(await client.call_tool("search_knowledge", {"query": "TEBD"}))
            assert search["ok"]
            assert "kn_demo_tebd" in {item["id"] for item in search["data"]["hits"]}
            assert all(item["record_revision"] >= 1 for item in search["data"]["nodes"])
            graph = structured(await client.call_tool("get_knowledge_map", {
                "focus_ids": ["kn_demo_tebd"], "max_chars": 16000}))
            assert graph["persona_revision"] == search["persona_revision"]
            assert graph["data"]["edges"]
            detail = structured(await client.call_tool("get_persona_records", {
                "record_ids": ["kn_demo_tebd"]}))
            assert detail["data"]["items"][0]["record"]["entity_type"] == "knowledge_node"
            invalid = await client.call_tool("search_knowledge", {})
            assert invalid.is_error
            assert structured(invalid)["error"]["code"] == "invalid_arguments"
            missing = await client.call_tool("search_knowledge", {
                "scope": {"tag_ids": ["tag_missing"]}})
            assert missing.is_error
            assert structured(missing)["error"]["code"] == "invalid_reference"
            for old in ("list_tags", "prepare_persona_context",
                        "get_persona_record", "get_material_source"):
                assert (await client.call_tool(old, {})).is_error

    asyncio.run(scenario())


def test_mcp_stdio_process_completes_a_real_handshake(tmp_path: Path) -> None:
    data_root, _ = mcp_workspace(tmp_path)
    workspace_root = data_root.parent

    async def scenario() -> None:
        parameters = StdioServerParameters(
            command=sys.executable,
            env={"PYTHONPATH": str(Path(__file__).resolve().parents[1] / "src"),
                 "AI_PERSONA_SEMANTIC_SEARCH": "0"},
            args=[
                "-m",
                "ai_persona.mcp_server",
                "--workspace",
                str(workspace_root),
            ],
        )
        async with Client(parameters, read_timeout_seconds=10) as client:
            listed = await client.list_tools()
            assert tuple(t.name for t in listed.tools) == PUBLIC_QUERY_TOOLS
            result = structured(
                await client.call_tool("search_knowledge", {"query": "TEBD", "limit": 1})
            )
            assert result["ok"] is True
            assert result["data"]["hits"][0]["id"] == "kn_demo_tebd"

    asyncio.run(scenario())


def test_installed_mcp_configuration_uses_stable_command(tmp_path, monkeypatch):
    from ai_persona import mcp_setup

    command = tmp_path / "bin/ai-persona-mcp"
    monkeypatch.setenv("AI_PERSONA_MCP_COMMAND", str(command))
    data, state = tmp_path / "data", tmp_path / "state"
    selected, arguments, environment = mcp_setup.server_process(data, state)
    assert selected == str(command)
    assert arguments == ["--data", str(data), "--state", str(state)]
    assert environment == {}


def test_mcp_stdio_starts_with_a_missing_source_and_reports_file_coverage(tmp_path):
    data, _ = mcp_workspace(tmp_path)
    store = PersonaStore(data).load()
    source = store.sources["src_demo_note"]
    store.source_file_path(source.id, source.canonical_file).unlink()

    async def scenario():
        parameters = StdioServerParameters(
            command=sys.executable,
            env={"PYTHONPATH": str(Path(__file__).resolve().parents[1] / "src"),
                 "AI_PERSONA_SEMANTIC_SEARCH": "0"},
            args=["-m", "ai_persona.mcp_server", "--workspace", str(data.parent)],
        )
        async with Client(parameters, read_timeout_seconds=10) as client:
            graph = structured(await client.call_tool("get_knowledge_map", {}))
            assert graph["ok"] and graph["data"]["nodes"]
            files = structured(await client.call_tool("list_source_files", {"source_id": source.id}))
            assert files["ok"] and files["data"]["entries"][0]["parse_status"] == "failed"
    asyncio.run(scenario())
