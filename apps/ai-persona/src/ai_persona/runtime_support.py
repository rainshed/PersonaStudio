"""Install the bundled, pinned model adapter outside the Python installation.

The cache contains executable dependencies only. Account data continues to live in
AI_PERSONA_MODEL_DATA_DIR (or the existing default); it is never read or changed
by this module. Each bundle revision receives its own cache directory.
"""

from __future__ import annotations

import fcntl
import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
import uuid
from pathlib import Path
from typing import Any

MIN_NODE_VERSION = (22, 19, 0)
RUNTIME_MARKER = ".persona-runtime.json"
DEPENDENCY_MANIFEST = "node_modules/@earendil-works/pi-ai/package.json"


def bundled_runtime() -> Path:
    return Path(__file__).parent / "model_runtime"


def _bundle_files(source: Path) -> list[Path]:
    files = []
    for parent, directories, names in os.walk(source):
        directories[:] = [name for name in directories
                          if name not in {"node_modules", "tests", "__pycache__"}]
        files.extend(Path(parent) / name for name in names if name != RUNTIME_MARKER)
    return sorted(files)


def runtime_fingerprint(source: Path | None = None) -> str:
    """Fingerprint source and lockfile, independent of install path and tests."""
    source = source or bundled_runtime()
    digest = hashlib.sha256()
    for path in _bundle_files(source):
        digest.update(path.relative_to(source).as_posix().encode())
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()[:20]


def runtime_directory() -> Path:
    """Return the selected runtime location without creating any directories."""
    if override := os.environ.get("AI_PERSONA_MODEL_RUNTIME_DIR"):
        return Path(override).expanduser().resolve()
    if override := os.environ.get("AI_PERSONA_MODEL_RUNTIME_CACHE_DIR"):
        cache = Path(override).expanduser()
    else:
        cache = Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache")
        cache = cache.expanduser() / "ai-persona" / "model-runtime"
    return (cache / runtime_fingerprint()).resolve()


def runtime_environment() -> dict[str, str]:
    """Make npm's node shebang honor an explicitly selected Node executable."""
    env = dict(os.environ)
    if override := env.get("AI_PERSONA_NODE"):
        node = shutil.which(str(Path(override).expanduser()))
        if node:
            env["PATH"] = str(Path(node).parent) + os.pathsep + env.get("PATH", "")
    return env


def tool_diagnostic(name: str) -> dict[str, Any]:
    """Inspect node/npm without starting a daemon or inspecting credentials."""
    requested = os.environ.get(f"AI_PERSONA_{name.upper()}") or name
    path = shutil.which(str(Path(requested).expanduser()))
    result: dict[str, Any] = {"name": name, "ok": False, "path": path, "version": None}
    if not path:
        result["message"] = (
            f"找不到 {requested}。请安装 Node.js 22.19 或更新版本（包含 npm），"
            f"或检查 AI_PERSONA_{name.upper()}。"
        )
        return result
    try:
        completed = subprocess.run(
            [path, "--version"], capture_output=True, text=True, timeout=10,
            env=runtime_environment(),
        )
        version = completed.stdout.strip()
        match = re.fullmatch(r"v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?", version)
        if completed.returncode or not match:
            result["message"] = f"无法读取 {name} 版本，请检查 AI_PERSONA_{name.upper()}。"
            return result
        result["version"] = version
        if name == "node" and tuple(map(int, match.groups())) < MIN_NODE_VERSION:
            result["message"] = f"当前 Node.js 为 {version}，模型服务需要 22.19 或更新版本。"
            return result
        result.update(ok=True, message=f"{name} {version} 可用。")
    except (OSError, subprocess.SubprocessError) as exc:
        result["message"] = f"无法运行 {name}（{type(exc).__name__}），请检查安装和执行权限。"
    return result


