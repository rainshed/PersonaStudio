"""Shared inline review; source adapters select candidates, publication stays centralized."""

from __future__ import annotations

from pydantic import ValidationError

from .change_sets import ChangeSetRepository
from .models import Relation
from .proposals import (
    CREATE_TYPES,
    SCHEMA_BY_TYPE,
    ProposalError,
    ProposalRepository,
    ProposalService,
    StaleProposalError,
)
from .review import review_field_schema, review_projection, review_values
from .store import PersonaStore
from .studio_links import record_link


class ReviewInputError(ProposalError):
    def __init__(self, message, fields=None):
        super().__init__(message)
        self.fields = fields or {}


class CandidateReview:
    def __init__(self, data_root, state_root, locale="zh-CN"):
        self.data_root, self.state_root = data_root, state_root
        self.locale = locale
        self.repo = ProposalRepository(data_root)

    def selection(self, identifier):
        repository = ChangeSetRepository(self.data_root)
        if identifier.startswith("chg_"):
            manifest = repository.get(identifier)
            return manifest, [self.repo.get(i) for i in manifest.topological_proposal_ids()]
        proposal = self.repo.get(identifier)
        return repository.find_by_proposal_id(identifier), [proposal]

    def list(self, event_id):
        manifest, proposals = self.selection(event_id)
        store = PersonaStore(self.data_root).load()
        by_id = (
            {link.proposal_id: self.repo.get(link.proposal_id) for link in manifest.proposal_links}
            if manifest
            else {p.id: p for p in proposals}
        )
        references = {
            r.id: getattr(r, "title", getattr(r, "name", r.id))
            for loaded in store.records.values()
            if (r := loaded.record).status == "active"
            and r.entity_type in {"knowledge_node", "material", "course", "preference_context"}
        }
        for p in by_id.values():
            if p.status in {"pending_review", "deferred"}:
                v = review_values(p, store)
                references[p.target_id] = v.get("title") or v.get("name") or p.target_id
        source_titles = {
            r.record.source_ref: r.record.title
            for r in store.records.values()
            if r.record.entity_type == "material" and r.record.source_ref
        }
        for proposal in proposals:
            if proposal.target_entity_type == "material":
                v = review_values(proposal, store)
                if v.get("source_ref"):
                    source_titles[v["source_ref"]] = v.get("title", "来源材料")
        result = []
        for p in proposals:
            value = review_projection(p, store, self.locale, references)
            if value["entity_type"] == "relation":
                fields, values = {f["name"]: f for f in value["fields"]}, value["values"]
                source, target, relation = (
                    values.get(k, "") for k in ("source_id", "target_id", "relation_type")
                )
                label = fields.get("relation_type", {}).get("choices", {}).get(relation, relation)
                value["title"] = (
                    f"{references.get(source, source)} {label} {references.get(target, target)}"
                )
            value["sources"] = [
                {
                    "title": source_titles.get(
                        sid, store.sources[sid].origin.identifier or "来源材料"
                    ),
                    "url": store.sources[sid].origin.url,
                }
                for sid in dict.fromkeys(e.source_id for e in p.evidence_candidates)
                if sid in store.sources
            ]
            value["dependencies"] = [
                {
                    "id": i,
                    "title": review_projection(by_id[i], store, self.locale, references)["title"],
                }
                for i in (manifest.dependencies_of(p.id) if manifest else [])
                if by_id[i].status not in {"accepted", "edited_and_accepted"}
            ]
            value["pending_dependents"] = [
                i
                for i in (manifest.transitive_dependents_of(p.id) if manifest else [])
                if by_id[i].status in {"pending_review", "deferred"}
            ]
            value["dependent_titles"] = [
                review_projection(by_id[i], store, self.locale, references)["title"]
                for i in value["pending_dependents"]
            ]
            saved = store.records.get(p.target_id)
            value["record_url"] = (
                record_link(saved.record, store)
                if saved and p.status in {"accepted", "edited_and_accepted"}
                else None
            )
            result.append(value)
        return {"proposals": result, "references": references, "graph": self.graph(result, store)}

    @staticmethod
    def graph(proposals, store):
        nodes, edges = {}, []
        labels = {
            "pending_review": "待审核",
            "deferred": "稍后审核",
            "accepted": "已通过",
            "edited_and_accepted": "已通过",
            "rejected": "已拒绝",
            "stale": "已过期",
        }
        for p in proposals:
            v = p["values"]
            if p["entity_type"] in {"knowledge_node", "material"}:
                nodes[p["target_id"]] = {
                    "id": p["target_id"],
                    "title": p["title"],
                    "aliases": v.get("aliases", []),
                    "role": v.get(
                        "semantic_role", "area" if p["entity_type"] == "material" else "concept"
                    ),
                    "level": v.get("knowledge_level", "unspecified"),
                    "href": p.get("record_url") or "#",
                    "proposal_id": p["id"],
                    "status": p["status"],
                    "statusLabel": labels.get(p["status"], p["status"]),
                }
            elif p["entity_type"] == "relation":
                edges.append(
                    {
                        "id": p["id"],
                        "source": v.get("source_id"),
                        "target": v.get("target_id"),
                        "type": v.get("relation_type"),
                        "proposal_id": p["id"],
                        "status": p["status"],
                    }
                )

        def existing(record_id):
            loaded = store.records.get(record_id)
            if loaded and hasattr(loaded.record, "title"):
                r = loaded.record
                return {
                    "id": r.id,
                    "title": r.title,
                    "aliases": getattr(r, "aliases", []),
                    "role": getattr(r, "semantic_role", "concept"),
                    "level": getattr(r, "knowledge_level", "unspecified"),
                    "href": record_link(r, store),
                    "status": "existing",
                    "statusLabel": "已有",
                }

        for e in edges:
            for key in ("source", "target"):
                if e[key] not in nodes:
                    node = existing(e[key])
                    if node:
                        nodes[node["id"]] = node
        neighbors, context_edges = {}, []
        for loaded in store.records.values():
            r = loaded.record
            if (
                r.entity_type != "relation"
                or r.status != "active"
                or r.id in {p["target_id"] for p in proposals}
            ):
                continue
            if r.source_id in nodes or r.target_id in nodes:
                for rid in (r.source_id, r.target_id):
                    if rid not in nodes:
                        node = existing(rid)
                        if node:
                            neighbors[rid] = node
                if (
                    r.source_id in nodes.keys() | neighbors.keys()
                    and r.target_id in nodes.keys() | neighbors.keys()
                ):
                    context_edges.append(
                        {
                            "id": r.id,
                            "source": r.source_id,
                            "target": r.target_id,
                            "type": r.relation_type,
                            "status": "existing",
                            "href": record_link(r, store),
                        }
                    )
        return {
            "nodes": list(nodes.values()),
            "edges": [e for e in edges if e["source"] in nodes and e["target"] in nodes],
            "context_nodes": list(neighbors.values()),
            "context_edges": context_edges,
        }

    def decide(self, event_id, proposal_id, body):
        if (
            set(body) - {"action", "revision", "updates"}
            or type(body.get("revision")) is not int
            or body.get("action") not in {"accept", "reject", "defer"}
        ):
            raise ReviewInputError("请提供审核操作和候选版本。")
        _, proposals = self.selection(event_id)
        if proposal_id not in {p.id for p in proposals}:
            raise ReviewInputError("该候选不属于当前任务。")
        proposal = self.repo.get(proposal_id)
        if proposal.proposal_revision != body["revision"] or proposal.status not in {
            "pending_review",
            "deferred",
        }:
            raise StaleProposalError("候选已在其他位置处理，请重新读取后确认。")
        updates = body.get("updates", {})
        if not isinstance(updates, dict) or (body["action"] != "accept" and updates):
            raise ReviewInputError("修改内容必须是属性对象；拒绝和暂缓操作不接收修改。")
        store = PersonaStore(self.data_root).load()
        unknown = set(updates) - {
            f["name"] for f in review_field_schema(proposal, store) if not f["readonly"]
        }
        if unknown:
            raise ReviewInputError("包含不可修改的属性。", {k: "此属性不可修改" for k in unknown})
        if body["action"] == "accept":
            self.validate(proposal, store, updates)
        publisher = ProposalService(self.data_root, self.state_root)
        if body["action"] == "reject":
            publisher.reject_group(proposal_id, expected_proposal_revision=body["revision"])
        elif body["action"] == "defer":
            publisher.defer(proposal_id, expected_proposal_revision=body["revision"])
        else:
            publisher.accept(
                proposal_id, review_updates=updates, expected_proposal_revision=body["revision"]
            )
        # Never infer trigger feedback here. The publisher updates eligible content gold.
        return self.list(event_id)

    @staticmethod
    def validate(proposal, store, updates):
        if proposal.operation not in {"create", "update", "relate"}:
            return
        entity = proposal.target_entity_type or store.records[proposal.target_id].record.entity_type
        model = Relation if entity == "relation" else CREATE_TYPES[entity]
        payload = {
            "schema": SCHEMA_BY_TYPE[entity],
            "id": proposal.target_id,
            "entity_type": entity,
            "status": "active",
            "revision": 1,
            "created_at": proposal.created_at,
            "updated_at": proposal.updated_at,
            **review_values(proposal, store),
            **updates,
        }
        body = payload.pop("body", "")
        if not isinstance(body, str):
            raise ReviewInputError("请检查属性内容。", {"body": "备注必须是文本"})
        if entity == "relation" and payload.get("relation_type") == "related_to":
            source, target = payload.get("source_id"), payload.get("target_id")
            if isinstance(source, str) and isinstance(target, str) and source > target:
                payload["source_id"], payload["target_id"] = target, source
        try:
            model.model_validate(payload)
        except ValidationError as exc:
            errors = {}
            for error in exc.errors():
                names = (
                    [str(error["loc"][0])]
                    if error["loc"]
                    else (
                        ["scope", "context_refs"]
                        if entity == "preference"
                        else ["source_id", "target_id", "relation_type"]
                        if entity == "relation"
                        else ["_form"]
                    )
                )
                for name in names:
                    errors[name] = error["msg"]
            raise ReviewInputError("请检查标出的属性，尚未保存。", errors) from exc
