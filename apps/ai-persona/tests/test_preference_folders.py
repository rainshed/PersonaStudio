from __future__ import annotations

import hashlib
import io
import json
import shutil
import zipfile
from pathlib import Path
from urllib.parse import urlencode

import pytest
from fastapi.testclient import TestClient
from persona_fixture import demo_workspace

from ai_persona.compiler import PersonaCompiler
from ai_persona.human_edits import HumanEditService
from ai_persona.materials import MaterialSourceError, SourceAttachment
from ai_persona.models import PreferenceExample
from ai_persona.preference_sources import (
    folder_members,
    is_folder_source,
    stage_folder_source,
    validate_folder_paths,
)
from ai_persona.store import PersonaStore
from ai_persona.web import create_app


@pytest.fixture
def folder_workspace(tmp_path):
    data, state = tmp_path / "data", tmp_path / "state"
    shutil.copytree(demo_workspace().data_root, data)
    PersonaCompiler(data, state).build()
    context = HumanEditService(data, state).create_record("preference_context", {
        "name": "Folder samples", "key": "folder.test", "description": "Reference a project",
    }).target_id
    with TestClient(create_app(data, state)) as client:
        yield data, state, context, client


def upload_folder(client, context, entries, **overrides):
    values = {
        "upload_kind": "folder", "folder_paths": json.dumps(list(entries)),
        "title": "完整笔记", "example_type": "positive", "context_refs": context,
        "condition": "撰写笔记时", "reasons": "同时参考正文与配图",
        "reason": "补充完整样本",
        "return_to": "/preferences?" + urlencode({"context": context}), **overrides,
    }
    return client.post("/preferences/examples/proposals", data=values, files=[
        ("folder_files", (Path(name).name, content, "application/octet-stream"))
        for name, content in entries.items()
    ], follow_redirects=False)


def test_folder_upload_preserves_tree_bytes_and_one_sample(folder_workspace):
    data, _, context, client = folder_workspace
    entries = {"学术笔记/note.md": b"# Notes\n![plot](images/plot.png)",
               "学术笔记/images/plot.png": b"image bytes",
               "学术笔记/results/note.md": b"Other note",
               "学术笔记/empty.txt": b"",
               "学术笔记/<draft> #1?.html": b"<script>alert(1)</script>"}
    result = upload_folder(client, context, entries)
    assert result.status_code == 303
    assert f"context={context}" in result.headers["location"]
    store = PersonaStore(data).load()
    samples = [r for r in store.of_type(PreferenceExample) if context in r.context_refs]
    assert len(samples) == 1
    sample = samples[0]
    source = store.sources[sample.source_ref]
    assert is_folder_source(source)
    assert len(folder_members(source)) == len(entries)
    assert source.origin.identifier == "学术笔记"
    for name, content in entries.items():
        assert store.source_file_path(source.id, "files/" + name).read_bytes() == content
        response = client.get(f"/preferences/examples/{sample.id}/file", params={"path": "files/" + name})
        assert response.status_code == 200 and response.content == content
    assert response.headers["content-type"].startswith("text/plain")
    assert response.headers["x-content-type-options"] == "nosniff"
    archive = client.get(f"/preferences/examples/{sample.id}/file")
    assert archive.headers["content-type"] == "application/zip"
    assert archive.headers["content-disposition"].startswith("attachment")
    with zipfile.ZipFile(io.BytesIO(archive.content)) as bundle:
        assert set(bundle.namelist()) == set(entries)
        assert all(bundle.read(name) == content for name, content in entries.items())
    assert source.content_hash == hashlib.sha256(archive.content).hexdigest()
    page = client.get(f"/preferences?context={context}")
    assert "5 个文件" in page.text and "查看文件夹位置" in page.text
    assert str(data / "sources" / source.id / "files" / "学术笔记") in page.text
    tree = client.get(f"/preferences/examples/{sample.id}/files")
    assert tree.status_code == 200
    assert "&lt;draft&gt; #1?.html" in tree.text and "<draft> #1?.html" not in tree.text
    assert "images" in tree.text and "results" in tree.text
    assert "下载整个文件夹" in tree.text
    edit = client.get(f"/preferences/examples/{sample.id}/edit")
    assert "当前样本文件夹" in edit.text and f'/{sample.id}/files' in edit.text
    for path in ["../manifest.yaml", "files/学术笔记/../../manifest.yaml", "manifest.yaml", "files/other/missing.txt"]:
        assert client.get(f"/preferences/examples/{sample.id}/file", params={"path": path}).status_code == 404
    paused = client.post(f"/preferences/examples/{sample.id}/state-proposals", data={"status": "paused"})
    assert paused.status_code == 200
    assert client.get(f"/preferences/examples/{sample.id}/files").status_code == 200


