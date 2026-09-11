#!/usr/bin/env python3
"""Build a deterministic, installable PersonaStudio GitHub Release bundle."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import re
import subprocess
import tarfile
from pathlib import Path

import tomllib

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "apps" / "ai-persona"
INSTALLER_TEMPLATE = ROOT / "install.sh"
ROOT_FILES = {
    "CHANGELOG.md",
    "CONTRIBUTING.md",
    "LICENSE",
    "README.md",
    "README.zh-CN.md",
    "SECURITY.md",
}
APP_FILES = {
    ".python-version",
    "LICENSE",
    "pyproject.toml",
    "uv.lock",
}


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def version() -> str:
    project = tomllib.loads((APP / "pyproject.toml").read_text(encoding="utf-8"))["project"]
    value = project["version"]
    require(
        isinstance(value, str)
        and re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?", value) is not None,
        "Invalid project version",
    )
    lock = tomllib.loads((APP / "uv.lock").read_text(encoding="utf-8"))
    locked = next(p["version"] for p in lock["package"] if p["name"] == project["name"])
    require(locked == value, f"uv.lock contains {locked}, expected {value}")
    changelog = (ROOT / "CHANGELOG.md").read_text(encoding="utf-8")
    require(f"## {value}" in changelog or f"## [{value}]" in changelog,
            f"CHANGELOG.md has no section for {value}")
    return value


def tracked_files() -> list[Path]:
    output = subprocess.check_output(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        cwd=ROOT,
    )
    selected: list[Path] = []
    for raw in output.split(b"\0"):
        if not raw:
            continue
        relative = Path(os.fsdecode(raw))
        source = ROOT / relative
        # A tracked file deleted in the working tree still appears in `git ls-files --cached`.
        if not source.exists():
            continue
        parts = relative.parts
        include = (
            relative.as_posix() in ROOT_FILES
            or parts[:1] == ("docs",)
            or relative.as_posix() in {"scripts/ai-persona", "scripts/ai-persona-mcp"}
            or (
                parts[:2] == ("apps", "ai-persona")
                and (
                    Path(*parts[2:]).as_posix() in APP_FILES
                    or parts[2:3] == ("src",)
                    or parts[2:5] == ("examples", "demo-persona", "persona-data")
                )
            )
        )
        if include:
            require(source.is_file() and not source.is_symlink(),
                    f"Release input must be a regular file: {relative}")
            selected.append(relative)
    required = {
        Path("scripts/ai-persona"),
        Path("scripts/ai-persona-mcp"),
        Path("apps/ai-persona/pyproject.toml"),
        Path("apps/ai-persona/uv.lock"),
        Path("apps/ai-persona/src/ai_persona/__init__.py"),
        Path("apps/ai-persona/examples/demo-persona/persona-data/demo.json"),
    }
    require(required <= set(selected), f"Release inputs are missing: {sorted(required - set(selected))}")
    return sorted(selected, key=lambda path: path.as_posix())


def build_archive(path: Path, release_version: str, epoch: int) -> None:
    bundle_root = f"PersonaStudio-v{release_version}"
    temporary = path.with_suffix(path.suffix + ".tmp")
    with (
        temporary.open("wb") as raw,
        gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=epoch) as compressed,
        tarfile.open(fileobj=compressed, mode="w", format=tarfile.PAX_FORMAT) as archive,
    ):
        for relative in tracked_files():
            source = ROOT / relative
            info = archive.gettarinfo(str(source), f"{bundle_root}/{relative.as_posix()}")
            info.uid = info.gid = 0
            info.uname = info.gname = ""
            info.mtime = epoch
            info.mode = 0o755 if os.access(source, os.X_OK) else 0o644
            with source.open("rb") as stream:
                archive.addfile(info, stream)
    os.replace(temporary, path)


def render_installer(output: Path, release_version: str, archive: Path, archive_hash: str) -> None:
    content = INSTALLER_TEMPLATE.read_text(encoding="utf-8")
    replacements = {
        "@AI_PERSONA_RELEASE_VERSION@": f"v{release_version}",
        "@AI_PERSONA_ARCHIVE_NAME@": archive.name,
        "@AI_PERSONA_ARCHIVE_SHA256@": archive_hash,
    }
    for marker, value in replacements.items():
        require(marker in content, f"Installer template lacks {marker}")
        content = content.replace(marker, value)
    require("@AI_PERSONA_" not in content, "Installer template contains an unresolved marker")
    output.write_text(content, encoding="utf-8")
    output.chmod(0o755)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dist-dir", type=Path, default=ROOT / "dist" / "release")
    parser.add_argument("--expected-tag")
    parser.add_argument("--source-date-epoch", type=int)
    args = parser.parse_args()
    release_version = version()
    tag = f"v{release_version}"
    if args.expected_tag:
        require(args.expected_tag == tag, f"Tag {args.expected_tag} does not match {tag}")
    epoch = args.source_date_epoch
    if epoch is None:
        epoch = int(subprocess.check_output(
            ["git", "log", "-1", "--format=%ct"], cwd=ROOT, text=True
        ).strip())
    dist = args.dist_dir.resolve()
    dist.mkdir(parents=True, exist_ok=True)
    archive = dist / f"personastudio-{tag}.tar.gz"
    build_archive(archive, release_version, epoch)
    archive_hash = sha256(archive)
    manifest = dist / "release-manifest.json"
    manifest.write_text(json.dumps({
        "schema": "personastudio.release/v1",
        "version": release_version,
        "tag": tag,
        "archive": archive.name,
        "sha256": archive_hash,
        "requires_python": ">=3.12",
        "platforms": ["macos"],
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    installer = dist / "install.sh"
    render_installer(installer, release_version, archive, archive_hash)
    checksums = dist / "SHA256SUMS"
    checksums.write_text("".join(
        f"{sha256(item)}  {item.name}\n" for item in (archive, installer, manifest)
    ), encoding="utf-8")
    print(json.dumps({
        "ok": True,
        "version": release_version,
        "tag": tag,
        "archive": str(archive),
        "installer": str(installer),
        "manifest": str(manifest),
        "checksums": str(checksums),
    }, indent=2))


if __name__ == "__main__":
    main()
