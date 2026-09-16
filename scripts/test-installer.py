#!/usr/bin/env python3
"""Exercise the generated installer without accessing GitHub or real user state."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import tarfile
import tempfile
from pathlib import Path
from urllib.request import ProxyHandler, build_opener


def run(
    installer: Path,
    archive: Path,
    root: Path,
    bin_dir: Path,
    *,
    check: bool = True,
    extra_env: dict[str, str] | None = None,
    options: tuple[str, ...] = (),
):
    env = {key: value for key, value in os.environ.items()
           if not key.startswith(("AI_PERSONA_", "PAPER_RADAR_"))
           and key not in {"PYTHONPATH", "VIRTUAL_ENV", "XDG_CONFIG_HOME", "XDG_DATA_HOME"}}
    env.update({
        "AI_PERSONA_INSTALL_ARCHIVE": str(archive),
        "AI_PERSONA_INSTALL_ROOT": str(root),
        "AI_PERSONA_BIN_DIR": str(bin_dir),
        "HOME": str(root.parent / "home"),
        "AI_PERSONA_CONFIG": str(root.parent / "config.toml"),
        "PAPER_RADAR_HOME": str(root.parent / "radar-data"),
    })
    env.update(extra_env or {})
    result = subprocess.run(
        [str(installer), *options], env=env, text=True, capture_output=True, check=False,
        timeout=600,
    )
    if check and result.returncode:
        raise AssertionError(f"installer failed\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}")
    return result


def seed_old_version(root: Path, *, running: bool = False) -> Path:
    old = root / "versions/v0.0.1"
    launcher = old / "scripts/ai-persona"
    launcher.parent.mkdir(parents=True)
    launcher.write_text(
        "#!/bin/sh\n"
        "case \"${1:-}\" in\n"
        "  --version) echo 'AI Persona 0.0.1 (PersonaStudio)' ;;\n"
        f"  status) echo '{{\"running\": {str(running).lower()}}}' ;;\n"
        "  learning) echo '{\"worker\": {\"running\": false}}' ;;\n"
        "  remote) echo '{\"running\": false}' ;;\n"
        "  *) exit 0 ;;\n"
        "esac\n"
    )
    launcher.chmod(0o755)
    root.mkdir(parents=True, exist_ok=True)
    (root / "current").symlink_to(old)
    return old


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dist-dir", type=Path, required=True)
    args = parser.parse_args()
    # Share only downloaded tooling caches; application state stays isolated.
    os.environ.setdefault("UV_CACHE_DIR", subprocess.check_output(["uv", "cache", "dir"], text=True).strip())
    os.environ.setdefault("UV_PYTHON_INSTALL_DIR", subprocess.check_output(["uv", "python", "dir"], text=True).strip())
    os.environ.setdefault("npm_config_cache", str(Path.home() / ".npm"))
    dist = args.dist_dir.resolve()
    manifest = json.loads((dist / "release-manifest.json").read_text())
    assert manifest["platforms"] == ["macos"]
    archive = dist / manifest["archive"]
    installer = dist / "install.sh"
    radar_archive = dist / manifest["components"]["paper-radar"]["archive"]
    with tarfile.open(archive) as base:
        assert not any("/apps/paper-radar/" in name for name in base.getnames())
    with tarfile.open(radar_archive) as radar:
        assert any(name.endswith("web/dist/client/index.html") for name in radar.getnames())
        assert any(name.endswith("paper-radar/THIRD_PARTY_LICENSES.txt") for name in radar.getnames())
        assert not any("node_modules" in name or "/.runtime/" in name for name in radar.getnames())
    with tempfile.TemporaryDirectory(prefix="personastudio-installer-") as directory:
        temporary = Path(directory)
        root = temporary / "data with 'quote/ai-persona"
        bin_dir = temporary / "bin with 'quote"
        first = run(installer, archive, root, bin_dir)
        assert "installed successfully" in first.stdout
        isolated_env = dict(os.environ)
        isolated_env.update({"HOME": str(temporary / "home"), "PYTHONPATH": "/must/not/leak"})
        reported = subprocess.check_output(
            [str(bin_dir / "ai-persona"), "--version"], text=True, env=isolated_env
        )
        assert manifest["version"] in reported
        current = (root / "current").resolve()
        second = run(installer, archive, root, bin_dir)
        assert "already installed" in second.stdout
        assert (root / "current").resolve() == current
        mcp = subprocess.run(
            [str(bin_dir / "ai-persona-mcp"), "--help"],
            text=True,
            capture_output=True,
            timeout=30,
            check=False,
            env=isolated_env,
        )
        assert mcp.returncode == 0, mcp.stderr
        assert not (current / "runtime/node").exists()
        assert not (bin_dir / "paper-radar").exists()
        assert json.loads((current / "installation.json").read_text())["components"] == ["ai-persona"]

        extra = {"PAPER_RADAR_INSTALL_ARCHIVE": str(radar_archive),
                 "PERSONASTUDIO_INSTALLER": str(installer)}
        # The management command exercises same-version add/remove without requiring Node on PATH.
        print("Checking add/remove, stable discovery and data preservation…", flush=True)
        added = run(bin_dir / "personastudio", archive, root, bin_dir,
                    options=("install", "paper-radar"), extra_env=extra)
        assert "AI Persona + Paper Radar" in added.stdout
        combined = (root / "current").resolve()
        assert combined != current and current.is_dir()
        assert (combined / "runtime/node/bin/node").is_file()
        assert json.loads((combined / "installation.json").read_text())["components"] == ["ai-persona", "paper-radar"]
        # Both ordinary reinstall and the public update command retain the choice.
        run(installer, archive, root, bin_dir, extra_env=extra)
        run(bin_dir / "personastudio", archive, root, bin_dir, options=("update",), extra_env=extra)
        assert (root / "current").resolve() == combined
        saved = root.parent / "radar-data/data/keep-me.txt"
        saved.parent.mkdir(parents=True, exist_ok=True)
        saved.write_text("research data")
        workspace = root.parent / "Existing Persona"
        shutil.copytree(current / "apps/ai-persona/examples/demo-persona/persona-data", workspace / "persona-data")
        (workspace / "persona-state").mkdir()
        (root.parent / "config.toml").write_text(f'[defaults]\nworkspace = {json.dumps(str(workspace))}\n')
        # Start an actual installed server, then remove it while idle. Removal stops it.
        started = run(bin_dir / "paper-radar", archive, root, bin_dir,
                      options=("start", "--port", "0", "--no-open"))
        try:
            assert started.stdout.strip(), f"Radar start returned no status: {started.stderr}"
            state = json.loads(started.stdout)
            assert state["running"]
            with build_opener(ProxyHandler({})).open(state["url"].rstrip("/") + "/api/persona/settings", timeout=10) as response:
                settings = json.load(response)
            assert settings["draft"]["workspace"] == str(workspace.resolve())
            assert settings["draft"]["executable"] == str(bin_dir / "ai-persona-mcp")
            run(bin_dir / "personastudio", archive, root, bin_dir,
                options=("remove", "paper-radar"), extra_env=extra)
            assert (root / "current").resolve() == current
            assert not (bin_dir / "paper-radar").exists()
            assert saved.read_text() == "research data"
            assert combined.is_dir()
        finally:
            run(combined / "scripts/paper-radar", archive, root, bin_dir, options=("stop",), check=False)
        run(bin_dir / "personastudio", archive, root, bin_dir,
            options=("install", "paper-radar"), extra_env=extra)
        assert saved.read_text() == "research data"

        print("Checking fresh combined installation and remembered upgrades…", flush=True)
        fresh_root, fresh_bin = temporary / "full/data", temporary / "full/bin"
        run(installer, archive, fresh_root, fresh_bin, options=("--with-paper-radar",), extra_env=extra)
        assert (fresh_bin / "paper-radar").is_file()
        fresh_current = (fresh_root / "current").resolve()
        # Model an older combined release without copying its dependency tree.
        older_combined = fresh_root / "versions/v0.0.1-radar"
        fresh_current.rename(older_combined)
        (fresh_root / "current").unlink()
        (fresh_root / "current").symlink_to(older_combined)
        before = run(fresh_bin / "paper-radar", archive, fresh_root, fresh_bin,
                     options=("start", "--port", "0", "--no-open"))
        try:
            run(installer, archive, fresh_root, fresh_bin, extra_env=extra)
            assert (fresh_root / "current").resolve().name.endswith("-radar")
            assert older_combined.is_dir()
            after = run(fresh_bin / "paper-radar", archive, fresh_root, fresh_bin, options=("status",))
            assert json.loads(after.stdout)["running"]
            assert json.loads(after.stdout)["instance_id"] != json.loads(before.stdout)["instance_id"]
        finally:
            run(fresh_bin / "paper-radar", archive, fresh_root, fresh_bin, options=("stop",), check=False)

        # Force a new Radar restart failure and verify actual old-server recovery.
        print("Checking running Radar update and restart rollback…", flush=True)
        candidate_script = fresh_current / "scripts/paper-radar"
        working_script = candidate_script.read_text()
        candidate_script.write_text(working_script.replace("set -eu", 'set -eu\n[ "${1:-}" != start ] || exit 19'))
        (fresh_root / "current").unlink()
        (fresh_root / "current").symlink_to(older_combined)
        try:
            run(fresh_bin / "paper-radar", archive, fresh_root, fresh_bin,
                options=("start", "--port", "0", "--no-open"))
            rejected = run(installer, archive, fresh_root, fresh_bin, extra_env=extra, check=False)
            assert rejected.returncode and "previous version remains selected" in rejected.stderr
            assert (fresh_root / "current").resolve() == older_combined.resolve()
            recovered = run(fresh_bin / "paper-radar", archive, fresh_root, fresh_bin, options=("status",))
            assert json.loads(recovered.stdout)["running"]
        finally:
            candidate_script.write_text(working_script)
            run(fresh_bin / "paper-radar", archive, fresh_root, fresh_bin, options=("stop",), check=False)

        # Failed optional downloads must leave the active Persona and commands untouched.
        run(installer, archive, root, bin_dir, options=("--without-paper-radar",), extra_env=extra)
        bad_extra = {**extra, "PAPER_RADAR_INSTALL_ARCHIVE": str(archive)}
        failure_root, failure_bin = temporary / "optional-fail/data", temporary / "optional-fail/bin"
        run(installer, archive, failure_root, failure_bin)
        prior = (failure_root / "current").resolve()
        rejected = run(installer, archive, failure_root, failure_bin, options=("--with-paper-radar",),
                       extra_env=bad_extra, check=False)
        assert rejected.returncode and "checksum mismatch" in rejected.stderr
        assert (failure_root / "current").resolve() == prior
        assert not (failure_bin / "paper-radar").exists()
        assert not (failure_root / f'versions/{manifest["tag"]}-radar').exists()

        # An existing lock belongs to another installer and must survive rejection.
        lock = root / ".install.lock"
        lock.mkdir()
        locked = run(installer, archive, root, bin_dir, check=False)
        assert locked.returncode and lock.is_dir()
        lock.rmdir()

        update_root, update_bin = temporary / "update/data", temporary / "update/bin"
        old = seed_old_version(update_root)
        updated = run(installer, archive, update_root, update_bin)
        assert "updated to" in updated.stdout
        assert (update_root / "current").resolve() != old.resolve()
        assert old.is_dir()

        rollback_root, rollback_bin = temporary / "rollback/data", temporary / "rollback/bin"
        rollback_old = seed_old_version(rollback_root, running=True)
        config = temporary / "rollback/config.toml"
        config.parent.mkdir(parents=True, exist_ok=True)
        config.write_text('[defaults]\nworkspace = "/missing/persona-workspace"\n')
        rolled_back = run(
            installer,
            archive,
            rollback_root,
            rollback_bin,
            check=False,
            extra_env={"AI_PERSONA_CONFIG": str(config)},
        )
        assert rolled_back.returncode != 0
        assert "previous version remains selected" in rolled_back.stderr
        assert (rollback_root / "current").resolve() == rollback_old.resolve()

        damaged = temporary / "damaged.tar.gz"
        content = archive.read_bytes()
        damaged.write_bytes(content[:-1] + bytes([content[-1] ^ 1]))
        failed = run(
            installer,
            damaged,
            temporary / "damaged-root",
            temporary / "damaged-bin",
            check=False,
        )
        assert failed.returncode != 0 and "checksum mismatch" in failed.stderr
        assert not (temporary / "damaged-root/current").exists()
    print(
        "Both installation combinations, add/remove, retained data, remembered updates, locks, rollback and checksums passed."
    )


if __name__ == "__main__":
    main()
