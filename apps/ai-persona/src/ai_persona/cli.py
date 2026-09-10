from __future__ import annotations

import argparse
import json
import os
import sys
from contextlib import nullcontext
from pathlib import Path

from .compiler import PersonaCompiler
from .demo import DEMO_PORT
from .index import prepare_context, search_index
from .initialization import INITIAL_DOMAIN_TAGS, initialize_persona
from .launcher import read_ui_logs, start_ui, stop_ui, track_ui_process, ui_status
from .store import PersonaStore, StoreValidationError
from .workspace import (
    configured_workspace,
    project_root,
    resolve_workspace,
    save_configured_workspace,
)


def _add_location_arguments(
    parser: argparse.ArgumentParser,
    *,
    include_data: bool,
    include_state: bool,
    allow_demo: bool = True,
) -> None:
    parser.add_argument(
        "--workspace",
        type=Path,
        help="persona workspace containing persona-data and persona-state",
    )
    if include_data:
        parser.add_argument("--data", type=Path)
    if include_state:
        parser.add_argument("--state", type=Path)
    if allow_demo:
        parser.add_argument("--demo", action="store_true", help="use the bundled demo persona")


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="ai-persona",
        description="Run AI Persona Studio or manage persona data.",
    )
    from . import __version__

    parser.add_argument("--version", action="version", version=f"AI Persona {__version__} (PersonaStudio)")
    subparsers = parser.add_subparsers(dest="command")

    setup = subparsers.add_parser("setup", help="open the first-run workspace guide")
    setup.add_argument("--port", type=int, default=0, help="guide port (default: any free port)")
    setup.add_argument("--no-open", action="store_true", help="print the guide URL without opening it")

    doctor = subparsers.add_parser("doctor", help="check the local installation without calling a model")
    _add_location_arguments(doctor, include_data=True, include_state=True)
    doctor.add_argument("--require-models", action="store_true", help="treat optional model setup as required")

    backup = subparsers.add_parser("backup", help="create a verified private workspace backup")
    backup.add_argument("--workspace", type=Path, required=True)
    backup.add_argument("--output", type=Path, required=True)
    backup.add_argument("--learning-dir", type=Path, help="custom learning queue directory, if configured")

    restore = subparsers.add_parser("restore", help="restore a backup into a new workspace")
    restore.add_argument("archive", type=Path)
    restore.add_argument("--workspace", type=Path, required=True)

    migrate = subparsers.add_parser("migrate", help="copy an old workspace into a new location")
    migrate.add_argument("--from", dest="source", type=Path, required=True)
    migrate.add_argument("--workspace", type=Path, required=True)
    migrate.add_argument("--learning-dir", type=Path, help="custom learning queue directory, if configured")

    subparsers.add_parser("models-install", help="install the pinned Pi model runtime")
    models_stop = subparsers.add_parser("models-stop", help="stop the local Pi model service")
    models_stop.add_argument("--demo", action="store_true", help="stop only the Demo model service")

    remote = subparsers.add_parser("remote", help="manage the remote Persona gateway and SSH tunnel")
    remote.add_argument("action", choices=["setup", "start", "stop", "status", "supervise"])
    remote.add_argument("--config", type=Path,
                        default=Path.home() / ".config/ai-persona/remote.json")
    remote.add_argument("--ssh-host")
    _add_location_arguments(remote, include_data=False, include_state=False, allow_demo=False)

    codex_hook = subparsers.add_parser("codex-hook", help="capture Codex turns for learning and preferences")
    codex_hook.add_argument("action", choices=["run", "enqueue"])
    _add_location_arguments(codex_hook, include_data=True, include_state=True)
    codex_hook.add_argument("--connection", required=True)
    codex_hook.add_argument("--queue-dir", type=Path)

    application = subparsers.add_parser("preferences-apply", help="apply saved preferences to Codex turns")
    application.add_argument("action", choices=["hook", "process", "configure", "status", "hook-config"])
    _add_location_arguments(application, include_data=True, include_state=True)
    application.add_argument("--connection")
    application.add_argument("--application")
    application.add_argument("--queue-dir", type=Path)

    learning = subparsers.add_parser("learning", help="manage opt-in conversation learning")
    learning.add_argument("action", choices=["ingest", "capture", "configure", "status", "worker",
                                            "start-worker", "stop-worker", "cleanup", "hook-config", "retry"])
    _add_location_arguments(learning, include_data=True, include_state=True)
    learning.add_argument("--connection")
    learning.add_argument("--adapter", choices=["codex"], default="codex")
    learning.add_argument("--queue-dir", type=Path, help="explicit machine-local queue directory")
    learning.add_argument("--once", action="store_true")
    learning.add_argument("--event")
    learning.add_argument("--version", type=int)
    learning.add_argument("--confirm-human", action="store_true")

    start = subparsers.add_parser("start", help="start Studio in the background and open it")
    _add_location_arguments(start, include_data=True, include_state=True)
    start.add_argument("--host", default="127.0.0.1")
    start.add_argument("--port", type=int, help="fixed Studio port (default: prefer 8765, or 8766 for Demo; automatically select a free port if occupied)")
    start.add_argument("--no-open", action="store_true", help="do not open a browser")
    start.add_argument("--startup-timeout", type=float, default=15.0)

    status = subparsers.add_parser("status", help="show Studio process status")
    _add_location_arguments(status, include_data=True, include_state=True)

    stop = subparsers.add_parser("stop", help="stop the background Studio process")
    _add_location_arguments(stop, include_data=True, include_state=True)
    stop.add_argument("--timeout", type=float, default=10.0)

    logs = subparsers.add_parser("logs", help="show recent Studio logs")
    _add_location_arguments(logs, include_data=True, include_state=True)
    logs.add_argument("-n", "--lines", type=int, default=50)

    configure = subparsers.add_parser("configure", help="save the default persona workspace")
    configure.add_argument("--workspace", type=Path, required=True)

    initialize = subparsers.add_parser(
        "init", help="initialize a new empty persona without overwriting existing data"
    )
    _add_location_arguments(
        initialize,
        include_data=True,
        include_state=True,
        allow_demo=False,
    )
    initialize.add_argument("--persona-id", default="my-persona")

    validate = subparsers.add_parser("validate", help="validate canonical persona records")
    _add_location_arguments(validate, include_data=True, include_state=False)

    build = subparsers.add_parser("build", help="build all generated projections")
    _add_location_arguments(build, include_data=True, include_state=True)

    search = subparsers.add_parser("search", help="search the generated SQLite index")
    search.add_argument("query")
    _add_location_arguments(search, include_data=False, include_state=True)
    search.add_argument("--limit", type=int, default=10)

    prepare = subparsers.add_parser(
        "prepare",
        help="assemble knowledge and preferences for one task",
    )
    prepare.add_argument("--context", required=True, help="preference context key")
    prepare.add_argument("--question", required=True)
    _add_location_arguments(prepare, include_data=False, include_state=True)

    serve = subparsers.add_parser("serve", help="run the local human review UI")
    _add_location_arguments(serve, include_data=True, include_state=True)
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, help="Studio port (real: 8765; Demo: 8766)")
    serve.add_argument("--supervised", action="store_true", help="track foreground server for launchd")
    serve.add_argument("--listen-fd", type=int, help=argparse.SUPPRESS)
    return parser


