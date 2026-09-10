import copy
import threading
import time

import pytest
from fastapi.testclient import TestClient
from persona_fixture import demo_workspace

from ai_persona.prompt_api import PromptAPI
from ai_persona.prompt_store import PromptError, PromptStore
from ai_persona.web import create_app


@pytest.fixture
def store(tmp_path):
    return PromptStore(tmp_path / "prompts")


def test_versions_are_immutable_and_activation_is_atomic(store):
    ids = ["ai-persona.maintenance", "ai-persona.activation"]
    before = store.snapshot()
    versions = [
        store.save_version(
            i,
            {
                **store.version(i)["templates"],
                "system": "EDIT " + store.version(i)["templates"]["system"],
            },
            "first",
        )
        for i in ids
    ]
    assert store.snapshot() == before
    again = store.save_version(ids[0], versions[0]["templates"], "different note")
    assert again == versions[0]
    changes = [
        {"prompt_id": i, "version": v["id"], "expected_active": before["versions"][i]["id"]}
        for i, v in zip(ids, versions)
    ]
    with pytest.raises(PromptError, match="已改变"):
        store.activate([changes[0], {**changes[1], "expected_active": "stale"}])
    assert store.snapshot() == before
    store.activate(changes)
    assert store.snapshot()["fingerprint"] != before["fingerprint"]
    variables = {"payload": {"user": "{{undeclared}}"}}
    assert (
        store.preview(ids[0], variables, snapshot=before)["rendered"]["system"]
        == before["versions"][ids[0]]["templates"]["system"]
    )
    assert "{{undeclared}}" in store.preview(ids[0], variables)["rendered"]["user"]
    with pytest.raises(PromptError):
        store.preview(ids[0], {})
    with pytest.raises(PromptError):
        store.save_version(ids[0], {"system": "x", "user": "{{unknown}}"})


def test_upgrade_preserves_custom_versions_and_detects_incompatible_contract(store):
    identifier = "ai-persona.maintenance"
    old = store.version(identifier)
    custom = store.save_version(identifier, {**old["templates"], "system": "Custom"})
    store.activate(
        [{"prompt_id": identifier, "version": custom["id"], "expected_active": old["id"]}]
    )
    definitions = copy.deepcopy(list(store.definitions.values()))
    definition = next(d for d in definitions if d["id"] == identifier)
    definition["templates"]["system"] = "New default"
    upgraded = PromptStore(store.directory, definitions)
    assert upgraded.version(identifier)["id"] == custom["id"]
    assert upgraded.version(identifier, "default")["templates"]["system"] == "New default"
    definition["schema_version"] = "2"
    incompatible = PromptStore(store.directory, definitions)
    with pytest.raises(PromptError, match="不兼容"):
        incompatible.preview(identifier, {"payload": {}})
    default = incompatible.version(identifier, "default")
    incompatible.activate(
        [{"prompt_id": identifier, "version": default["id"], "expected_active": custom["id"]}]
    )
    assert incompatible.preview(identifier, {"payload": {}})["rendered"]["system"] == "New default"


def test_captures_are_bounded_and_lists_do_not_expose_inputs(store):
    api = PromptAPI(store, object())
    try:
        for i in range(32):
            store.capture("ai-persona.activation", {"payload": {"private": i}}, store.snapshot())
        assert len(store.records("captures")) == 30
        listed = api.dispatch("GET", "captures", {}, {})["items"]
        assert not any("variables" in v or "snapshot" in v for v in listed)
        store.delete("captures", listed[0]["id"])
        assert len(store.records("captures")) == 29
        for i in range(105):
            api.dispatch(
                "POST",
                "samples",
                {
                    "prompt_id": "ai-persona.activation",
                    "name": str(i),
                    "variables": {"payload": {}},
                },
                {},
            )
        assert len(api.dispatch("GET", "export", {}, {})["samples"]) == 105
    finally:
        api.close()


