"""Atomically publish workspace trigger text and model selection in one SQLite commit.

Production calls take both from the same prompt snapshot. The global credential
vault remains the connection authority; no credentials enter workspace records.
"""

from __future__ import annotations

import copy
import json
import uuid

from .prompt_store import PromptError, digest, encoded, now

TASKS = {
    "ai-persona.activation": "activation",
    "ai-persona.conversation-signal": "conversation_signal",
}


def generation_options(snapshot, prompt_id):
    value = snapshot.get("trigger_models", {}).get(prompt_id)
    if not value:
        return {}
    return {"experiment_selection": value["selection"], "reasoning": value.get("reasoning")}


def effective_config(config, snapshot):
    """Project settings display the same selection used by production snapshots."""
    value = copy.deepcopy(config)
    settings = value["settings"]
    for prompt_id, plan in snapshot.get("trigger_models", {}).items():
        task = TASKS.get(prompt_id)
        if not task:
            continue
        # A v2 shared learning route must not move candidate generation as well.
        if task == "conversation_signal" and settings.get("routingVersion") == 2:
            from .model_routing import model_task

            old = model_task(settings, task)
            settings.setdefault("overrides", {})[task] = settings["overrides"].get(old)
            settings.setdefault("overrideModelIds", {})[task] = settings["overrideModelIds"].get(
                old
            )
            settings["routingVersion"] = 3
        settings.setdefault("overrides", {})[task] = plan["selection"]["connectionId"]
        settings.setdefault("overrideModelIds", {})[task] = plan["selection"]["modelId"]
        settings.setdefault("overrideReasoning", {})[task] = plan.get("reasoning")
        for route in value.get("taskRoutes", []):
            if route["id"] == task:
                route.update(
                    connectionId=plan["selection"]["connectionId"],
                    modelId=plan["selection"]["modelId"],
                    reasoning=plan.get("reasoning"),
                    conflict=False,
                )
    value["workspace_trigger_plans"] = snapshot.get("trigger_models", {})
    return value


def signature(snapshot, prompt_id):
    return digest(
        {
            "version": snapshot["versions"][prompt_id]["id"],
            "model": snapshot.get("trigger_models", {}).get(prompt_id),
        }
    )


def publish(
    prompts,
    prompt_id,
    version,
    selection,
    reasoning,
    expected_signature,
    *,
    origin,
    previous_selection=None,
    previous_reasoning=None,
):
    if prompt_id not in TASKS:
        raise PromptError("此能力不支持启用触发方案。")
    with prompts.db() as db:
        db.execute("BEGIN IMMEDIATE")
        previous_version = prompts._version(db, prompt_id)
        row = db.execute(
            "SELECT data FROM trigger_models WHERE prompt_id=?", (prompt_id,)
        ).fetchone()
        previous_model = json.loads(row[0]) if row else None
        current = digest({"version": previous_version["id"], "model": previous_model})
        if current != expected_signature:
            raise PromptError("当前方案已变化，请重新比较后启用。", "conflict", 409)
        candidate = prompts._version(db, prompt_id, version)
        prompts.compatible(prompt_id, candidate)
        plan = {"selection": selection, "reasoning": reasoning, "origin": origin}
        record = {
            "id": "plan_" + uuid.uuid4().hex,
            "prompt_id": prompt_id,
            "before": {
                "version": previous_version["id"],
                "model": previous_model
                or {
                    "selection": previous_selection,
                    "reasoning": previous_reasoning,
                    "origin": "rollback",
                },
            },
            "after": {"version": version, "model": plan},
            "created_at": now(),
        }
        db.execute(
            "INSERT INTO active VALUES (?,?) ON CONFLICT(prompt_id) DO UPDATE SET version=excluded.version",
            (prompt_id, version),
        )
        db.execute(
            "INSERT INTO trigger_models VALUES (?,?) ON CONFLICT(prompt_id) DO UPDATE SET data=excluded.data",
            (prompt_id, encoded(plan)),
        )
        db.execute("INSERT INTO plan_history VALUES (?,?)", (record["id"], encoded(record)))
    return record


def rollback(prompts, history_id):
    with prompts.db() as db:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute("SELECT data FROM plan_history WHERE id=?", (history_id,)).fetchone()
        if not row:
            raise PromptError("启用记录不存在。", "not_found", 404)
        record = json.loads(row[0])
        prompt_id = record["prompt_id"]
        current_row = db.execute(
            "SELECT data FROM trigger_models WHERE prompt_id=?", (prompt_id,)
        ).fetchone()
        current = {
            "version": prompts._version(db, prompt_id)["id"],
            "model": json.loads(current_row[0]) if current_row else None,
        }
        if record.get("rolled_back_at"):
            return record
        if current != record["after"]:
            raise PromptError("启用后方案又有修改，不能覆盖后续调整。", "conflict", 409)
        before = record["before"]
        prompts.compatible(prompt_id, prompts._version(db, prompt_id, before["version"]))
        db.execute("UPDATE active SET version=? WHERE prompt_id=?", (before["version"], prompt_id))
        if before["model"] is None:
            db.execute("DELETE FROM trigger_models WHERE prompt_id=?", (prompt_id,))
        else:
            db.execute(
                "UPDATE trigger_models SET data=? WHERE prompt_id=?",
                (encoded(before["model"]), prompt_id),
            )
        record["rolled_back_at"] = now()
        db.execute("UPDATE plan_history SET data=? WHERE id=?", (encoded(record), history_id))
    return record


def clear_workspace_models(prompts):
    """An explicit save in model settings replaces previous workspace overrides."""
    with prompts.db() as db:
        db.execute("DELETE FROM trigger_models")


def publication_record(prompts, origin):
    """The transactional history is authoritative if a report update was interrupted."""
    with prompts.db() as db:
        for row in db.execute("SELECT data FROM plan_history ORDER BY rowid DESC"):
            value = json.loads(row[0])
            if value["after"]["model"].get("origin") == origin:
                return value
    return None
