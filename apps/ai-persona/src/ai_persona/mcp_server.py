from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Any

from mcp.server import MCPServer

from .query_mcp import register_query_tools
from .store import PersonaStore, StoreValidationError
from .workspace import resolve_workspace


def create_mcp_server(data_root: Path, state_root: Path) -> MCPServer[Any]:
    """Expose only reviewed knowledge and declared source reads to external agents."""
    from . import __version__
    from .demo import check_demo_paths
    from .mcp_setup import configuration, record_client_read

    check_demo_paths(data_root, state_root)
    # Bind observations to the configuration at server startup. An old running
    # process must not validate configuration edits made after it was launched.
    fingerprint = configuration(data_root, state_root)[1]
    server: MCPServer[Any] = MCPServer(
        name="ai-persona",
        title="AI Persona",
        description="Read reviewed personal knowledge and declared source content.",
        version=__version__,
        instructions=(
            "source: AI Persona\n\n"
            "purpose: Retrieve the user's knowledge structure, mastery, interests and materials "
            "relevant to the current task. Use this context to personalize content: build on "
            "familiar knowledge, explain unfamiliar concepts and reasoning steps, and tailor "
            "examples and extensions to the user's interests.\n\n"
            "interest_level:\n"
            "  high: Proactively recommend related content, including relevant extensions.\n"
            "  medium: Recommend content only when directly relevant to the current question "
            "or task.\n"
            "  low: Do not proactively recommend content based on this interest."
        ),
    )
    register_query_tools(
        server,
        data_root,
        state_root,
        on_read=lambda tool: record_client_read(data_root, state_root, fingerprint, tool),
    )
    for tool in server._tool_manager.list_tools():
        tool.fn_metadata.arg_model.model_config["extra"] = "forbid"
        tool.fn_metadata.arg_model.model_rebuild(force=True)
        tool.parameters = tool.fn_metadata.arg_model.model_json_schema(by_alias=True)
    return server


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="ai-persona-mcp",
        description="Run the read-only AI Persona MCP server over stdio.",
    )
    parser.add_argument(
        "--workspace",
        type=Path,
        help="persona workspace containing persona-data and persona-state",
    )
    parser.add_argument("--data", type=Path, help="explicit persona data directory")
    parser.add_argument("--state", type=Path, help="explicit persona state directory")
    parser.add_argument("--demo", action="store_true", help="use the bundled demo persona")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        workspace = resolve_workspace(
            workspace=args.workspace,
            data_root=args.data,
            state_root=args.state,
            demo=args.demo,
            require_data=True,
            require_state=True,
        )
        assert workspace.data_root is not None
        assert workspace.state_root is not None
        # Individual source failures are reported by the query that reads them;
        # they must not prevent the entire knowledge map from being available.
        PersonaStore(workspace.data_root).load(verify_source_files=False)
        server = create_mcp_server(workspace.data_root, workspace.state_root)
    except (StoreValidationError, FileNotFoundError, ValueError, RuntimeError) as exc:
        print(f"ai-persona-mcp: {exc}", file=sys.stderr)
        return 2
    server.run("stdio")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
