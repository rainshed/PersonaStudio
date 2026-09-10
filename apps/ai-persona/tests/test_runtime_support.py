"""Runtime installation must survive Python upgrades without touching accounts."""

from __future__ import annotations

import json
import shutil
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace

import pytest

from ai_persona import runtime_support as runtime
from ai_persona.model_bridge import ModelClient


@pytest.fixture
def bundle(tmp_path, monkeypatch):
    source = tmp_path / "python-package" / "model_runtime"
    source.mkdir(parents=True)
    (source / "package.json").write_text(json.dumps({
        "dependencies": {"@earendil-works/pi-ai": "0.85.1"},
    }))
    (source / "package-lock.json").write_text('{"lockfileVersion": 3}')
    (source / "daemon.mjs").write_text("// test runtime\n")
    monkeypatch.setattr(runtime, "bundled_runtime", lambda: source)
    monkeypatch.setenv("AI_PERSONA_MODEL_RUNTIME_CACHE_DIR", str(tmp_path / "cache"))
    monkeypatch.delenv("AI_PERSONA_MODEL_RUNTIME_DIR", raising=False)
    return source


@pytest.fixture
def installation(bundle, monkeypatch):
    calls = []
    monkeypatch.setattr(runtime, "tool_diagnostic", lambda name: {
        "name": name, "ok": True, "path": f"/fixture/{name}", "version": "24.0.0",
    })

    def npm_install(command, *, cwd, env):
        calls.append((command, cwd))
        assert cwd != runtime.runtime_directory()
        assert cwd != bundle
        manifest = cwd / runtime.DEPENDENCY_MANIFEST
        manifest.parent.mkdir(parents=True)
        manifest.write_text('{"version": "0.85.1"}')
        return SimpleNamespace(returncode=0)

    monkeypatch.setattr(runtime.subprocess, "run", npm_install)
    return calls


def test_runtime_fingerprint_tracks_shipped_code_and_lockfile_only(bundle):
    fingerprint = runtime.runtime_fingerprint()
    (bundle / "tests").mkdir()
    (bundle / "tests" / "test.mjs").write_text("test change")
    (bundle / "node_modules").mkdir()
    (bundle / "node_modules" / "installed.json").write_text("{}")
    assert runtime.runtime_fingerprint() == fingerprint
    (bundle / "package-lock.json").write_text('{"lockfileVersion": 3, "changed": true}')
    assert runtime.runtime_fingerprint() != fingerprint


def test_default_cache_and_explicit_override_are_read_only(bundle, tmp_path, monkeypatch):
    monkeypatch.delenv("AI_PERSONA_MODEL_RUNTIME_CACHE_DIR")
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path / "xdg"))
    expected = tmp_path / "xdg" / "ai-persona" / "model-runtime" / runtime.runtime_fingerprint()
    assert runtime.runtime_directory() == expected
    assert not expected.parent.exists()
    monkeypatch.setenv("AI_PERSONA_MODEL_RUNTIME_DIR", str(tmp_path / "explicit"))
    assert runtime.runtime_directory() == tmp_path / "explicit"
    assert not (tmp_path / "explicit").exists()


def test_pinned_install_is_staged_idempotent_and_survives_python_reinstall(
    bundle, installation, tmp_path, monkeypatch,
):
    target = runtime.runtime_directory()
    assert runtime.install_runtime_dependencies() == 0
    assert installation[0][0] == ["/fixture/npm", "ci", "--omit=dev", "--ignore-scripts"]
    assert (target / runtime.DEPENDENCY_MANIFEST).is_file()
    assert not (bundle / "node_modules").exists()
    replacement = tmp_path / "reinstalled-python-package" / "model_runtime"
    shutil.copytree(bundle, replacement)
    monkeypatch.setattr(runtime, "bundled_runtime", lambda: replacement)
    shutil.rmtree(bundle.parent)
    assert runtime.runtime_directory() == target
    assert runtime.install_runtime_dependencies() == 0
    assert len(installation) == 1
    assert runtime.runtime_diagnostics()["ok"]


def test_concurrent_installers_publish_one_complete_runtime(bundle, installation):
    with ThreadPoolExecutor(max_workers=2) as workers:
        results = list(workers.map(lambda _: runtime.install_runtime_dependencies(), range(2)))
    assert results == [0, 0]
    assert len(installation) == 1
    assert runtime.runtime_diagnostics()["ok"]
    assert not list(runtime.runtime_directory().parent.glob("*.install-*"))


