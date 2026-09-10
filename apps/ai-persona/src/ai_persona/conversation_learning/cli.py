"""Thin local transport. Captures fail open without printing host context."""

from __future__ import annotations

import contextlib
import json
import sys

from .contracts import ContextSnapshot, ConversationEvent, LearningSettings, SourceConnection
from .repository import LearningRepository
from .service import ConversationLearningService


def read_input():
    content = sys.stdin.read(280_000)
    if len(content.encode()) > 256 * 1024:
        raise ValueError("输入超过 256 KiB。")
    value = json.loads(content)
    if not isinstance(value, dict):
        raise ValueError("输入必须是 JSON 对象。")
    return value


def hook_config(service, connection_id):
    from ..codex_hook import hook_config as shared_hook_config

    return shared_hook_config(service.data_root, service.state_root, service.repository, connection_id)


def run(args, workspace):
    repository = LearningRepository(workspace.data_root, args.queue_dir)
    service = ConversationLearningService(
        workspace.data_root, workspace.state_root, repository=repository
    )
    if args.action == "capture":
        from .adapters.codex import capture

        try:
            with contextlib.redirect_stdout(sys.stderr):
                capture(service, args.connection, read_input())
        except Exception:
            # Do not echo exceptions/payloads; even stderr can appear in the host UI.
            try:
                repository.diagnostic(args.connection, "capture_failed")
            except Exception:
                pass
            print("AI Persona capture failed; check local learning status.", file=sys.stderr)
        return None
    if args.action == "ingest":
        value = read_input()
        snapshot = value.pop("snapshot", None)
        return service.ingest_event(
            ConversationEvent.model_validate(value),
            args.connection,
            ContextSnapshot.model_validate(snapshot) if snapshot else None,
        )
    if args.action == "configure":
        value = read_input()
        if set(value) - {"settings", "connections"}:
            raise ValueError("配置只接受 settings 和 connections。")
        if "settings" in value:
            repository.save_settings(LearningSettings.model_validate(value["settings"]))
        for connection in value.get("connections", []):
            repository.save_connection(SourceConnection.model_validate(connection))
        return {
            "ok": True,
            "settings": repository.settings().model_dump(),
            "connections": [c.model_dump() for c in repository.connections()],
        }
    if args.action == "status":
        from .worker import worker_status

        return {
            **repository.health(),
            "settings": repository.settings().model_dump(),
            "worker": worker_status(repository),
            "queue_directory": str(repository.directory),
        }
    if args.action == "worker":
        from .worker import LearningWorker, run_worker

        if args.once:
            return {"processed": LearningWorker(service).run_once()}
        run_worker(service)
        return None
    if args.action == "start-worker":
        from .worker import start_worker

        return start_worker(service)
    if args.action == "stop-worker":
        from .worker import stop_worker

        return stop_worker(service)
    if args.action == "cleanup":
        return service.cleanup()
    if args.action == "hook-config":
        return hook_config(service, args.connection)
    if args.action == "retry":
        return service.retry_job(
            args.event, args.version, args.connection, confirm_human=args.confirm_human
        )
    raise ValueError("未知学习命令。")
