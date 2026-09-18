#!/usr/bin/env python3
"""Verify the published v0.1.0 -> candidate upgrade in a disposable user home.

Uses the actual published installer/archive, pinned by SHA-256. No model calls,
real Codex processes or user workspaces are used. Downloads require network access.
"""

import argparse
import hashlib
import json
import os
import socket
import subprocess
import tempfile
from pathlib import Path
from urllib.request import ProxyHandler, build_opener

LEGACY = {
    "install.sh": "c037c898912881fab2c37636fda4a7e8275996d932568ae175b7740b474bf1e4",
    "personastudio-v0.1.0.tar.gz": "66d3745303d4e5de0473cf5618e10bd7583655fc67141a121c3afb8e35253692",
}
PROBE = Path(__file__).with_name("release-upgrade-probe.py").resolve()


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def snapshot(directory):
    return {str(p.relative_to(directory)): digest(p) for p in directory.rglob("*")
            if p.is_file() and p.name not in {".lock", ".DS_Store"}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dist-dir", type=Path, required=True)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    dist = args.dist_dir.resolve()
    manifest = json.loads((dist / "release-manifest.json").read_text())
    assert manifest["version"] != "0.1.0", "Candidate must differ from the upgrade source"
    checks = []
    with tempfile.TemporaryDirectory(prefix="personastudio-upgrade-") as temporary:
        directory = Path(temporary).resolve()
        root, bin_dir = directory / "installation", directory / "bin"
        home = directory / "home"
        home.mkdir()
        env = {k: v for k, v in os.environ.items()
               if not k.startswith(("AI_PERSONA_", "PAPER_RADAR_", "PERSONASTUDIO_", "CODEX_"))
               and k not in {"HOME", "PYTHONPATH", "VIRTUAL_ENV", "XDG_CONFIG_HOME", "XDG_DATA_HOME"}}
        env.update({
            "HOME": str(home), "CODEX_HOME": str(home / ".codex"),
            "AI_PERSONA_INSTALL_ROOT": str(root), "AI_PERSONA_BIN_DIR": str(bin_dir),
            "AI_PERSONA_COMMAND": str(bin_dir / "ai-persona"),
            "AI_PERSONA_MCP_COMMAND": str(bin_dir / "ai-persona-mcp"),
            "AI_PERSONA_CONFIG": str(directory / "config.toml"),
            "AI_PERSONA_LEARNING_DIR": str(directory / "learning"),
            "AI_PERSONA_MODEL_DATA_DIR": str(directory / "models"),
            "AI_PERSONA_MODEL_RUNTIME_CACHE_DIR": str(directory / "model-runtime"),
            "AI_PERSONA_SEMANTIC_SEARCH": "0", "PAPER_RADAR_HOME": str(directory / "radar"),
            "UV_CACHE_DIR": subprocess.check_output(["uv", "cache", "dir"], text=True).strip(),
            "UV_PYTHON_INSTALL_DIR": subprocess.check_output(["uv", "python", "dir"], text=True).strip(),
            "npm_config_cache": os.environ.get("npm_config_cache", str(Path.home() / ".npm")),
        })
        if os.environ.get("PERSONASTUDIO_NODE_ARCHIVE"):
            env["PERSONASTUDIO_NODE_ARCHIVE"] = os.environ["PERSONASTUDIO_NODE_ARCHIVE"]

        def run(*command, check=True, input=None):
            result = subprocess.run(list(map(str, command)), env=env, cwd=directory,
                                    text=True, input=input, capture_output=True, timeout=600, check=False)
            if check and result.returncode:
                raise AssertionError(f"{command[0]} failed\n{result.stdout}\n{result.stderr}")
            return result

        def passed(message):
            checks.append(message)
            print(message, flush=True)

        for name, expected in LEGACY.items():
            target = directory / name
            run("curl", "-fLsS", "--retry", "3", "--max-time", "180",
                f"https://github.com/rainshed/PersonaStudio/releases/download/v0.1.0/{name}",
                "-o", target)
            assert digest(target) == expected, f"Published asset changed: {name}"
        env["AI_PERSONA_INSTALL_ARCHIVE"] = str(directory / "personastudio-v0.1.0.tar.gz")
        run("sh", directory / "install.sh")
        old = (root / "current").resolve()
        assert "0.1.0" in run(bin_dir / "ai-persona", "--version").stdout

        def probe(action="check"):
            current = (root / "current").resolve()
            run(current / "apps/ai-persona/.venv/bin/python", PROBE, action, "--directory", directory)

        probe("seed")
        data = directory / "Existing Persona/persona-data"
        baseline = snapshot(data)
        codex_home = Path(env["CODEX_HOME"])
        configs = {p: p.read_bytes() for p in [codex_home / "hooks.json", codex_home / "config.toml",
                                             Path(env["AI_PERSONA_CONFIG"])]}
        passed("Published v0.1.0 installed; knowledge, preferences, Hook and MCP baseline verified")

        def preserved():
            assert snapshot(data) == baseline, "Canonical workspace data changed"
            for path, content in configs.items():
                assert path.read_bytes() == content, f"Existing configuration changed: {path.name}"

        def running():
            state = json.loads(run(bin_dir / "ai-persona", "status").stdout)
            assert state["running"], state
            with build_opener(ProxyHandler({})).open(state["url"], timeout=20) as response:
                assert response.status == 200
            return state

        candidate_installer = dist / "install.sh"
        env.update({"AI_PERSONA_INSTALL_ARCHIVE": str(dist / manifest["archive"]),
                    "PAPER_RADAR_INSTALL_ARCHIVE": str(dist / manifest["components"]["paper-radar"]["archive"]),
                    "PERSONASTUDIO_INSTALLER": str(candidate_installer)})
        try:
            with socket.socket() as listener:
                listener.bind(("127.0.0.1", 0))
                studio_port = listener.getsockname()[1]
            run(bin_dir / "ai-persona", "start", "--port", studio_port, "--no-open")
            before = running()
            run("sh", candidate_installer)
            candidate = (root / "current").resolve()
            assert candidate != old and old.is_dir()
            assert manifest["version"] in run(bin_dir / "ai-persona", "--version").stdout
            assert running()["pid"] != before["pid"]
            assert running()["url"] == before["url"], "Upgrade changed the Studio address"
            probe()
            preserved()
            passed("Running v0.1.0 upgraded; existing data/configuration preserved; saved Hook and MCP work")

            run(bin_dir / "personastudio", "install", "paper-radar")
            radar_marker = directory / "radar/data/retained-research.txt"
            radar_marker.parent.mkdir(parents=True, exist_ok=True)
            radar_marker.write_text("Existing research must survive component changes.\n")
            run(bin_dir / "paper-radar", "start", "--port", "0", "--no-open")
            radar_state = json.loads(run(bin_dir / "paper-radar", "status").stdout)
            assert radar_state["running"]
            with build_opener(ProxyHandler({})).open(
                radar_state["url"].rstrip("/") + "/api/persona/settings", timeout=20
            ) as response:
                settings = json.load(response)
            assert settings["draft"]["workspace"] == str(data.parent)
            assert settings["draft"]["executable"] == str(bin_dir / "ai-persona-mcp")
            run(bin_dir / "personastudio", "remove", "paper-radar")
            assert not (bin_dir / "paper-radar").exists()
            assert radar_marker.read_text() == "Existing research must survive component changes.\n"
            running()
            probe()
            preserved()
            passed("Radar added, started, discovered existing Persona and removed; research and Persona retained")

            # Return to the actual old release, then force only the candidate restart to fail.
            run(bin_dir / "ai-persona", "stop")
            current = root / "current"
            current.unlink()
            current.symlink_to(old)
            run(bin_dir / "ai-persona", "start", "--port", studio_port, "--no-open")
            launcher = candidate / "scripts/ai-persona"
            original = launcher.read_text()
            try:
                launcher.write_text(original.replace("set -eu", 'set -eu\n[ "${1:-}" != start ] || exit 19', 1))
                rejected = run("sh", candidate_installer, check=False)
                assert rejected.returncode and "previous version remains selected" in rejected.stderr
                assert current.resolve() == old
                assert "0.1.0" in run(bin_dir / "ai-persona", "--version").stdout
                running()
                assert running()["url"] == before["url"], "Rollback changed the Studio address"
                probe()
                preserved()
                passed("Failed candidate restart restores real v0.1.0 service, data, Hook and MCP")
            finally:
                launcher.write_text(original)

            run("sh", candidate_installer)
            assert current.resolve() == candidate
            running()
            probe()
            preserved()
            passed("Upgrade succeeds again after rollback")
        finally:
            if (bin_dir / "paper-radar").exists():
                run(bin_dir / "paper-radar", "stop", check=False)
            run(bin_dir / "ai-persona", "stop", check=False)
            run(bin_dir / "ai-persona", "models-stop", check=False)
    report = {"ok": True, "from": "v0.1.0", "to": manifest["tag"], "assets": LEGACY, "checks": checks}
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