class FakeModel:
    def __init__(self, block=False):
        self.calls = []
        self.cancelled = []
        self.started = threading.Event()
        self.release = threading.Event()
        if not block:
            self.release.set()

    def request(self, route, raw=None):
        if route == "config":
            return {
                "capabilities": {"promptExperiments": 1},
                "settings": {
                    "connections": [
                        {
                            "id": "mock",
                            "providerId": "custom",
                            "modelId": "test-model",
                            "revision": "v1",
                        }
                    ],
                    "overrides": {},
                    "defaultConnectionId": "mock",
                },
            }
        self.calls.append(copy.deepcopy(raw))
        self.started.set()
        self.release.wait(2)
        return {"text": '{"contexts":[]}', "modelId": "test-model"}

    def cancel(self, identifier):
        self.cancelled.append(identifier)


def until(fn):
    for _ in range(200):
        if result := fn():
            return result
        time.sleep(0.01)
    raise AssertionError("timed out")


def test_experiments_freeze_inputs_and_models_without_business_writes(store):
    model = FakeModel()
    api = PromptAPI(store, model)
    try:
        identifier = "ai-persona.activation"
        templates = {**store.version(identifier)["templates"], "system": "Different rules"}
        value = api.start(
            {
                "prompt_id": identifier,
                "variables": {"payload": {"catalog": []}},
                "variants": [{"version": "active"}, {"templates": templates}],
            }
        )
        until(lambda: not api.active)
        result = store.record("experiments", value["id"])
        assert result["status"] == "succeeded"
        assert len(result["results"]) == 2
        assert not result["results"][0]["validation"]["issues"]
        assert model.calls[0]["prompt"] == model.calls[1]["prompt"]
        assert model.calls[0]["systemPrompt"] != model.calls[1]["systemPrompt"]
        assert model.calls[0]["experimentSelection"] == model.calls[1]["experimentSelection"]
        assert model.calls[0]["experimentSelection"]["revision"] == "v1"
        assert len(store.records("captures")) == 0
        assert list(store.directory.iterdir()) == [store.path]
        assert api.detail(identifier)["example"]["payload"]["output_schema"]["properties"]
    finally:
        api.close()


def test_cancellation_discards_late_results_and_rejects_running_delete(store):
    model = FakeModel(block=True)
    api = PromptAPI(store, model)
    try:
        value = api.start(
            {"prompt_id": "ai-persona.activation", "variables": {"payload": {"catalog": []}}}
        )
        assert model.started.wait(1)
        with pytest.raises(PromptError, match="取消"):
            store.delete("experiments", value["id"])
        api.cancel(value["id"])
        model.release.set()
        until(lambda: not api.active)
        result = store.record("experiments", value["id"])
        assert result["status"] == "cancelled" and result["results"] == []
        assert model.cancelled == [value["id"]]
    finally:
        model.release.set()
        api.close()


def test_local_api_access_and_dynamic_registration(tmp_path):
    workspace = demo_workspace()
    app = create_app(workspace.data_root, tmp_path / "state")
    with TestClient(app) as client:
        response = client.get("/api/prompts/v1")
        assert response.status_code == 200 and len(response.json()["prompts"]) == 7
        assert (
            client.get(
                "/api/prompts/v1", headers={"Origin": "https://elsewhere.example"}
            ).status_code
            == 403
        )
        assert client.post("/api/prompts/v1/activate", json={}).status_code == 403
        assert client.get("/api/prompts/v1/prompts/missing").status_code == 404
        detail = client.get("/api/prompts/v1/prompts/ai-persona.activation").json()
        assert detail["example"]["payload"]["output_schema"]
    d = copy.deepcopy(PromptStore(tmp_path / "old").definition("ai-persona.activation"))
    d["id"] = "future.new-feature"
    added = PromptStore(tmp_path / "new", [d])
    assert added.catalog()[0]["id"] == d["id"]
    assert added.preview(d["id"], {"payload": {}})["rendered"]["user"] == "{}"
