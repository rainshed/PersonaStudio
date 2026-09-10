#!/usr/bin/env python3
"""Build and verify AI Persona archives and a clean installation outside the repo."""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import tarfile
import tempfile
import zipfile
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "apps" / "ai-persona"
FORBIDDEN_PARTS = {
    ".git", ".venv", "node_modules", "__pycache__", ".pytest_cache", ".ruff_cache",
    "persona-state", "backups", ".DS_Store", ".env", "runtime.json", "credentials.json",
    "accounts.json", "auth.json", "workspace.json", "browser-results",
    ".lock", ".initialize.lock", ".personastudio",
}
PACKAGE_ASSETS = {"templates", "static", "model_runtime", "demo_data", "prompts", "i18n"}
SDIST_ROOTS = {"src", "tests", "examples", "scripts", "docs"}
SDIST_FILES = {"pyproject.toml", "uv.lock", "LICENSE", ".python-version", ".gitignore", "PKG-INFO"}


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def inspect_names(names: list[str], *, wheel: bool) -> None:
    for name in names:
        path = PurePosixPath(name)
        require(not path.is_absolute() and ".." not in path.parts, f"Unsafe archive path: {name}")
        require(not FORBIDDEN_PARTS.intersection(path.parts), f"Private/runtime path in archive: {name}")
        require(not re.search(r"\.(?:sqlite3?|db|log|pyc)(?:-|$)", path.name),
                f"Generated state in archive: {name}")
        parts = path.parts
        if wheel:
            require(parts[0] == "ai_persona" or parts[0].endswith(".dist-info"),
                    f"Unexpected wheel root: {name}")
            if parts[0] == "ai_persona":
                require(path.suffix == ".py" or (len(parts) > 1 and parts[1] in PACKAGE_ASSETS),
                        f"Unexpected package asset: {name}")
                if "persona-data" in parts:
                    raise RuntimeError(f"A live workspace was packaged: {name}")
        else:
            relative = PurePosixPath(*parts[1:])
            require(relative.parts[0] in SDIST_ROOTS or relative.name in SDIST_FILES
                    or (len(relative.parts) == 1 and relative.name.startswith("README")
                        and relative.suffix == ".md"), f"Unexpected sdist content: {name}")
            if "persona-data" in parts:
                public_fixture = relative.as_posix().startswith((
                    "examples/demo-persona/persona-data/",
                    "tests/fixtures/legacy-demo/persona-data/",
                ))
                require(public_fixture,
                        f"A non-Demo workspace was packaged: {name}")


def inspect_archives(wheel: Path, sdist: Path) -> dict[str, int]:
    with zipfile.ZipFile(wheel) as archive:
        names = [name for name in archive.namelist() if not name.endswith("/")]
        inspect_names(names, wheel=True)
        for name in names:
            require(str(Path.home()).encode() not in archive.read(name),
                    f"A developer home path appears in the wheel: {name}")
        required = {
            "ai_persona/templates/base.html", "ai_persona/templates/onboarding.html",
            "ai_persona/static/app.css", "ai_persona/static/onboarding.js",
            "ai_persona/model_setup.py", "ai_persona/static/model-setup.js",
            "ai_persona/static/error-feedback.js", "ai_persona/static/error-feedback.css",
            "ai_persona/static/knowledge-map/vendor/ELK-LICENSE.md",
            "ai_persona/static/knowledge-map/vendor/D3-LICENSE",
            "ai_persona/static/vendor/HTMX-LICENSE.txt",
            "ai_persona/demo_data/demo.json", "ai_persona/demo_data/config/persona.toml",
            "ai_persona/model_runtime/package.json", "ai_persona/model_runtime/package-lock.json",
            "ai_persona/model_runtime/daemon.mjs",
            "ai_persona/extraction/mcp.py",
            "ai_persona/templates/extraction.html",
            "ai_persona/static/extraction.js",
        }
        require(required.issubset(names), f"Wheel is missing required assets: {sorted(required - set(names))}")
        require(any(name.endswith(".dist-info/licenses/LICENSE") for name in names),
                "Wheel is missing the application license")
        manifest = json.loads(archive.read("ai_persona/model_runtime/package.json"))
        lock = json.loads(archive.read("ai_persona/model_runtime/package-lock.json"))
        require(lock["packages"][""]["dependencies"] == manifest["dependencies"],
                "Bundled runtime lockfile does not match its manifest")
        wheel_count = len(names)
    with tarfile.open(sdist) as archive:
        members = archive.getmembers()
        require(all(not member.issym() and not member.islnk() for member in members),
                "Source archive contains symbolic or hard links")
        names = [member.name for member in members if member.isfile()]
        inspect_names(names, wheel=False)
        for member in members:
            if member.isfile():
                require(str(Path.home()).encode() not in archive.extractfile(member).read(),
                        f"A developer home path appears in the source archive: {member.name}")
        relative = {name.split("/", 1)[1] for name in names}
        require({"pyproject.toml", "uv.lock", "LICENSE",
                 "src/ai_persona/model_runtime/package-lock.json",
                 "examples/demo-persona/persona-data/demo.json"}.issubset(relative),
                "Source archive lacks reproducible installation or bundled Demo assets")
    return {"wheel_files": wheel_count, "sdist_files": len(names)}