def _resolve_cli_workspace(
    args: argparse.Namespace,
    *,
    require_data: bool,
    require_state: bool,
    allow_local_default: bool = True,
    allow_demo: bool = True,
):
    selected_workspace = getattr(args, "workspace", None)
    selected_data = getattr(args, "data", None)
    selected_state = getattr(args, "state", None)
    demo = getattr(args, "demo", False)
    if (
        allow_local_default
        and selected_workspace is None
        and selected_data is None
        and selected_state is None
        and not demo
        and not os.environ.get("AI_PERSONA_WORKSPACE")
    ):
        selected_workspace = configured_workspace()
        if selected_workspace is None:
            candidate = project_root()
            if (candidate / "persona-data" / "config" / "persona.toml").is_file():
                selected_workspace = candidate
    return resolve_workspace(
        workspace=selected_workspace,
        data_root=selected_data,
        state_root=selected_state,
        demo=demo,
        require_data=require_data,
        require_state=require_state,
        allow_demo=allow_demo,
    )


def main(argv: list[str] | None = None) -> int:
    arguments = list(sys.argv[1:] if argv is None else argv)
    if not arguments:
        arguments = ["start"]
    args = _parser().parse_args(arguments)
    if args.command == "models-install":
        from .model_bridge import install_runtime

        return install_runtime()
    if args.command == "models-stop":
        from .model_bridge import ModelClient

        if args.demo:
            from .workspace import demo_workspace

            workspace = demo_workspace()
            ModelClient.for_workspace(workspace.data_root, workspace.state_root).stop()
        else:
            ModelClient().stop()
        print("本地模型服务已停止；下次模型请求时会重新启动。")
        return 0
    try:
        if args.command == "setup":
            from .onboarding import run_setup

            return run_setup(port=args.port, open_browser=not args.no_open)
        elif args.command == "doctor":
            from .diagnostics import diagnose

            try:
                workspace = _resolve_cli_workspace(args, require_data=True, require_state=True)
                workspace_error = None
            except (ValueError, FileNotFoundError) as exc:
                workspace, workspace_error = None, str(exc)
            result = diagnose(workspace, workspace_error=workspace_error,
                              require_models=args.require_models)
            print(json.dumps(result, ensure_ascii=False, indent=2))
            return 0 if result["ok"] else 2
        elif args.command in {"backup", "restore", "migrate"}:
            from .backup import backup_workspace, migrate_workspace, restore_workspace

            if args.command == "backup":
                result = backup_workspace(args.workspace, args.output, learning_dir=args.learning_dir)
            elif args.command == "restore":
                result = restore_workspace(args.archive, args.workspace)
            else:
                result = migrate_workspace(args.source, args.workspace, learning_dir=args.learning_dir)
        elif args.command == "remote":
            from .remote_session import run

            if args.action == "setup":
                from .remote_install import setup

                workspace = _resolve_cli_workspace(
                    args, require_data=True, require_state=True, allow_demo=False
                )
                result = setup(workspace, args.ssh_host, args.config)
            else:
                result = run(args.action, args.config)
            if result is None:
                return 0
        elif args.command == "codex-hook":
            from .codex_hook import run

            workspace = _resolve_cli_workspace(
                args, require_data=True, require_state=True, allow_demo=False
            )
            run(args, workspace)
            return 0
        elif args.command == "preferences-apply":
            from .preference_application.cli import run

            workspace = _resolve_cli_workspace(
                args, require_data=True, require_state=True, allow_demo=False
            )
            result = run(args, workspace)
            if result is None:
                return 0
        elif args.command == "learning":
            from .conversation_learning.cli import run

            workspace = _resolve_cli_workspace(
                args, require_data=True, require_state=True, allow_demo=False
            )
            result = run(args, workspace)
            if result is None:
                return 0
        elif args.command == "start":
            try:
                workspace = _resolve_cli_workspace(args, require_data=True, require_state=True)
            except ValueError:
                # An explicit selection or invalid configuration remains an actionable error.
                if any((args.workspace, args.data, args.state, args.demo,
                        os.environ.get("AI_PERSONA_WORKSPACE"), configured_workspace())):
                    raise
                if args.port is not None or args.host != "127.0.0.1" or args.startup_timeout != 15.0:
                    raise ValueError("Run ai-persona setup to choose a workspace before using advanced start options.")
                from .onboarding import run_setup

                return run_setup(open_browser=not args.no_open)
            result = start_ui(
                workspace,
                host=args.host,
                port=args.port,
                open_browser=not args.no_open,
                startup_timeout=args.startup_timeout,
            )
        elif args.command == "status":
            workspace = _resolve_cli_workspace(args, require_data=True, require_state=True)
            result = ui_status(workspace)
        elif args.command == "stop":
            workspace = _resolve_cli_workspace(args, require_data=True, require_state=True)
            result = stop_ui(workspace, timeout=args.timeout)
        elif args.command == "logs":
            workspace = _resolve_cli_workspace(args, require_data=True, require_state=True)
            print(read_ui_logs(workspace, lines=args.lines))
            return 0
        elif args.command == "configure":
            workspace = resolve_workspace(
                workspace=args.workspace,
                data_root=None,
                state_root=None,
                demo=False,
                require_data=True,
                require_state=True,
                allow_demo=False,
            )
            assert workspace.root is not None
            assert workspace.data_root is not None
            PersonaStore(workspace.data_root).load()
            config_path = save_configured_workspace(workspace.root)
            result = {
                "ok": True,
                "workspace": str(workspace.root),
                "config": str(config_path),
            }
        elif args.command == "init":
            workspace = _resolve_cli_workspace(
                args,
                require_data=True,
                require_state=True,
                allow_local_default=False,
                allow_demo=False,
            )
            assert workspace.data_root is not None
            assert workspace.state_root is not None
            initialized = initialize_persona(
                workspace.data_root,
                workspace.state_root,
                persona_id=args.persona_id,
            )
            result = {
                "ok": True,
                "initialized": True,
                "persona_id": initialized.persona_id,
                "persona_revision": initialized.persona_revision,
                "records": len(INITIAL_DOMAIN_TAGS),
                "sources": 0,
                "data": str(initialized.data_root),
                "state": str(initialized.state_root),
                "workspace": str(workspace.root) if workspace.root else None,
                "snapshot": str(initialized.snapshot_path),
                "database": str(initialized.state_database),
            }
        elif args.command == "validate":
            workspace = _resolve_cli_workspace(args, require_data=True, require_state=False)
            assert workspace.data_root is not None
            store = PersonaStore(workspace.data_root).load()
            assert store.config is not None
            result = {
                "ok": True,
                "persona_revision": store.config.revision,
                "records": len(store.records),
                "sources": len(store.sources),
                "closure_edges": len(store.relation_closure()),
            }
        elif args.command == "build":
            workspace = _resolve_cli_workspace(args, require_data=True, require_state=True)
            assert workspace.data_root is not None
            assert workspace.state_root is not None
            built = PersonaCompiler(workspace.data_root, workspace.state_root).build()
            result = {
                "ok": True,
                "persona_revision": built.persona_revision,
                "records": built.record_count,
                "sources": built.source_count,
                "snapshot": str(built.snapshot_path),
                "database": str(built.state_database),
            }
        elif args.command == "search":
            workspace = _resolve_cli_workspace(args, require_data=False, require_state=True)
            assert workspace.state_root is not None
            result = {
                "ok": True,
                "query": args.query,
                "results": search_index(workspace.state_root, args.query, limit=args.limit),
            }
        elif args.command == "prepare":
            workspace = _resolve_cli_workspace(args, require_data=False, require_state=True)
            assert workspace.state_root is not None
            result = {
                "ok": True,
                "context": prepare_context(
                    workspace.state_root,
                    context_key=args.context,
                    question=args.question,
                ),
            }
        elif args.command == "serve":
            import uvicorn

            from .web import create_app

            workspace = _resolve_cli_workspace(args, require_data=True, require_state=True)
            assert workspace.data_root is not None
            assert workspace.state_root is not None
            port = args.port if args.port is not None else DEMO_PORT if workspace.is_demo else 8765
            PersonaCompiler(workspace.data_root, workspace.state_root).build()
            app = create_app(workspace.data_root, workspace.state_root)
            tracking = track_ui_process(workspace, args.host, port) if args.supervised else nullcontext()
            with tracking:
                if args.listen_fd is None:
                    uvicorn.run(
                        app, host=args.host, port=port, log_level="info", proxy_headers=False,
                    )
                else:
                    import socket

                    with socket.socket(fileno=args.listen_fd) as listener:
                        server = uvicorn.Server(uvicorn.Config(
                            app, host=args.host, port=port, log_level="info", proxy_headers=False,
                        ))
                        server.run(sockets=[listener])
            return 0
        else:
            raise ValueError(f"unknown command: {args.command}")
    except (StoreValidationError, OSError, ValueError, RuntimeError) as exc:
        if args.command == "codex-hook":
            return 0
        if args.command == "preferences-apply" and args.action in {"hook", "process"}:
            return 0
        if args.command == "learning" and args.action == "capture":
            print("AI Persona capture unavailable; check local learning settings.", file=sys.stderr)
            return 0
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