def test_upload_failure_preserves_form_and_leaves_no_partial_source(folder_workspace):
    data, _, context, client = folder_workspace
    before = PersonaStore(data).load().config.revision
    sources = set((data / "sources").glob("src_*"))
    for overrides in [{"context_refs": "missing"}, {"folder_paths": "[]"},
                      {"folder_paths": '["../escape"]'}, {"folder_paths": "invalid-json"}]:
        response = upload_folder(client, context, {"Example/note.md": b"note"}, **overrides)
        assert response.status_code == 422
        assert 'value="完整笔记"' in response.text
        assert 'value="撰写笔记时"' in response.text
        assert "同时参考正文与配图" in response.text
        assert "补充完整样本" in response.text
        assert 'value="folder" checked' in response.text
        assert "请重新选择要上传的文件或文件夹" in response.text
        assert PersonaStore(data).load().config.revision == before
        assert set((data / "sources").glob("src_*")) == sources
        assert not list((data / "sources" / ".staging").glob("src_*"))


def test_file_upload_still_works_and_folder_form_supports_both_languages(folder_workspace):
    data, _, context, client = folder_workspace
    page = client.get(f"/preferences/examples/new?context_id={context}")
    assert 'name="folder_files" webkitdirectory multiple' in page.text
    assert 'name="sample_file" required' in page.text
    assert 'name="folder_paths"' in page.text
    result = client.post("/preferences/examples/proposals", data={
        "context_refs": context, "title": "Legacy file", "example_type": "negative",
    }, files={"sample_file": ("sample.md", b"Original content", "text/markdown")})
    assert result.status_code == 200
    store = PersonaStore(data).load()
    sample = next(r for r in store.of_type(PreferenceExample) if r.title == "Legacy file")
    assert not is_folder_source(store.sources[sample.source_ref])
    assert client.get(f"/preferences/examples/{sample.id}/file").content == b"Original content"
    assert client.get(f"/preferences/examples/{sample.id}/files").status_code == 404
    client.cookies.set("ai_persona_locale", "en")
    english = client.get(f"/preferences/examples/new?context_id={context}")
    assert english.status_code == 200 and "Upload a folder" in english.text


@pytest.mark.parametrize("paths", [
    [], ["/outside/note"], ["../note"], ["root/../note"], ["root//note"],
    ["root/./note"], ["root/nul\0.txt"], ["root/a\\b"], ["C:/file"],
    ["one/file", "two/file"], ["root/file", "root/file"],
    ["root/a", "root/a/b"], ["root/a/b", "root/a"],
    ["root/A.txt", "root/a.txt"], ["root/A/one", "root/a/two"],
    ["root/é.txt", "root/e\u0301.txt"], ["root/trailing."], [7],
    ["root/surrogate\ud800"], ["root/" + "a/" * 32 + "file"],
])
def test_reject_invalid_or_conflicting_folder_paths(paths):
    with pytest.raises(MaterialSourceError):
        validate_folder_paths(paths)


def test_folder_limits_and_failed_staging_cleanup(tmp_path, monkeypatch):
    with pytest.raises(MaterialSourceError, match="500"):
        validate_folder_paths([f"root/{i}" for i in range(501)])
    import ai_persona.preference_sources as module
    monkeypatch.setattr(module, "MAX_SOURCE_BYTES", 10)
    with pytest.raises(MaterialSourceError, match="50 MB"):
        stage_folder_source(tmp_path, entries=[SourceAttachment("root/file", b"x" * 11, "text/plain")])
    monkeypatch.setattr(module, "MAX_SOURCE_BYTES", 50 * 1024 * 1024)
    original = module.validate_staged_source
    monkeypatch.setattr(module, "validate_staged_source", lambda *args: (_ for _ in ()).throw(OSError("write failed")))
    with pytest.raises(OSError, match="write failed"):
        stage_folder_source(tmp_path, entries=[SourceAttachment("root/file", b"x", "text/plain")])
    assert not list((tmp_path / "sources" / ".staging").glob("src_*"))
    monkeypatch.setattr(module, "validate_staged_source", original)


def test_folder_snapshot_hash_is_independent_of_upload_order(tmp_path):
    entries = [SourceAttachment("root/a.txt", b"a", "text/plain"),
               SourceAttachment("root/sub/b.txt", b"b", "text/plain")]
    first = stage_folder_source(tmp_path, entries=entries)
    second = stage_folder_source(tmp_path, entries=list(reversed(entries)))
    assert first.manifest.content_hash == second.manifest.content_hash