def test_diagnostics_detect_damaged_runtime_sources_and_install_repairs_them(bundle, installation):
    runtime.install_runtime_dependencies()
    target = runtime.runtime_directory()
    (target / "daemon.mjs").unlink()
    assert not runtime.runtime_diagnostics()["ok"]
    runtime.install_runtime_dependencies()
    assert runtime.runtime_diagnostics()["ok"]
    assert len(installation) == 2


def test_failed_install_leaves_previous_runtime_and_accounts_untouched(
    bundle, installation, tmp_path, monkeypatch,
):
    target = tmp_path / "explicit"
    monkeypatch.setenv("AI_PERSONA_MODEL_RUNTIME_DIR", str(target))
    accounts = tmp_path / "accounts"
    accounts.mkdir()
    (accounts / "credentials.json").write_text("keep this private fixture")
    monkeypatch.setenv("AI_PERSONA_MODEL_DATA_DIR", str(accounts))
    assert runtime.install_runtime_dependencies() == 0
    old_marker = (target / runtime.RUNTIME_MARKER).read_text()
    (bundle / "daemon.mjs").write_text("// newer runtime")
    monkeypatch.setattr(runtime.subprocess, "run", lambda *a, **kw: SimpleNamespace(returncode=7))
    assert runtime.install_runtime_dependencies() == 7
    assert (target / runtime.RUNTIME_MARKER).read_text() == old_marker
    assert (target / runtime.DEPENDENCY_MANIFEST).is_file()
    assert (accounts / "credentials.json").read_text() == "keep this private fixture"
    assert ModelClient().directory == accounts
    assert not list(target.parent.glob(".explicit.install-*"))


def test_publish_failure_restores_previous_runtime(bundle, installation, tmp_path, monkeypatch):
    target = tmp_path / "explicit"
    monkeypatch.setenv("AI_PERSONA_MODEL_RUNTIME_DIR", str(target))
    runtime.install_runtime_dependencies()
    (bundle / "daemon.mjs").write_text("// updated")
    rename = Path.rename

    def fail_publish(path, destination):
        if ".install-" in path.name:
            raise OSError("simulated publish failure")
        return rename(path, destination)

    monkeypatch.setattr(Path, "rename", fail_publish)
    with pytest.raises(OSError, match="simulated publish failure"):
        runtime.install_runtime_dependencies()
    assert (target / "daemon.mjs").read_text() == "// test runtime\n"
    assert (target / runtime.DEPENDENCY_MANIFEST).is_file()


def test_runtime_override_never_replaces_unmanaged_data(bundle, installation, tmp_path, monkeypatch):
    target = tmp_path / "personal-data"
    target.mkdir()
    (target / "credentials.json").write_text("fixture")
    monkeypatch.setenv("AI_PERSONA_MODEL_RUNTIME_DIR", str(target))
    with pytest.raises(SystemExit, match="非托管文件"):
        runtime.install_runtime_dependencies()
    assert (target / "credentials.json").read_text() == "fixture"
    assert not installation


def test_runtime_override_never_installs_inside_bundled_package(bundle, installation, monkeypatch):
    monkeypatch.setenv("AI_PERSONA_MODEL_RUNTIME_DIR", str(bundle / "installed"))
    with pytest.raises(SystemExit, match="Python 安装目录"):
        runtime.install_runtime_dependencies()
    assert not installation


@pytest.mark.parametrize("node_version, valid", [("v22.18.0", False), ("v22.19.0", True),
                                                   ("v24.13.0", True)])
def test_node_version_and_executable_override(bundle, monkeypatch, node_version, valid):
    monkeypatch.setenv("AI_PERSONA_NODE", "/selected/bin/node")
    monkeypatch.setattr(runtime.shutil, "which", lambda name: name)
    calls = []

    def version(command, **kwargs):
        calls.append((command, kwargs))
        return SimpleNamespace(returncode=0, stdout=node_version)

    monkeypatch.setattr(runtime.subprocess, "run", version)
    diagnostic = runtime.tool_diagnostic("node")
    assert diagnostic["ok"] is valid
    assert calls[0][0] == ["/selected/bin/node", "--version"]
    assert calls[0][1]["env"]["PATH"].startswith("/selected/bin:")


def test_diagnostics_require_no_installation_or_account_access(bundle, monkeypatch, tmp_path):
    monkeypatch.setattr(runtime.shutil, "which", lambda _: None)
    monkeypatch.setenv("AI_PERSONA_MODEL_DATA_DIR", str(tmp_path / "private-accounts"))
    report = runtime.runtime_diagnostics()
    assert report["ok"] is False
    assert {check["name"] for check in report["checks"]} == {"node", "npm", "model_runtime"}
    assert "models-install" in report["checks"][-1]["message"]
    assert not runtime.runtime_directory().parent.exists()
    assert not (tmp_path / "private-accounts").exists()
    json.dumps(report)
