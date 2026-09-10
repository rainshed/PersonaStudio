"""Bounded learning from user intent. Proposals contain notes, never chat Evidence."""

from __future__ import annotations

import json
import uuid

from ..agent import AgentServiceError, PersonaProposalFacade, ProposalChangeInput
from ..ai_service import parse_output
from ..change_sets import ProducerRef, proposal_lock
from ..evaluations.business import bindings, snapshot_persona
from ..evaluations.contracts import LEARNING, learning_gate
from ..evaluations.store import EvaluationStore
from ..maintenance.matching import preference_key as shared_preference_key
from ..maintenance.matching import text_key
from ..material_analysis import compact_schema, field_contracts
from ..model_bridge import ModelClient
from ..models import KnowledgeNode, Preference, PreferenceContext, ProposalContext, Relation
from ..pending_sync import sync_pending
from ..prompt_store import PromptStore, default_text
from ..proposals import ProposalRepository
from ..store import PersonaStore
from .contracts import (
    CandidateOutput,
    ContextSnapshot,
    ConversationEvent,
    SignalOutput,
    digest,
    encoded,
)
from .input_text import INPUT_TEXT_VERSION
from .policy import authorized, origin_basis

PROMPT_VERSION = "conversation-learning/v5-tools-only"
# Candidate input includes tool definitions and accumulated results across six rounds.
SIGNAL_INPUT_LIMIT = 12_000
CANDIDATE_INPUT_LIMIT = 120_000
SIGNAL_PROMPT = default_text("ai-persona.conversation-signal")

CANDIDATE_PROMPT = default_text("ai-persona.conversation-candidate")


def title_key(text):
    return text_key(text)


