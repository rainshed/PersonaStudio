"""Local authenticated bridge to the same pinned Pi adapter used by Paper Radar."""

from __future__ import annotations

import fcntl
import hashlib
import json
import os
import signal
import subprocess
import time
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import ProxyHandler, Request, build_opener

from .agent import AgentServiceError
from .runtime_support import (
    install_runtime_dependencies,
    runtime_directory,
    runtime_environment,
    tool_diagnostic,
)


class ModelClient:
    @classmethod
    def for_workspace(cls, data_root: Path, state_root: Path):
        from .demo import check_demo_paths, is_demo_data

        if is_demo_data(data_root):
            check_demo_paths(data_root, state_root)
            return cls(state_root / "models")
        return cls()

    def __init__(self, directory: Path | None = None) -> None:
        self.directory = directory or Path(
            os.environ.get(
                "AI_PERSONA_MODEL_DATA_DIR",
                str(Path.home() / ".local/share/ai-persona/models"),
            )
        )
        self.runtime = runtime_directory()
        self.opener = build_opener(ProxyHandler({}))

    def _descriptor(self) -> dict[str, Any] | None:
        try:
            value = json.loads((self.directory / "runtime.json").read_text())
            if value.get("version") != 1 or not 1 <= int(value["port"]) <= 65535:
                return None
            if len(value["token"]) != 64:
                return None
            os.kill(int(value["pid"]), 0)
            self._request(value, "health", None, timeout=1)
            return value
        except (OSError, ValueError, KeyError, TypeError, AgentServiceError):
            return None

    def ensure(self) -> dict[str, Any]:
        # Dependencies are kept outside the Python package so reinstalls cannot
        # remove them. Still detect an incomplete/deleted cache before reuse.
        if not (self.runtime / "node_modules/@earendil-works/pi-ai/package.json").is_file():
            raise AgentServiceError(
                "runtime_missing",
                "本机模型运行依赖缺失，请运行 ai-persona models-install 并重启模型服务；"
                "此错误不需要重新授权。",
            )
        existing = self._descriptor()
        if existing:
            return existing
        node = tool_diagnostic("node")
        if not node["ok"]:
            raise AgentServiceError("runtime_missing", node["message"])
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.directory.chmod(0o700)
        lock_path = self.directory / "startup.lock"
        with lock_path.open("a") as lock:
            lock_path.chmod(0o600)
            fcntl.flock(lock, fcntl.LOCK_EX)
            existing = self._descriptor()
            if existing:
                return existing
            env = {**runtime_environment(), "AI_PERSONA_MODEL_DATA_DIR": str(self.directory)}
            process = subprocess.Popen(
                [node["path"], "--experimental-strip-types", str(self.runtime / "daemon.mjs")],
                cwd=self.runtime,
                env=env,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
            for _ in range(80):
                existing = self._descriptor()
                if existing:
                    return existing
                if process.poll() is not None:
                    break
                time.sleep(0.1)
        raise AgentServiceError(
            "runtime_unavailable", "Pi 模型服务未能启动，请检查 Node 版本和本地模型存储。"
        )

    def _request(
        self,
        descriptor: dict[str, Any],
        route: str,
        payload: dict | None,
        *,
        timeout: float = 510,
    ) -> dict[str, Any]:
        request = Request(
            f"http://127.0.0.1:{descriptor['port']}/{route}",
            data=None if payload is None else json.dumps(payload).encode(),
            headers={
                "Authorization": f"Bearer {descriptor['token']}",
                "Content-Type": "application/json",
            },
        )
        try:
            with self.opener.open(request, timeout=timeout) as response:
                return json.load(response)
        except HTTPError as exc:
            try:
                error = json.loads(exc.read())
            except (ValueError, OSError):
                error = {}
            raise AgentServiceError(
                error.get("code", "model_error"),
                error.get("error", "模型调用失败"),
                retryable=bool(error.get("retryable")),
                details={"model_run": error["model_run"]} if error.get("model_run") else {},
            ) from None
        except (URLError, TimeoutError, OSError) as exc:
            # urllib can raise a socket timeout directly or wrap it in URLError.
            # At the shared deadline this can arrive before the daemon's own
            # timeout response; it does not mean the local service is offline.
            timed_out = isinstance(exc, TimeoutError) or isinstance(
                getattr(exc, "reason", None), TimeoutError
            )
            raise AgentServiceError(
                "timeout" if timed_out else "runtime_unavailable",
                "等待模型服务响应超时。" if timed_out else "无法连接本地模型服务，请重试。",
                retryable=True,
            ) from exc

    def request(self, route: str, payload: dict | None = None) -> dict[str, Any]:
        return self._request(self.ensure(), route, payload)

    def stop(self) -> None:
        descriptor = self._descriptor()
        if descriptor:
            os.kill(descriptor["pid"], signal.SIGTERM)

    def cancel(self, run_id: str) -> None:
        descriptor = self._descriptor()
        if descriptor:
            self._request(descriptor, "cancel", {"runId": run_id}, timeout=3)

    def generate(
        self,
        task: str,
        system: str,
        payload: dict | str,
        *,
        max_tokens=8192,
        run_id: str | None = None,
        stage: str | None = None,
        deadline: float | None = None,
        experiment_selection: dict | None = None,
        reasoning: str | None = None,
    ) -> dict:
        request = {
                "task": task,
                "systemPrompt": system,
                "prompt": payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False),
                "maxTokens": max_tokens,
                "runId": run_id,
                "stage": stage or task,
        }
        if experiment_selection is not None:
            request["experimentSelection"] = experiment_selection
        if reasoning is not None:
            request["reasoning"] = reasoning
        if deadline is None:
            return self.request("generate", request)
        descriptor = self.ensure()
        remaining = deadline - time.time()
        if remaining <= 0:
            raise AgentServiceError("timeout", "场景判断超过等待上限。")
        request["deadline"] = int(deadline * 1000)
        return self._request(descriptor, "generate", request, timeout=remaining)

    def step(self, task, system, messages, tools, *, max_tokens=8192, run_id=None, stage=None):
        return self.request("generate", {
            "task": task, "systemPrompt": system,
            "prompt": json.dumps(messages, ensure_ascii=False),
            "messages": messages, "tools": tools,
            "maxTokens": max_tokens, "runId": run_id, "stage": stage or task,
        })

    def progress(self, run_id: str) -> dict:
        descriptor = self._descriptor()
        return (
            self._request(descriptor, "progress/" + run_id, None, timeout=1) if descriptor else {}
        )

    def configuration_signature(self, task: str) -> str:
        settings = self.request("config")["settings"]
        from .model_routing import model_task

        task = model_task(settings, task)
        override = settings["overrides"].get(task)
        selections = [
            (
                override or settings["defaultConnectionId"],
                settings.get("overrideModelIds", {}).get(task)
                if override
                else settings.get("defaultModelId"),
            )
        ]
        if settings["fallback"]["enabled"]:
            selections.append(
                (
                    settings["fallback"]["connectionId"],
                    settings["fallback"].get("modelId"),
                )
            )
        # Connection revisions change on edits/disconnects, not on usage/status or OAuth refresh.
        connections = [
            {
                **{
                    k: c.get(k)
                    for k in (
                        "id",
                        "revision",
                        "providerId",
                        "modelId",
                        "authType",
                        "baseUrl",
                        "api",
                        "contextWindow",
                        "maxTokens",
                        "imageModelIds",
                    )
                },
                "modelId": model_id or c["modelId"],
                "reasoning": settings.get("overrideReasoning", {}).get(task),
            }
            for identifier, model_id in selections
            for c in settings["connections"]
            if c["id"] == identifier
        ]
        return hashlib.sha256(json.dumps(connections, sort_keys=True).encode()).hexdigest()


def install_runtime() -> int:
    return install_runtime_dependencies()
