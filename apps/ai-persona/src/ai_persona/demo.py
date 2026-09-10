"""Packaged Demo seed and a private, persistent copy for each local user."""
from __future__ import annotations

import fcntl
import hashlib
import json
import os
import shutil
import tempfile
from pathlib import Path

DEMO_VERSION = "condensed-matter-v4"
DEMO_PORT = 8766
MARKER = "demo.json"
ROOT_MARKER = ".ai-persona-demo.json"
DEMO_METADATA = {"schema": "ai-persona.demo/v1", "version": DEMO_VERSION}


def is_demo_data(data_root: Path) -> bool:
    # A damaged marker must never silently downgrade a Demo to a real workspace.
    return (
        (data_root / MARKER).exists() or (data_root / MARKER).is_symlink()
        or (data_root.parent / ROOT_MARKER).exists()
        or data_root.parent.absolute() == demo_root().absolute()
    )


def _check_marker(data_root: Path) -> None:
    try:
        metadata = json.loads((data_root / MARKER).read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise ValueError("Demo 标识缺失或损坏，不会使用此目录。") from exc
    if metadata != DEMO_METADATA:
        raise ValueError("Demo 版本不匹配，不会覆盖已有目录。")


def _no_symlinks(root: Path) -> None:
    if root.is_symlink() or any(p.is_symlink() for p in root.rglob("*")):
        raise ValueError("Demo 目录不能包含符号链接，以免读写正式数据。")


def demo_seed() -> Path:
    packaged = Path(__file__).parent / "demo_data"
    checkout = Path(__file__).resolve().parents[2] / "examples/demo-persona/persona-data"
    seed = packaged if packaged.is_dir() else checkout
    if not seed.is_dir():
        raise ValueError("安装包缺少 Demo 数据，请重新安装；不会回退到当前目录。")
    _no_symlinks(seed)
    _check_marker(seed)
    return seed.resolve()


def demo_root() -> Path:
    configured = os.environ.get("AI_PERSONA_DEMO_HOME")
    if configured:
        base = Path(configured).expanduser()
    else:
        data_home = Path(os.environ.get("XDG_DATA_HOME", str(Path.home() / ".local/share")))
        base = data_home.expanduser() / "ai-persona" / "demo"
    return base / DEMO_VERSION


def check_demo_paths(data_root: Path, state_root: Path | None = None) -> None:
    if not is_demo_data(data_root):
        return
    _no_symlinks(data_root.parent)
    _check_marker(data_root)
    # The distributed seed is a template, never a runtime workspace.
    if data_root.resolve() == demo_seed():
        raise ValueError("Demo 模板不可直接运行，请使用 --demo 创建独立体验副本。")
    if state_root is not None:
        expected = data_root.parent / "persona-state"
        if (state_root.resolve() != expected.resolve()
                or state_root.is_symlink() or expected.is_symlink()):
            raise ValueError("Demo 的状态目录必须位于同一个独立工作区。")
        _no_symlinks(state_root)


def prepare_demo() -> Path:
    seed = demo_seed()
    root = demo_root()
    if root.is_symlink():
        raise ValueError("Demo 工作区不能是符号链接。")
    root.parent.mkdir(parents=True, exist_ok=True)
    with (root.parent / ".initialize.lock").open("a+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if root.exists():
            _no_symlinks(root)
            _check_marker(root / "persona-data")
        else:
            staged = Path(tempfile.mkdtemp(prefix=".demo-", dir=root.parent))
            try:
                shutil.copytree(seed, staged / "persona-data")
                (staged / "persona-state").mkdir(mode=0o700)
                (staged / ROOT_MARKER).write_text(json.dumps(DEMO_METADATA), encoding="utf-8")
                staged.rename(root)
            finally:
                if staged.exists():
                    shutil.rmtree(staged)
        _no_symlinks(root)
        check_demo_paths(root / "persona-data", root / "persona-state")
        # Adopt only a validated copy made by an earlier revision of this initializer.
        if not (root / ROOT_MARKER).exists():
            (root / ROOT_MARKER).write_text(json.dumps(DEMO_METADATA), encoding="utf-8")
    return root.resolve()


def workspace_identity(data_root: Path, state_root: Path) -> str:
    value = json.dumps([str(data_root.resolve()), str(state_root.resolve())])
    return hashlib.sha256(value.encode()).hexdigest()


class DemoIsolationMiddleware:
    """Demo editing is local; host discovery, Hooks and automatic capture are disabled."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        from starlette.responses import JSONResponse

        if scope["type"] == "http":
            path = scope["path"]
            host_setup = path.startswith("/api/learning/v1/codex/") or "/setup" in path
            automatic_write = scope["method"] not in {"GET", "HEAD", "OPTIONS"} and (
                path.startswith("/api/learning/v1/")
                or path.startswith("/api/preferences/application/")
            )
            if host_setup or automatic_write:
                response = JSONResponse({"ok": False, "error": {
                    "code": "demo_isolated",
                    "message": "Demo 不接入真实会话或安装 Hook；请在正式工作区配置应用接入。",
                }}, status_code=403)
                return await response(scope, receive, send)
        await self.app(scope, receive, send)
