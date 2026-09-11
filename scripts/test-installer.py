#!/usr/bin/env python3
"""Exercise the generated installer without accessing GitHub or real user state."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import tempfile
from pathlib import Path


def run(
    installer: Path,
    archive: Path,
    root: Path,
    bin_dir: Path,
    *,
    check: bool = True,
    extra_env: dict[str, str] | None = None,
):
    env = dict(os.environ)
    env.update({
        "AI_PERSONA_INSTALL_ARCHIVE": str(archive),
        "AI_PERSONA_INSTALL_ROOT": str(root),
        "AI_PERSONA_BIN_DIR": str(bin_dir),
        "HOME": str(root.parent / "home"),
    })
    env.update(extra_env or {})
    result = subprocess.run(
        [str(installer)], env=env, text=True, capture_output=True, check=False
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
    dist = args.dist_dir.resolve()
    manifest = json.loads((dist / "release-manifest.json").read_text())
    archive = dist / manifest["archive"]
    installer = dist / "install.sh"
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
        "Fresh installation, idempotent update, stable commands, rollback and checksum failure passed."
    )


if __name__ == "__main__":
    main()