def _runtime_ready(directory: Path, fingerprint: str) -> bool:
    try:
        marker = json.loads((directory / RUNTIME_MARKER).read_text())
        manifest = json.loads((directory / "package.json").read_text())
        dependency = json.loads((directory / DEPENDENCY_MANIFEST).read_text())
        return (
            marker.get("fingerprint") == fingerprint
            and runtime_fingerprint(directory) == fingerprint
            and (directory / "daemon.mjs").is_file()
            and dependency.get("version") == manifest["dependencies"]["@earendil-works/pi-ai"]
        )
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return False


def runtime_diagnostics() -> dict[str, Any]:
    """Read-only, JSON-serializable installation checks for the doctor command."""
    fingerprint = runtime_fingerprint()
    directory = runtime_directory()
    installed = _runtime_ready(directory, fingerprint)
    checks = [tool_diagnostic("node"), tool_diagnostic("npm"), {
        "name": "model_runtime", "ok": installed, "path": str(directory),
        "version": fingerprint,
        "message": (
            "固定版本的模型运行依赖已安装。" if installed
            else "模型运行依赖尚未安装或需要更新；请运行 ai-persona models-install。"
        ),
    }]
    return {"ok": all(check["ok"] for check in checks),
            "runtime_directory": str(directory), "fingerprint": fingerprint, "checks": checks}


def install_runtime_dependencies() -> int:
    """Install into staging, then publish a complete runtime under a file lock."""
    node, npm = tool_diagnostic("node"), tool_diagnostic("npm")
    for check in (node, npm):
        if not check["ok"]:
            raise SystemExit(check["message"])
    source, directory = bundled_runtime(), runtime_directory()
    fingerprint = runtime_fingerprint(source)
    # Never install into the package or an ancestor containing the bundled code.
    package_root = source.resolve().parent
    if (directory == package_root or directory in package_root.parents
            or package_root in directory.parents):
        raise SystemExit("模型运行目录不能覆盖 Python 安装目录，请更改 AI_PERSONA_MODEL_RUNTIME_DIR。")
    directory.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock_path = directory.parent / f".{directory.name}.install.lock"
    with lock_path.open("a") as lock:
        lock_path.chmod(0o600)
        fcntl.flock(lock, fcntl.LOCK_EX)
        if _runtime_ready(directory, fingerprint):
            return 0
        # An override is not authorization to replace an unrelated directory.
        if directory.exists() and (
            not directory.is_dir()
            or (any(directory.iterdir()) and not (directory / RUNTIME_MARKER).is_file())
        ):
            raise SystemExit(
                "模型运行目录包含非托管文件，请将 AI_PERSONA_MODEL_RUNTIME_DIR 指向新的空目录。"
            )
        stage = Path(tempfile.mkdtemp(prefix=f".{directory.name}.install-", dir=directory.parent))
        retired: Path | None = None
        published = False
        try:
            for path in _bundle_files(source):
                destination = stage / path.relative_to(source)
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(path, destination)
            try:
                completed = subprocess.run(
                    [npm["path"], "ci", "--omit=dev", "--ignore-scripts"],
                    cwd=stage, env=runtime_environment(),
                )
            except OSError as exc:
                raise SystemExit(f"无法安装模型依赖（{type(exc).__name__}），请检查 npm。") from None
            if completed.returncode:
                return completed.returncode
            (stage / RUNTIME_MARKER).write_text(json.dumps({"fingerprint": fingerprint}) + "\n")
            if not _runtime_ready(stage, fingerprint):
                raise SystemExit("npm 未生成完整的固定版本依赖，请重新运行 ai-persona models-install。")
            if directory.exists():
                retired = directory.with_name(f".{directory.name}.previous-{uuid.uuid4().hex}")
                directory.rename(retired)
            try:
                stage.rename(directory)
                published = True
            except OSError:
                if retired is not None:
                    retired.rename(directory)
                    retired = None
                raise
        finally:
            if stage.exists():
                shutil.rmtree(stage)
            if retired is not None and published:
                shutil.rmtree(retired)
    return 0