class LearningPipeline:
    def __init__(self, service, model=None, context_providers=None):
        self.service = service
        self.repo = service.repository
        self.model = model or ModelClient.for_workspace(service.data_root, service.state_root)
        self.prompts = PromptStore(service.state_root / "prompts")
        self.context_providers = context_providers or {}
        self.evaluations = EvaluationStore(service.data_root, service.state_root)
        self.result_id = None
        self.frozen_history = None

    def proposal_history(self, limit=10000):
        if self.frozen_history is not None:
            pending = [p for p in self.frozen_history if p.status in {"pending_review", "deferred"}]
            history = [
                p for p in self.frozen_history if p.status not in {"pending_review", "deferred"}
            ]
            order = getattr(self, "frozen_history_order", None)
            if order is not None:
                return [*pending, *(p for p in history if order[p.id] < limit)]
            return [*pending, *history[:limit]]
        repository = ProposalRepository(self.service.data_root)
        return [*repository.list_pending(), *repository.list_history(limit=limit)]

    def active(self, identifier, token):
        row = self.repo.get(identifier)
        if row["status"] != "running" or row["lease"] != token or row["payload"] is None:
            raise AgentServiceError("cancelled", "任务已停止或被替换。")
        event = ConversationEvent.model_validate_json(row["payload"])
        settings = self.repo.settings()
        connection = self.repo.connection(event.source_connection_id)
        if (
            not settings.enabled
            or not settings.allow_model_calls
            or not authorized(connection, event)
        ):
            raise AgentServiceError("paused", "学习、模型调用或来源范围已暂停。")
        return row, event, connection, settings

    def call(self, identifier, token, task, system, payload, output_type, max_tokens):
        row, *_ = self.active(identifier, token)
        snapshot = json.loads(row["checkpoint"])["prompt_snapshot"]
        from ..trigger_plans import generation_options
        prompt_id = "ai-persona." + task.replace("_", "-")
        preview = self.prompts.preview(prompt_id, {"payload": payload}, snapshot=snapshot)
        system = preview["rendered"]["system"]
        self.prompts.capture(prompt_id, {"payload": payload}, snapshot, origin=identifier)
        input_size = len(encoded(payload)) + len(system)
        if input_size > (SIGNAL_INPUT_LIMIT if task == "conversation_signal" else CANDIDATE_INPUT_LIMIT):
            raise AgentServiceError("context_length", "学习输入超过当前阶段预算，未截断原文。")
        call_id = "learnrun-" + uuid.uuid4().hex
        # UTF-8 bytes are a conservative tokenizer-independent upper bound.
        self.repo.reserve_call(
            call_id, task, len((encoded(payload) + system).encode()) + max_tokens
        )
        result = self.model.generate(
            task,
            system,
            payload
            if preview["templates"]["user"] == "{{payload}}"
            else preview["rendered"]["user"],
            max_tokens=max_tokens,
            **generation_options(snapshot, prompt_id),
            run_id=call_id,
            stage=task,
        )
        usage = result.get("usage") or {}
        total = usage.get("totalTokens")
        if (
            total is None
            and isinstance(usage.get("input"), int)
            and isinstance(usage.get("output"), int)
        ):
            total = sum(usage.get(key, 0) for key in ("input", "output", "cacheRead", "cacheWrite"))
        self.repo.finish_call(call_id, total)
        self.active(identifier, token)
        parsed = parse_output(result, output_type)
        if self.result_id:
            updates = {
                "stage": {
                    "prompt_id": prompt_id,
                    "payload": payload,
                    "output": parsed.model_dump(mode="json"),
                    "model": {k: v for k, v in result.items() if k != "text"},
                }
            }
            if task == "conversation_candidate":
                updates["candidate_input"] = payload
            self.evaluations.complete_result(self.result_id, **updates)
        return parsed

    @staticmethod
    def context_messages(row, event, *, expanded=False):
        if not row["snapshot"]:
            return []
        snapshot = ContextSnapshot.model_validate_json(row["snapshot"])
        result, used = [], 0
        for message in reversed(snapshot.messages):
            if message.id == event.message.id or message.role not in {"user", "assistant"}:
                continue
            if message.origin == "automation":
                continue
            if not message.learning_text.strip():
                continue
            value = {"id": message.id, "role": message.role, "text": message.learning_text}
            size = len(encoded(value))
            if used + size > (6000 if expanded else 2200):
                break
            result.insert(0, value)
            used += size
            if len(result) >= (12 if expanded else 4):
                break
        return result

    @staticmethod
    def full_record(loaded):
        value = loaded.record.model_dump(mode="json", by_alias=True)
        # Source/evidence and housekeeping metadata aren't learning context.
        for key in ("evidence_refs", "created_at", "updated_at", "schema", "source_ref"):
            value.pop(key, None)
        value["body"] = loaded.body
        return value

    def candidate_payload(self, event, signal_output, store, selected):
        contracts = field_contracts(False, True)
        contracts = {
            key: value
            for key, value in contracts.items()
            if key in {"knowledge_node", "preference", "preference_context", "relation"}
        }
        for contract in contracts.values():
            for field in ("evidence_refs", "knowledge_level", "interest_level", "status"):
                contract.get("properties", {}).pop(field, None)
                for action in ("create", "update", "relate", "required_on_create"):
                    if field in contract.get(action, []):
                        contract[action].remove(field)
        catalog, size = [], 0
        for loaded in store.records.values():
            record = loaded.record
            if record.status != "active" or not isinstance(
                record, (KnowledgeNode, PreferenceContext)
            ):
                continue
            item = {
                "id": record.id,
                "title": getattr(record, "title", getattr(record, "name", "")),
                "aliases": getattr(record, "aliases", []),
            }
            if size + len(encoded(item)) > 5000:
                break
            catalog.append(item)
            size += len(encoded(item))
        ids = {value.record.id for value in selected}
        relations = [
            r.model_dump(mode="json")
            for r in store.of_type(Relation, active_only=True)
            if r.source_id in ids or r.target_id in ids
        ][:40]
        history = []
        for proposal in self.proposal_history(30)[:100]:
            if proposal.target_entity_type not in contracts:
                continue
            history.append(
                {
                    "status": proposal.status,
                    "entity_type": proposal.target_entity_type,
                    "values": {
                        p.field: p.after
                        for p in proposal.patch
                        if p.field not in {"body", "evidence_refs"}
                    },
                    "decision_note": proposal.decision_reason,
                }
            )
            if len(encoded(history)) > 5000:
                history.pop()
                break
        return {
            "current_user_prompt": event.message.learning_text,
            "observations": signal_output.model_dump()["signals"],
            "records": [self.full_record(loaded) for loaded in selected],
            "catalog": catalog,
            "catalog_may_be_partial": True,
            "existing_relations": relations,
            "review_history": history,
            "field_contracts": contracts,
            "output_schema": compact_schema(CandidateOutput.model_json_schema()),
        }

    def validate_changes(self, output, signals, store, selected, settings):
        by_signal = {s.id: s for s in signals if not s.temporary}
        if not set(output.waiting_signal_ids) <= set(by_signal):
            raise AgentServiceError("invalid_model_output", "待补充项引用了未知或一次性信号。")
        selected_ids = {r.record.id for r in selected}
        result, redirects = [], {}
        history = self.proposal_history()
        prior_names = {
            title_key(str(p.after))
            for proposal in history
            if proposal.target_entity_type == "knowledge_node"
            and proposal.operation == "create"
            and proposal.status in {"pending_review", "deferred", "rejected"}
            for p in proposal.patch
            if p.field == "title"
        }
        context_keys = {c.id: c.key for c in store.of_type(PreferenceContext)}
        for proposal in history:
            if (
                proposal.target_entity_type == "preference_context"
                and proposal.operation == "create"
            ):
                context_keys[proposal.target_id] = next(
                    (p.after for p in proposal.patch if p.field == "key"),
                    proposal.target_id,
                )
        context_redirects = {}
        for candidate in output.changes:
            if candidate.entity_type == "preference_context" and candidate.operation == "create":
                key_value = candidate.values.get("key")
                context_keys[candidate.client_ref] = key_value or candidate.client_ref
                existing_context = next(
                    (
                        c
                        for c in store.of_type(PreferenceContext)
                        if c.key == key_value
                    ),
                    None,
                )
                if existing_context:
                    context_redirects[candidate.client_ref] = existing_context.id

        def preference_key(values):
            return shared_preference_key(values, context_keys)

        prior_preferences = {
            preference_key(p.model_dump()) for p in store.of_type(Preference) if p.status != "archived"
        }
        prior_preferences.update(
            preference_key({p.field: p.after for p in proposal.patch})
            for proposal in history
            if proposal.target_entity_type == "preference"
            and proposal.operation == "create"
            and proposal.status in {"pending_review", "deferred", "rejected"}
        )
        contexts = {c.client_ref for c in output.changes if c.entity_type == "preference_context"}
        for candidate in output.changes:
            if not set(candidate.signal_ids) <= set(by_signal):
                raise AgentServiceError("invalid_model_output", "候选引用了未知或一次性信号。")
            required_type = (
                "preference" if candidate.entity_type.startswith("preference") else "knowledge_node"
            )
            if any(by_signal[s].target_type != required_type for s in candidate.signal_ids):
                raise AgentServiceError("invalid_model_output", "候选类型与触发信号不匹配。")
            allowed = (
                "preference"
                if candidate.entity_type == "preference_context"
                else candidate.entity_type
            )
            if allowed not in settings.learning_types:
                continue
            values = dict(candidate.values)
            if (
                set(values) & {"evidence_refs", "source_hash", "source_ref"}
                and candidate.entity_type != "relation"
            ):
                raise AgentServiceError("invalid_model_output", "候选不允许附带原始证据。")
            if set(values) & {"knowledge_level", "interest_level", "status"}:
                raise AgentServiceError(
                    "invalid_model_output", "对话学习不能推断掌握程度或个人兴趣。"
                )
            if candidate.operation == "update" and candidate.target_id not in selected_ids:
                raise AgentServiceError("invalid_model_output", "更新前必须读取完整的当前记录。")
            if candidate.entity_type == "knowledge_node" and candidate.operation == "create":
                names = {
                    title_key(values.get("title", "")),
                    *(title_key(a) for a in values.get("aliases", [])),
                } - {""}
                existing = next(
                    (
                        k
                        for k in store.of_type(KnowledgeNode, active_only=True)
                        if names & {title_key(k.title), *(title_key(a) for a in k.aliases)}
                    ),
                    None,
                )
                if existing:
                    redirects[candidate.client_ref] = existing.id
                    continue
                if names & prior_names:
                    continue
                prior_names.update(names)
                values.update(knowledge_level="unspecified", interest_level="unspecified")
            if candidate.client_ref in context_redirects:
                continue
            if candidate.entity_type == "preference":
                scoped_signals = any(
                    by_signal[s].scope not in {"", "global"} for s in candidate.signal_ids
                )
                current = store.records.get(candidate.target_id)
                scope = values.get(
                    "scope", getattr(current.record, "scope", "global") if current else "global"
                )
                if scoped_signals and scope != "contexts":
                    raise AgentServiceError("invalid_model_output", "场景偏好不能扩大为全局偏好。")
                if not set(values.get("context_client_refs", [])) <= contexts:
                    raise AgentServiceError("invalid_model_output", "偏好缺少对应场景候选。")
                if "context_client_refs" in values:
                    refs = values["context_client_refs"]
                    values["context_refs"] = [
                        *values.get("context_refs", []),
                        *(context_redirects[r] for r in refs if r in context_redirects),
                    ]
                    values["context_client_refs"] = [r for r in refs if r not in context_redirects]
                if candidate.operation == "create":
                    identity = preference_key(values)
                    if identity in prior_preferences:
                        continue
                    prior_preferences.add(identity)
            result.append((candidate, values))
        new_knowledge = {
            c.client_ref
            for c, _ in result
            if c.entity_type == "knowledge_node" and c.operation == "create"
        }
        changes = []
        for candidate, values in result:
            if candidate.entity_type == "relation":
                if (
                    "relation" not in settings.learning_types
                    or values.get("relation_type") == "covers"
                ):
                    continue
                for direction in ("source", "target"):
                    reference = values.get(direction + "_ref")
                    if reference in redirects:
                        values[direction + "_id"] = redirects[reference]
                        del values[direction + "_ref"]
                fresh = [values.get(k + "_ref") in new_knowledge for k in ("source", "target")]
                existing = [values.get(k + "_id") in selected_ids for k in ("source", "target")]
                if not ((fresh[0] and existing[1]) or (fresh[1] and existing[0])):
                    # Alias reuse removes the new node, so its optional links are omitted too.
                    continue
            change = ProposalChangeInput(
                client_ref=candidate.client_ref,
                operation=candidate.operation,
                entity_type=candidate.entity_type,
                target_id=candidate.target_id,
                expected_record_revision=candidate.expected_record_revision,
                values=values,
                reason=candidate.note.strip(),
                confidence=0.0,
            )
            changes.append(change)
        # Do not leave an unused context proposal after filtering its dependent preference.
        used_contexts = {
            ref
            for c in changes
            if c.entity_type == "preference"
            for ref in c.values.get("context_client_refs", [])
        }
        changes = [
            c
            for c in changes
            if c.entity_type != "preference_context"
            or c.operation != "create"
            or c.client_ref in used_contexts
        ]
        return changes

    def shared_relevant(self, store, signals):
        from ..maintenance.runner import MaintenanceReader
        reader = MaintenanceReader(self.service.data_root, self.service.state_root, store, {},
                                   snapshot_store=getattr(self, "query_snapshot", None))
        query = " ".join(s.topic + " " + s.statement + " " + s.scope for s in signals)[:4000]
        ids = []
        for name, args in [("search_preferences", {"query": query, "limit": 10}),
                           ("search_knowledge", {"query": query, "entity_types": ["knowledge_node"], "limit": 6})]:
            payload, _ = reader.call(name, {**args, "max_chars": 12000})
            if not payload.get("ok"):
                raise AgentServiceError("query_unavailable", "维护检索暂时不可用，请重试。")
            data = payload.get("data", {})
            rows = data.get("items", data.get("hits", []))
            ids.extend(row["id"] for row in rows if row.get("id") in store.records)
        return [store.records[rid] for rid in dict.fromkeys(ids)
                if isinstance(store.records[rid].record, (KnowledgeNode, Preference, PreferenceContext))]

    def candidate_rounds(self, event, signal_output, store, request, selected=None, payload=None):
        """The same bounded reader/tool loop as foreground maintenance, with learning policy."""
        from ..maintenance.runner import MaintenanceReader, loop
        reader = MaintenanceReader(self.service.data_root, self.service.state_root, store, {},
                                   snapshot_store=getattr(self, "query_snapshot", None))
        selected = self.shared_relevant(store, signal_output.signals) if selected is None else selected
        by_id = {r.record.id: r for r in selected}
        reader.ledger["records"].update({r.record.id: r.record.revision for r in selected})
        first_payload = payload
        names = {"search_knowledge", "get_knowledge_map", "get_persona_records",
                 "search_preferences", "get_preference_records"}
        definitions = reader.registry.definitions(names)

        def dispatch(name, arguments):
            if name not in names:
                raise AgentServiceError("invalid_tool", "对话学习只开放 Persona 查询工具。")
            result, images = reader.call(name, {**arguments, "max_chars": 12000})
            for rid in reader.ledger["records"]:
                record = store.records[rid]
                if isinstance(record.record, (KnowledgeNode, Preference, PreferenceContext)):
                    by_id[rid] = record
            return result, images

        def ask(state):
            current = dict(first_payload) if first_payload is not None and state["round"] == 0 else self.candidate_payload(event, signal_output, store, list(by_id.values()))
            current.update(tools=definitions, tool_results=state["messages"],
                           origin={"kind": "conversation_learning", "observations_are_provisional": True})
            output = request(current)
            calls = [c.model_dump() for c in output.calls]
            if calls:
                return {"text": json.dumps({"calls": calls})}
            # Versions belong to the backend and come from records supplied in this run.
            for change in output.changes:
                if change.target_id:
                    change.expected_record_revision = reader.ledger["records"].get(change.target_id)
            return {"terminal": output.model_dump()}

        output = loop(ask, dispatch, lambda result: result, rounds=6, result_type=CandidateOutput)
        return output, list(by_id.values())

    def process(self, identifier, token):
        self.result_id = None
        try:
            return self._process(identifier, token)
        except Exception as exc:
            if self.result_id:
                try:
                    self.evaluations.complete_result(
                        self.result_id,
                        state="failed",
                        error_code=getattr(exc, "code", "internal_error"),
                    )
                except Exception:
                    pass
            raise

    def _process(self, identifier, token):
        row, event, connection, settings = self.active(identifier, token)
        key = "conversation-learning:" + identifier
        facade = PersonaProposalFacade(self.service.data_root, self.service.state_root)
        # Recover committed file transactions before contacting even the model config service.
        with proposal_lock(self.service.state_root):
            existing = facade.change_sets.by_idempotency_key(key)
        if existing:
            result_id = json.loads(row["checkpoint"]).get("evaluation_result_id")
            if result_id:
                try:
                    proposals = [
                        ProposalRepository(self.service.data_root).get(p.proposal_id)
                        for p in existing.proposal_links
                    ]
                    self.evaluations.complete_result(
                        result_id, proposal_bindings=bindings(proposals)
                    )
                except (ValueError, AttributeError):
                    pass
            self.repo.fenced_update(
                identifier,
                token,
                status="completed",
                outcome="submitted_review",
                change_set_id=existing.id,
            )
            self.repo.mark_observations(identifier, "proposed")
            return
        checkpoint = json.loads(row["checkpoint"])
        if checkpoint.get("prompt_version") != PROMPT_VERSION:
            checkpoint = {"prompt_version": PROMPT_VERSION}
        if checkpoint.get("input_text_version") != INPUT_TEXT_VERSION:
            messages = [event.message]
            if row["snapshot"]:
                messages += ContextSnapshot.model_validate_json(row["snapshot"]).messages
            if any(m.learning_text != m.text for m in messages):
                # A paused task must not reuse observations inferred from host state.
                checkpoint.pop("signal", None)
                checkpoint.pop("candidate", None)
                self.repo.mark_observations(identifier, "dismissed")
            checkpoint["input_text_version"] = INPUT_TEXT_VERSION
        if not event.message.learning_text.strip():
            self.repo.fenced_update(
                identifier,
                token,
                status="completed",
                outcome="ignored",
                checkpoint=encoded(checkpoint),
            )
            self.repo.mark_observations(identifier, "dismissed")
            return
        if "prompt_snapshot" not in checkpoint:
            checkpoint["prompt_snapshot"] = self.prompts.snapshot()
            self.repo.fenced_update(identifier, token, checkpoint=encoded(checkpoint))
        signature_method = getattr(self.model, "configuration_signature", None)
        if signature_method:
            signatures = {
                task: signature_method(task)
                for task in ("conversation_signal", "conversation_candidate")
            }
            frozen_model = checkpoint["prompt_snapshot"].get("trigger_models", {}).get("ai-persona.conversation-signal")
            if frozen_model:
                signatures["conversation_signal"] = digest(frozen_model)
            previous = checkpoint.get("model_signatures", {})
            if (
                previous
                and previous.get("conversation_signal") != signatures["conversation_signal"]
            ):
                checkpoint.pop("signal", None)
                checkpoint.pop("candidate", None)
            if (
                previous
                and previous.get("conversation_candidate") != signatures["conversation_candidate"]
            ):
                checkpoint.pop("candidate", None)
            checkpoint["model_signatures"] = signatures
        checkpoint["input_hash"] = digest([event.model_dump(mode="json"), row["snapshot"]])
        with proposal_lock(self.service.state_root):
            baseline_store = PersonaStore(self.service.data_root).load()
            environment = snapshot_persona(baseline_store, self.proposal_history())
        environment.update(
            settings=settings.model_dump(mode="json"),
            connection=connection.model_dump(mode="json", exclude={"adapter_config"}),
            human_confirmed=bool(row["human_confirmed"]),
        )
        result = self.evaluations.create_result(
            LEARNING,
            task_ref=identifier,
            input_data={
                "event": event.model_dump(mode="json", by_alias=True),
                "snapshot": json.loads(row["snapshot"]) if row["snapshot"] else None,
                "input_text_version": INPUT_TEXT_VERSION,
            },
            environment=environment,
            prompt_snapshot=checkpoint["prompt_snapshot"],
            group_id=digest([event.source_connection_id, event.conversation_id, event.message.id]),
        )
        self.result_id = result["id"]
        checkpoint["evaluation_result_id"] = self.result_id
        self.repo.fenced_update(identifier, token, checkpoint=encoded(checkpoint))
        if "signal" in checkpoint:
            signal_output = SignalOutput.model_validate(checkpoint["signal"])
        else:
            payload = {
                "current_user_prompt": event.message.learning_text,
                "context": self.context_messages(row, event),
                "output_schema": compact_schema(SignalOutput.model_json_schema()),
            }
            signal_output = self.call(
                identifier, token, "conversation_signal", SIGNAL_PROMPT, payload, SignalOutput, 1500
            )
            if signal_output.decision == "needs_context":
                provider = self.context_providers.get(event.source_connection_id)
                if provider and event.context.ref and event.context.boundary:
                    snapshot = provider.resolve_context(
                        event.source_connection_id,
                        event.context.ref,
                        event.context.boundary,
                        signal_output.context_request,
                    )
                    row["snapshot"] = self.service._snapshot(event, snapshot)
                    self.repo.fenced_update(identifier, token, snapshot=row["snapshot"])
                expanded = self.context_messages(row, event, expanded=True)
                if expanded != payload["context"]:
                    payload["context"] = expanded
                    signal_output = self.call(
                        identifier,
                        token,
                        "conversation_signal",
                        SIGNAL_PROMPT,
                        payload,
                        SignalOutput,
                        1500,
                    )
            checkpoint["signal"] = signal_output.model_dump()
            self.repo.fenced_update(identifier, token, checkpoint=encoded(checkpoint))
        gate = learning_gate(signal_output)
        self.evaluations.complete_result(
            self.result_id,
            decisions=[
                {
                    "subject": {"kind": "learning_gate"},
                    "name": "对话学习",
                    "triggered": gate,
                    "processing_state": "waiting_context" if gate is None else "completed",
                }
            ],
            expanded_context=self.context_messages(row, event, expanded=True),
        )
        if signal_output.decision == "needs_context":
            self.evaluations.complete_result(self.result_id, state="completed")
            self.repo.fenced_update(
                identifier, token, status="waiting_context", outcome="needs_context"
            )
            return
        if signal_output.decision == "ignore":
            self.evaluations.complete_result(self.result_id, state="completed")
            self.repo.fenced_update(identifier, token, status="completed", outcome="ignored")
            return
        self.repo.save_observations(identifier, token, signal_output.signals)
        if all(s.temporary for s in signal_output.signals):
            self.evaluations.complete_result(self.result_id, state="completed")
            self.repo.fenced_update(identifier, token, status="completed", outcome="ignored")
            self.repo.mark_observations(identifier, "dismissed")
            return
        # Re-read policy after signal recognition: trust may have been revoked
        # while that model request was in flight.
        row, event, connection, settings = self.active(identifier, token)
        checkpoint["origin_basis"] = origin_basis(
            connection, event, human_confirmed=bool(row["human_confirmed"])
        )
        self.repo.fenced_update(identifier, token, checkpoint=encoded(checkpoint))
        if checkpoint["origin_basis"] is None:
            self.evaluations.complete_result(self.result_id, state="completed")
            # Serialize with source configuration saves, so enabling trust cannot
            # race with the transition to waiting_origin and strand the event.
            with self.repo.transaction() as db:
                latest = self.repo.connection(event.source_connection_id, db)
                requeue = authorized(latest, event) and origin_basis(latest, event)
                result = db.execute(
                    """UPDATE events SET status=?,outcome='observed',
                    updated=strftime('%s','now'),version=version+1
                    WHERE id=? AND lease=? AND status='running'""",
                    ("queued" if requeue else "waiting_origin", identifier, token),
                )
                if result.rowcount != 1:
                    raise AgentServiceError("cancelled", "任务已停止。")
                db.execute(
                    "UPDATE observations SET status=? WHERE event_id=?",
                    ("new" if requeue else "waiting_origin", identifier),
                )
            return
        with proposal_lock(self.service.state_root):
            store = PersonaStore(self.service.data_root).load()
            current_history = self.proposal_history()
            current_environment = snapshot_persona(store, current_history)
        current_environment.update(
            settings=settings.model_dump(mode="json"),
            connection=connection.model_dump(mode="json", exclude={"adapter_config"}),
            human_confirmed=bool(row["human_confirmed"]),
        )
        if current_environment != environment:
            self.evaluations.complete_result(self.result_id, environment_changed=True)
        selected = self.shared_relevant(store, signal_output.signals)
        if checkpoint.get("persona_revision") != store.config.revision:
            checkpoint.pop("candidate", None)
        checkpoint["persona_revision"] = store.config.revision
        if "candidate" in checkpoint:
            output = CandidateOutput.model_validate(checkpoint["candidate"])
            selected = [store.records[i] for i in checkpoint["read_record_ids"] if i in store.records]
        else:
            output, selected = self.candidate_rounds(
                event,
                signal_output,
                store,
                lambda payload: self.call(
                    identifier,
                    token,
                    "conversation_candidate",
                    CANDIDATE_PROMPT,
                    payload,
                    CandidateOutput,
                    6000,
                ),
                selected,
            )
            checkpoint.update(
                candidate=output.model_dump(), read_record_ids=[r.record.id for r in selected]
            )
            self.repo.fenced_update(identifier, token, checkpoint=encoded(checkpoint))
        changes = self.validate_changes(output, signal_output.signals, store, selected, settings)
        self.evaluations.complete_result(
            self.result_id,
            generation=[c.model_dump(mode="json") for c in changes],
        )
        if not changes:
            self.evaluations.complete_result(self.result_id, state="completed")
            self.repo.fenced_update(identifier, token, status="completed", outcome="observed")
            self.repo.mark_observations(
                identifier, "waiting_context" if output.waiting_signal_ids else "aggregated"
            )
            return
        self.active(identifier, token)
        submission = sync_pending(
            facade,
            producer_ref=ProducerRef(kind="conversation_learning", id=identifier),
            change_set_id=None,
            idempotency_key=key,
            observed_persona_revision=store.config.revision,
            summary="对话学习 · " + signal_output.signals[0].statement[:100],
            changes=changes,
            proposal_context=ProposalContext(kind="conversation", learning_batch_id=identifier),
            guard=lambda: self.proposal_guard(identifier, token, settings, connection),
        )
        self.repo.fenced_update(
            identifier,
            token,
            status="completed",
            outcome="submitted_review",
            change_set_id=submission.change_set_id,
        )
        self.repo.mark_observations(identifier, "proposed")
        proposals = [
            ProposalRepository(self.service.data_root).get(p.proposal_id)
            for p in submission.proposals
        ]
        self.evaluations.complete_result(
            self.result_id,
            state="completed",
            proposal_bindings=bindings(proposals),
        )

    def proposal_guard(self, identifier, token, original_settings, original_connection):
        _, _, connection, settings = self.active(identifier, token)
        if (
            settings.learning_types != original_settings.learning_types
            or connection != original_connection
        ):
            raise AgentServiceError("paused", "学习类型或来源设置已修改，请重试以重新检查候选。")