def isolated_environment(directory: Path) -> dict[str, str]:
    env = {key: value for key, value in os.environ.items()
           if not key.startswith("AI_PERSONA_") and key not in {"PYTHONPATH", "VIRTUAL_ENV"}}
    env.update({
        "AI_PERSONA_CONFIG": str(directory / "config.json"),
        "AI_PERSONA_DEMO_HOME": str(directory / "demo"),
        "AI_PERSONA_MODEL_DATA_DIR": str(directory / "models"),
        "AI_PERSONA_MODEL_RUNTIME_CACHE_DIR": str(directory / "model-runtime"),
        "AI_PERSONA_LEARNING_DIR": str(directory / "learning"),
        "PYTHONNOUSERSITE": "1",
    })
    return env


INSTALLED_CHECK = r'''
import importlib.metadata, json, pathlib, socket, sys, time
from urllib.request import Request, ProxyHandler, build_opener
import ai_persona
from ai_persona import launcher
from ai_persona.model_bridge import ModelClient
from ai_persona.demo import demo_seed
from ai_persona.workspace import demo_workspace
from ai_persona.compiler import PersonaCompiler
from ai_persona.store import PersonaStore
from ai_persona.onboarding import create_setup_app
from ai_persona.web import create_app

package = pathlib.Path(ai_persona.__file__).resolve().parent
assert package.is_relative_to(pathlib.Path(sys.prefix).resolve()), package
seed = demo_seed()
assert seed == package / "demo_data", seed
work = demo_workspace()
store = PersonaStore(work.data_root).load()
assert store.config is not None and work.is_demo
PersonaCompiler(work.data_root, work.state_root).build()
app = create_app(work.data_root, work.state_root)
assert any(getattr(route, "path", None) == "/knowledge" for route in app.routes)
assert any(getattr(route, "path", None) == "/" for route in create_setup_app().routes)
entries = importlib.metadata.distribution("ai-persona").entry_points
assert {"ai-persona", "ai-persona-mcp"}.issubset({entry.name for entry in entries})
with socket.socket() as occupied:
    occupied.bind(("127.0.0.1", 0))
    occupied.listen(8)
    launcher.DEMO_PORT = occupied.getsockname()[1]
    try:
        started = launcher.start_ui(work, open_browser=False)
        assert started["running"]
        assert started["url"] != f"http://127.0.0.1:{launcher.DEMO_PORT}"
        repeated = launcher.start_ui(work, open_browser=False)
        assert repeated["already_running"] and repeated["pid"] == started["pid"]
        opener = build_opener(ProxyHandler({}))
        def model_request(route, body=None):
            request = Request(started["url"] + "/api/models/" + route,
                data=None if body is None else json.dumps(body).encode(),
                headers={"Origin": started["url"], "X-AI-Persona": "1", "Content-Type": "application/json"})
            with opener.open(request, timeout=15) as response:
                return json.load(response)
        assert model_request("runtime")["status"] == "not_installed"
        assert model_request("runtime/install", {})["status"] == "installing"
        deadline = time.monotonic() + 320
        while time.monotonic() < deadline:
            state = model_request("runtime")
            if state["status"] != "installing":
                break
            time.sleep(.2)
        assert state["status"] == "ready", state
        assert model_request("config")["settings"]["connections"] == []
    finally:
        launcher.stop_ui(work)
        ModelClient.for_workspace(work.data_root, work.state_root).stop()
print(json.dumps({"installed_version": importlib.metadata.version("ai-persona"),
                  "bundled_demo": True, "workspace_valid": True,
                  "occupied_port_start_and_reuse": True,
                  "web_component_install_and_fresh_model_settings": True,
                  "knowledge_and_setup_routes": True}))
'''


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dist-dir", type=Path, default=APP / "dist")
    parser.add_argument("--skip-build", action="store_true")
    parser.add_argument("--python", default="3.12", help="Python version for clean wheel installation")
    args = parser.parse_args()
    uv = shutil.which("uv")
    require(uv is not None, "Install uv before running release verification.")
    dist = args.dist_dir.resolve()
    if not args.skip_build:
        subprocess.run([uv, "build", str(APP), "--out-dir", str(dist)], check=True)
    wheels, sdists = sorted(dist.glob("ai_persona-*.whl")), sorted(dist.glob("ai_persona-*.tar.gz"))
    require(len(wheels) == len(sdists) == 1,
            "Use a clean dist directory containing exactly one AI Persona wheel and source archive.")
    report = inspect_archives(wheels[0], sdists[0])
    with tempfile.TemporaryDirectory(prefix="personastudio-release-") as temporary:
        directory = Path(temporary).resolve()
        env = isolated_environment(directory)
        venv = directory / "venv"
        subprocess.run([uv, "venv", "--python", args.python, str(venv)], cwd=directory, env=env, check=True)
        python = venv / "bin" / "python"
        subprocess.run([uv, "pip", "install", "--python", str(python), str(wheels[0])],
                       cwd=directory, env=env, check=True)
        subprocess.run([str(python), "-c", INSTALLED_CHECK], cwd=directory, env=env, check=True)
        subprocess.run([str(python), "-m", "ai_persona", "validate", "--demo"],
                       cwd=directory, env=env, check=True)
        subprocess.run([str(python), "-m", "ai_persona", "doctor", "--demo"],
                       cwd=directory, env=env, check=True)
    print(json.dumps({"ok": True, **report, "clean_wheel_install": True}, indent=2))


if __name__ == "__main__":
    main()
