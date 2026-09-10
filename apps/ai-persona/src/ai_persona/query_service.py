"""Agent query workflows over reviewed records and immutable sources."""

from __future__ import annotations

from collections import deque
from functools import wraps
from pathlib import Path

from .agent import (
    AgentServiceError,
    PersonaQueryService,
    _active_query,
)
from .change_sets import proposal_lock
from .models import Evidence, Material, PreferenceExample, Relation, Tag
from .query_contracts import (
    FileRef,
    QueryResult,
    SourceSelector,
    bounded_int,
    digest,
    encoded,
    next_page,
    page_offset,
    provenance,
    unpack,
)
from .query_retrieval import SemanticRetriever, lexical_score, normalize, terms
from .query_sources import EXTRACTOR_VERSION, SourceReader, file_id
from .store import PersonaStore

RELATIONS = {"broader_than", "part_of", "requires", "applied_in", "related_to", "covers"}
ENTITY_TYPES = {"knowledge_node", "course", "material"}


def query_read(operation):
    @wraps(operation)
    def wrapped(self, *args, **kwargs):
        with proposal_lock(self.state_root):
            # Validate records/manifests now and file content when actually read. A missing
            # or unparseable attachment must not make every knowledge read fail.
            store = self.snapshot_store if self.snapshot_store is not None else PersonaStore(self.data_root).load(verify_source_files=False)
            token = _active_query.set((self, store))
            try:
                return operation(self, *args, **kwargs)
            finally:
                _active_query.reset(token)
    return wrapped


class KnowledgeQueryService(PersonaQueryService):
    """Shares canonical scope/publication primitives with the Studio services."""

    def __init__(self, data_root: Path, state_root: Path, *, retriever=None, extra_sources=None,
                 snapshot_store=None):
        super().__init__(data_root, state_root)
        self.retriever = retriever if retriever is not None else SemanticRetriever(state_root)
        self.extra_sources = set(extra_sources or ())
        self.snapshot_store = snapshot_store

    def _context(self, scope, expected):
        store = self._store()
        revision = self._revision(store)
        if expected is not None and expected != revision:
            raise AgentServiceError("version_changed", "Persona changed; refresh this read.",
                                    details={"persona_revision": revision})
        resolved = self._resolve_scope(store, scope)
        allowed = self._scope_records(store, resolved)
        sources = self._scope_sources(store, allowed)
        if resolved is None:
            sources.update(s.source_ref for s in store.of_type(PreferenceExample, active_only=True))
            visible = allowed | {e.id for e in self._edges(store, allowed)}
            sources.update(e.source_id for e in store.of_type(Evidence, active_only=True)
                           if set(e.supports).intersection(visible))
        sources.update(self.extra_sources)
        return store, revision, resolved, allowed, SourceReader(store, self.state_root, sources)

    @query_read
    def search_preferences(self, *, query="", context_ids=None, statuses=None, limit=16,
                           expected_persona_revision=None, max_chars=24000, cursor=None):
        bounded_int(limit, 1, 50, "limit")
        bounded_int(max_chars, 1000, 200000, "max_chars")
        if len(query) > 12000 or (statuses and set(statuses) - {"active", "paused", "archived"}):
            raise AgentServiceError("invalid_arguments", "Invalid preference search filters.")
        store, revision, _, _, _ = self._context(None, expected_persona_revision)
        records = [v for v in store.records.values()
                   if v.record.entity_type.startswith("preference")
                   and (v.record.status in statuses if statuses else v.record.status != "archived")]
        if context_ids:
            records = [v for v in records if v.record.id in context_ids or
                       set(getattr(v.record, "context_refs", [])) & set(context_ids)]
        # Same lexical + semantic retriever as knowledge; include context wording in each document.
        docs = {}
        for loaded in records:
            value = loaded.record.model_dump(mode="json")
            contexts = [store.records[c].record.model_dump(mode="json")
                        for c in value.get("context_refs", []) if c in store.records]
            docs[loaded.record.id] = encoded({"record": value, "contexts": contexts,
                                             "body": loaded.body})
        scores = {rid: lexical_score(query, text) for rid, text in docs.items()}
        semantic_status = {"status": "not_requested"}
        if query and docs:
            semantic, semantic_status = self.retriever.rank(query, docs)
            for rid, score in semantic.items():
                scores[rid] = max(scores[rid], score)
        ranked = sorted(records, key=lambda v: (-scores[v.record.id], v.record.id))[:limit]
        rows = [{"id": v.record.id, "entity_type": v.record.entity_type,
                 "record": v.record.model_dump(mode="json"), "provenance": provenance(v.record),
                 "detail_loaded": False} for v in ranked]
        signature = self._signature(store, "preferences", {"query": query, "contexts": context_ids,
                                    "statuses": statuses, "limit": limit, "budget": max_chars})
        result = self._page("search_preferences", revision, None, rows,
                            lambda x: {"items": x, "retrieval": {"semantic": semantic_status}},
                            signature, cursor, 50, max_chars)
        result.coverage["total_count_kind"] = "retrieved_candidates"
        if semantic_status["status"] in {"unavailable", "disabled"}:
            result.coverage["status"] = "degraded"
            result.warnings.append("Semantic retrieval is " + semantic_status["status"] + ".")
        return result

    @query_read
    def get_preference_records(self, *, record_ids, expected_persona_revision=None,
                               max_chars=24000, cursor=None):
        if not record_ids or len(record_ids) > 10:
            raise AgentServiceError("invalid_arguments", "Provide 1–10 record_ids.")
        store, revision, _, _, _ = self._context(None, expected_persona_revision)
        rows = []
        for rid in dict.fromkeys(record_ids):
            loaded = store.records.get(rid)
            if not loaded or not loaded.record.entity_type.startswith("preference"):
                rows.append({"id": rid, "error": {"code": "not_found_or_not_visible"}})
                continue
            rows.append({"id": rid, "record": loaded.record.model_dump(mode="json"),
                         "body": loaded.body, "record_revision": loaded.record.revision,
                         "provenance": provenance(loaded.record), "completeness": "complete",
                         "omitted_fields": []})
        signature = self._signature(store, "preference-records", {"ids": record_ids,
                                                                  "budget": max_chars})
        return self._page("get_preference_records", revision, None, rows, lambda x: {"items": x},
                          signature, cursor, 50, max_chars)

    @staticmethod
    def _node(store, rid):
        record = store.records[rid].record
        fields = {"id", "entity_type", "title", "aliases", "summary", "description",
                  "knowledge_level", "interest_level", "scope_note", "semantic_role",
                  "tags", "user_relationships", "material_type", "preference_level",
                  "source_ref"}
        value = record.model_dump(mode="json", by_alias=True)
        result = {k: v for k, v in value.items() if k in fields}
        result.update(record_revision=record.revision, provenance=provenance(record),
                      has_notes=bool(store.records[rid].body))
        return result

    @staticmethod
    def _edge(record, evidence_ids):
        result = record.model_dump(mode="json", by_alias=True)
        for key in ("schema", "status", "created_at", "updated_at", "revision", "entity_type"):
            result.pop(key, None)
        result.update(record_revision=record.revision, provenance=provenance(record))
        result["evidence_refs"] = [eid for eid in record.evidence_refs if eid in evidence_ids]
        return result

    def _visible_evidence(self, store, scope, allowed, reader):
        visible = allowed | {e.id for e in self._edges(store, allowed)}
        return {e.id for e in store.of_type(Evidence, active_only=True)
                if e.source_id in reader.allowed_sources
                and (scope is None or set(e.supports) <= visible)}

    @staticmethod
    def _edges(store, allowed, relation_types=None, knowledge_role=None, salience=None):
        if relation_types is not None and (not relation_types or set(relation_types) - RELATIONS):
            raise AgentServiceError("invalid_arguments", "Unknown or empty relation_types.")
        return [r for r in store.of_type(Relation, active_only=True)
                if {r.source_id, r.target_id} <= allowed
                and (relation_types is None or r.relation_type in relation_types)
                and (knowledge_role is None or r.knowledge_role == knowledge_role)
                and (salience is None or r.salience == salience)]

    @staticmethod
    def _focus(focus_ids, allowed):
        if focus_ids is not None:
            if not focus_ids or len(focus_ids) > 10:
                raise AgentServiceError("invalid_arguments", "Provide 1–10 focus_ids.")
            if not set(focus_ids) <= allowed:
                raise AgentServiceError("not_found_or_not_visible", "Focus record is not available.")
        return sorted(set(focus_ids or []))

    @staticmethod
    def _walk(edges, origins, max_hops, direction):
        bounded_int(max_hops, 1, 2, "max_hops")
        if direction not in {"incoming", "outgoing", "both"}:
            raise AgentServiceError("invalid_arguments", "Unknown direction.")
        adjacency = {}
        for edge in edges:
            if direction in {"outgoing", "both"}:
                adjacency.setdefault(edge.source_id, []).append((edge.target_id, edge.id))
            if direction in {"incoming", "both"}:
                adjacency.setdefault(edge.target_id, []).append((edge.source_id, edge.id))
        found = {rid: {"distance": 0, "path_relation_ids": [], "origin_id": rid}
                 for rid in origins}
        queue = deque(origins)
        while queue:
            current = queue.popleft()
            path = found[current]
            if path["distance"] >= max_hops:
                continue
            for other, eid in sorted(adjacency.get(current, [])):
                if other in found:
                    continue
                found[other] = {"distance": path["distance"] + 1,
                                "path_relation_ids": path["path_relation_ids"] + [eid],
                                "origin_id": path["origin_id"]}
                queue.append(other)
        return found

    def _signature(self, store, tool, arguments):
        # Include canonical content as well as the revision; development edits cannot
        # silently reuse a cursor or cache that came from different data.
        return digest({"tool": tool, "arguments": arguments,
                       "records": [(rid, loaded.record.model_dump(mode="json"), loaded.body)
                                   for rid, loaded in sorted(store.records.items())],
                       "sources": [s.model_dump(mode="json") for _, s in sorted(store.sources.items())],
                       "retriever": self.retriever.signature})

    @staticmethod
    def _result(tool, revision, scope, data, **coverage):
        return QueryResult(tool=tool, persona_revision=revision, scope=scope, data=data,
                           coverage={"status": "complete", "truncated": False, **coverage})

    def _page(self, tool, revision, scope, units, builder, signature, cursor, limit, max_chars):
        bounded_int(max_chars, 1000, 200000, "max_chars")
        offset = page_offset(cursor, signature)
        if offset > len(units):
            raise AgentServiceError("invalid_cursor", "Cursor is outside the result.")
        chosen = []
        result = self._result(tool, revision, scope, builder(chosen), total_count=len(units))
        for unit in units[offset:offset + limit]:
            candidate = self._result(tool, revision, scope, builder(chosen + [unit]),
                                     total_count=len(units), returned_count=len(chosen) + 1)
            # Reserve space for continuation and coverage metadata.
            if len(encoded(candidate.model_dump(mode="json"))) + 500 > max_chars:
                break
            chosen.append(unit)
            result = candidate
        if not chosen and offset < len(units):
            raise AgentServiceError("budget_too_small", "Increase max_chars to read the next item.")
        complete = offset + len(chosen) >= len(units)
        result.coverage.update(returned_count=len(chosen), offset=offset,
                               status="complete" if complete else "partial", truncated=not complete)
        if not complete:
            result.next_cursor = next_page(signature, offset + len(chosen))
        if len(encoded(result.model_dump(mode="json"))) + 300 > max_chars:
            raise AgentServiceError("budget_too_small", "Increase max_chars for result metadata.")
        return result

    @query_read
    def get_knowledge_map(self, *, focus_ids=None, max_hops=1, relation_types=None,
                          direction="both", knowledge_role=None, salience=None, scope=None,
                          expected_persona_revision=None, max_chars=32000, cursor=None):
        store, revision, scope, allowed, reader = self._context(scope, expected_persona_revision)
        evidence_ids = self._visible_evidence(store, scope, allowed, reader)
        focus = self._focus(focus_ids, allowed)
        edges = self._edges(store, allowed, relation_types, knowledge_role, salience)
        paths = self._walk(edges, focus, max_hops, direction)
        selected = set(paths) if focus else allowed
        selected_edges = [e for e in edges if {e.source_id, e.target_id} <= selected]
        domains = [
            {"id": t.id, "label": t.label, "aliases": t.aliases, "namespace": t.namespace,
             "record_count": sum(t.id in store.records[r].record.tags for r in allowed),
             "provenance": provenance(t)}
            for t in store.of_type(Tag, active_only=True)
            if scope is None or t.id in scope.tag_ids
        ]
        order = sorted(selected, key=lambda rid: (
            paths.get(rid, {}).get("distance", 0),
            store.records[rid].record.entity_type == "material",
            normalize(store.records[rid].record.title), rid,
        ))
        units, emitted_edges = [], set()
        for rid in order:
            units.append(("node", rid))
            for edge in sorted(selected_edges, key=lambda r: r.id):
                if edge.id not in emitted_edges and rid in {edge.source_id, edge.target_id}:
                    units.append(("edge", edge.id))
                    emitted_edges.add(edge.id)
        edge_map = {e.id: e for e in selected_edges}

        def build(page):
            ids = [rid for kind, rid in page if kind == "node"]
            rels = [edge_map[rid] for kind, rid in page if kind == "edge"]
            frontier = {rid for e in rels for rid in (e.source_id, e.target_id)} - set(ids)
            if focus:
                frontier.update({rid for e in edges for rid in (e.source_id, e.target_id)
                                 if e.source_id in selected or e.target_id in selected} - selected)
            return {
                "view": "neighborhood" if focus else "overview", "domains": domains,
                "nodes": [self._node(store, rid) for rid in ids],
                "edges": [self._edge(e, evidence_ids) for e in rels],
                "frontier": [{"id": rid, "title": store.records[rid].record.title,
                              "provenance": provenance(store.records[rid].record)}
                             for rid in sorted(frontier)],
                "counts": {"nodes": len(selected), "edges": len(selected_edges),
                           "untagged": sum(not store.records[r].record.tags for r in selected)},
            }
        arguments = {"focus": focus, "hops": max_hops, "relations": relation_types,
                     "direction": direction, "role": knowledge_role, "salience": salience,
                     "scope": scope.model_dump() if scope else None}
        return self._page("get_knowledge_map", revision, scope, units, build,
                          self._signature(store, "map", arguments), cursor, len(units), max_chars)

    @staticmethod
    def _matches(record, filters):
        for field, values in filters.items():
            if values is None:
                continue
            if not values:
                raise AgentServiceError("invalid_arguments", f"{field} cannot be empty.")
            actual = getattr(record, field, None)
            if isinstance(actual, list):
                if not set(values).intersection(actual):
                    return False
            elif actual not in values:
                return False
        return True

    def _corpus(self, store, reader, allowed, edges):
        documents = {}
        owners = {}
        excerpts = {}
        index_coverage = []
        for rid in sorted(allowed):
            loaded = store.records[rid]
            r = loaded.record
            documents["node:" + rid] = "\n".join(str(v) for v in (
                r.title, " ".join(r.aliases), getattr(r, "scope_note", "") or "",
                getattr(r, "summary", ""), getattr(r, "description", ""),
                getattr(r, "syllabus", ""), loaded.body,
            ) if v)
            owners["node:" + rid] = [rid]
            # Keep names independently searchable; a long explanation should not
            # dilute cross-language matching of a short concept name.
            documents["name:" + rid] = r.title + ". " + "; ".join(r.aliases)
            owners["name:" + rid] = [rid]
        for edge in edges:
            key = "edge:" + edge.id
            documents[key] = " ".join([
                store.records[edge.source_id].record.title, edge.relation_type,
                store.records[edge.target_id].record.title, edge.statement or "",
            ])
            owners[key] = [edge.source_id, edge.target_id]
        by_source = {}
        for rid in sorted(allowed):
            record = store.records[rid].record
            if isinstance(record, Material):
                by_source.setdefault(record.source_ref, []).append(rid)
        for sid, material_ids in by_source.items():
            source = reader.manifest(sid)
            extracted = [f for f in source.files if f.role == "extracted_text"]
            files = extracted or [reader.by_path(sid, source.canonical_file)]
            for file in files:
                try:
                    chunks = reader.chunks(sid, file)
                    index_coverage.append({"source_id": sid, "file_id": file_id(file),
                                           "status": "ready" if chunks else "no_text"})
                    for chunk in chunks:
                        key = "chunk:" + sid + ":" + chunk["id"]
                        documents[key] = chunk["text"]
                        owners[key] = material_ids
                        excerpts[key] = chunk
                except (ValueError, OSError) as exc:
                    index_coverage.append({"source_id": sid, "file_id": file_id(file),
                                           "status": getattr(exc, "code", "parse_failed")})
        return documents, owners, excerpts, index_coverage

    @query_read
    def search_knowledge(self, *, query="", focus_ids=None, focus_mode="prefer", max_hops=1,
                         relation_types=None, direction="both", entity_types=None,
                         knowledge_levels=None, interest_levels=None, material_types=None,
                         user_relationships=None, scope=None, expected_persona_revision=None,
                         limit=10, max_chars=24000, cursor=None):
        bounded_int(limit, 1, 50, "limit")
        if focus_mode not in {"prefer", "only"} or (focus_mode == "only" and not focus_ids):
            raise AgentServiceError("invalid_arguments", "only requires explicit focus_ids.")
        if len(query) > 12000:
            raise AgentServiceError("invalid_arguments", "query exceeds 12000 characters.")
        filters = {"entity_type": entity_types, "knowledge_level": knowledge_levels,
                   "interest_level": interest_levels, "material_type": material_types,
                   "user_relationships": user_relationships}
        if entity_types and set(entity_types) - ENTITY_TYPES:
            raise AgentServiceError("invalid_arguments", "Unsupported entity_types.")
        if not query.strip() and (focus_ids or not (any(v is not None for v in filters.values())
                                                   or scope is not None)):
            raise AgentServiceError("invalid_arguments", "Provide a query or structured filters.")
        if query.strip() and not terms(query):
            raise AgentServiceError("invalid_arguments", "Query has no searchable terms.")
        store, revision, scope, allowed, reader = self._context(scope, expected_persona_revision)
        evidence_ids = self._visible_evidence(store, scope, allowed, reader)
        focus = self._focus(focus_ids, allowed)
        edges = self._edges(store, allowed, relation_types)
        focus_paths = self._walk(edges, focus, max_hops, direction)
        if focus_mode == "only":
            allowed = set(focus_paths)
            edges = [e for e in edges if {e.source_id, e.target_id} <= allowed]
        eligible = {rid for rid in allowed if self._matches(store.records[rid].record, filters)}
        score = {}
        reasons = {}
        hit_paths = {}
        chosen_excerpts = {}
        semantic_status = {"status": "not_requested"}
        indexed = []
        if query.strip() and allowed:
            documents, owners, excerpts, indexed = self._corpus(store, reader, allowed, edges)
            semantic, semantic_status = self.retriever.rank(query, documents)
            for key, text in documents.items():
                lex = lexical_score(query, text)
                sem = semantic.get(key, 0)
                if lex == 0 and sem < 0.36:
                    continue
                value = max(lex, max(0, sem - 0.25) * 1.5)
                if key.startswith(("node:", "name:")):
                    r = store.records[owners[key][0]].record
                    if key.startswith("name:"):
                        value *= 1.15
                    if normalize(query).strip() == normalize(r.title).strip():
                        value += 3
                        reason = "title_match"
                    elif normalize(query).strip() in {normalize(a).strip() for a in r.aliases}:
                        value += 3
                        reason = "alias_match"
                    else:
                        # A named concept inside a longer question deserves more weight
                        # than incidental mentions scattered through a full paper.
                        name_overlap = max(lexical_score(name, query)
                                           for name in [r.title, *r.aliases])
                        value += 1.5 * name_overlap
                        reason = "text_match" if lex else "semantic_related"
                else:
                    value *= 0.6 if key in excerpts else 0.8
                    reason = "source_text_match" if key in excerpts else "relation_match"
                    if not lex:
                        reason = "semantic_related"
                for rid in owners[key]:
                    score[rid] = max(score.get(rid, 0), value)
                    reasons.setdefault(rid, set()).add(reason)
                    if key.startswith("edge:"):
                        hit_paths.setdefault(rid, [key.removeprefix("edge:")])
                    if key in excerpts:
                        previous = chosen_excerpts.get(rid)
                        if previous is None or previous[0] < value:
                            chosen_excerpts[rid] = (value, excerpts[key])
            seeds = focus or sorted(score, key=lambda rid: (-score[rid], rid))[:5]
            for rid in focus:
                score[rid] = max(score.get(rid, 0), 0.7)
                reasons.setdefault(rid, set()).add("focus_anchor")
            expanded = self._walk(edges, seeds, max_hops, direction)
            for rid, path in expanded.items():
                if path["distance"] == 0:
                    continue
                value = min(max(score.get(path["origin_id"], 0), 0.7), 1) * (0.35 ** path["distance"])
                score[rid] = max(score.get(rid, 0), value)
                reasons.setdefault(rid, set()).add("graph_expansion")
                hit_paths[rid] = path["path_relation_ids"]
            for rid in focus_paths:
                if rid in score:
                    score[rid] += 0.15
            ranked = sorted(eligible.intersection(score), key=lambda rid: (-score[rid], rid))
        else:
            ranked = sorted(eligible)
        edge_map = {e.id: e for e in edges}

        def build(ids):
            relation_ids = {eid for rid in ids for eid in hit_paths.get(rid, []) if eid in edge_map}
            available_context = set()
            for rid in ids:
                neighbors = sorted((e for e in edges if rid in {e.source_id, e.target_id}),
                                   key=lambda e: (e.salience != "primary", e.id))
                available_context.update(e.id for e in neighbors)
                relation_ids.update(e.id for e in neighbors[:2])
            rels = [edge_map[eid] for eid in sorted(relation_ids)]
            node_ids = set(ids) | {rid for e in rels for rid in (e.source_id, e.target_id)}
            return {
                "hits": [{"id": rid, "match_reasons": sorted(reasons.get(rid, {"structured_filter"})),
                          "path_relation_ids": hit_paths.get(rid, [])} for rid in ids],
                "nodes": [{**self._node(store, rid), "retrieval_role":
                           "hit" if rid in ids else "context"} for rid in sorted(node_ids)],
                "edges": [self._edge(e, evidence_ids) for e in rels],
                "excerpts": [{**chosen_excerpts[rid][1], "material_id": rid}
                             for rid in ids if rid in chosen_excerpts],
                "retrieval": {"semantic": semantic_status, "source_index": indexed,
                              "focus_mode": focus_mode,
                              "context_edges_not_returned": len(available_context - relation_ids)},
            }
        signature = self._signature(store, "search", {
            "query": query, "focus": focus, "mode": focus_mode, "hops": max_hops,
            "relations": relation_types, "direction": direction, "filters": filters,
            "scope": scope.model_dump() if scope else None, "semantic_status": semantic_status,
        })
        result = self._page("search_knowledge", revision, scope, ranked, build,
                            signature, cursor, limit, max_chars)
        result.coverage["total_count_kind"] = "retrieved_candidates"
        if semantic_status["status"] in {"unavailable", "disabled"}:
            result.coverage["status"] = "degraded"
            result.warnings.append("Semantic retrieval is " + semantic_status["status"] + ".")
        if any(row["status"] != "ready" for row in indexed):
            result.coverage["status"] = "degraded"
            result.warnings.append("Some source files have no searchable text; see source_index.")
        return result

    @query_read
    def get_persona_records(self, *, record_ids, fields=None, include_evidence=False,
                            scope=None, expected_persona_revision=None, max_chars=24000,
                            cursor=None):
        if not record_ids or len(record_ids) > 10:
            raise AgentServiceError("invalid_arguments", "Provide 1–10 record_ids.")
        store, revision, scope, allowed, reader = self._context(scope, expected_persona_revision)
        evidence_ids = self._visible_evidence(store, scope, allowed, reader)
        allowed = allowed | {r.id for r in self._edges(store, allowed)}
        if scope is None:
            allowed |= {r.record.id for r in store.records.values()
                        if r.record.entity_type in ENTITY_TYPES | {"relation"}}
        units = []
        for rid in dict.fromkeys(record_ids):
            if rid not in allowed:
                units.append({"id": rid, "error": {"code": "not_found_or_not_visible"}})
                continue
            loaded = store.records[rid]
            value = loaded.record.model_dump(mode="json", by_alias=True)
            if "evidence_refs" in value:
                value["evidence_refs"] = [eid for eid in value["evidence_refs"] if eid in evidence_ids]
            if fields:
                unknown = set(fields) - (set(value) | {"body"})
                if unknown:
                    raise AgentServiceError("invalid_arguments", "Unknown record fields.",
                                            details={"fields": sorted(unknown)})
            record = {k: v for k, v in value.items() if fields is None or k in fields}
            body = loaded.body if fields is None or "body" in fields else None
            item = {"id": rid, "entity_type": loaded.record.entity_type, "record": record,
                    "body": body, "record_revision": loaded.record.revision,
                    "provenance": provenance(loaded.record), "completeness": "complete",
                    "omitted_fields": sorted(set(value) - set(record)), "evidence": []}
            if include_evidence:
                for eid in value.get("evidence_refs", []):
                    e = store.records[eid].record
                    if isinstance(e, Evidence) and e.status == "active" and e.source_id in reader.allowed_sources:
                        item["evidence"].append({**e.model_dump(mode="json", by_alias=True),
                                                 "provenance": provenance(e)})
            if len(encoded(item)) < max_chars - 1500:
                units.append(item)
            else:
                long = {k: v for k, v in record.items() if isinstance(v, str) and len(v) > 500}
                if body:
                    long["body"] = body
                base = {**item, "record": {k: v for k, v in record.items() if k not in long},
                        "body": None, "completeness": "partial", "continued_fields": list(long)}
                units.append(base)
                for field, value in long.items():
                    size = max(100, max_chars - 2000)
                    offset = 0
                    while offset < len(value):
                        piece = value[offset:offset + size]
                        while len(encoded(piece)) > max_chars - 1500 and len(piece) > 1:
                            piece = piece[:len(piece) // 2]
                        units.append({"id": rid, "record_revision": loaded.record.revision,
                                      "provenance": provenance(loaded.record, field),
                                      "completeness": "partial", "field": field,
                                      "value": piece, "offset": offset,
                                      "total_chars": len(value)})
                        offset += len(piece)
        signature = self._signature(store, "records", {
            "ids": record_ids, "fields": fields, "evidence": include_evidence,
            "scope": scope.model_dump() if scope else None, "budget": max_chars,
        })
        return self._page("get_persona_records", revision, scope, units, lambda rows: {"items": rows},
                          signature, cursor, len(units), max_chars)

    @query_read
    def list_source_files(self, *, source_id, directory="", recursive=False, file_types=None,
                          limit=50, scope=None, expected_persona_revision=None,
                          max_chars=16000, cursor=None):
        bounded_int(limit, 1, 200, "limit")
        store, revision, scope, allowed, reader = self._context(scope, expected_persona_revision)
        source = reader.manifest(source_id)
        rows = reader.entries(source_id, directory, recursive, file_types)
        data = {"source_id": source_id, "source_hash": "sha256:" + source.content_hash,
                "canonical_file": file_id(reader.by_path(source_id, source.canonical_file)),
                "owner_refs": [provenance(r.record) for r in store.records.values()
                               if getattr(r.record, "source_ref", None) == source_id
                               and r.record.status == "active"
                               and (r.record.id in allowed or (scope is None
                                    and isinstance(r.record, PreferenceExample)))]}
        signature = self._signature(store, "files", {
            "source": source_id, "directory": directory, "recursive": recursive,
            "types": file_types, "scope": scope.model_dump() if scope else None,
        })
        return self._page("list_source_files", revision, scope, rows,
                          lambda entries: {**data, "entries": entries}, signature, cursor,
                          limit, max_chars)

    @query_read
    def search_source_content(self, *, query, source_ids=None, files=None, limit=10,
                              context_chars=600, scope=None, expected_persona_revision=None,
                              max_chars=24000, cursor=None):
        bounded_int(limit, 1, 50, "limit")
        bounded_int(context_chars, 100, 4000, "context_chars")
        if not query.strip() or not terms(query) or len(query) > 12000:
            raise AgentServiceError("invalid_arguments", "Provide a searchable query.")
        if bool(source_ids) == bool(files):
            raise AgentServiceError("invalid_arguments", "Provide source_ids or files, exclusively.")
        store, revision, scope, _, reader = self._context(scope, expected_persona_revision)
        selected = []
        if source_ids:
            for sid in sorted(set(source_ids)):
                selected.extend((sid, f) for f in reader.manifest(sid).files)
        else:
            for ref in files:
                ref = FileRef.model_validate(ref) if isinstance(ref, dict) else ref
                selected.append((ref.source_id, reader.resolve(ref.source_id, ref.file_id)))
        chunks = {}
        coverage = []
        for sid, file in selected:
            try:
                values = reader.chunks(sid, file)
                coverage.append({"source_id": sid, "file_id": file_id(file),
                                 "status": "ready" if values else "no_text"})
                for value in values:
                    chunks[sid + ":" + value["id"]] = value
            except (ValueError, OSError) as exc:
                coverage.append({"source_id": sid, "file_id": file_id(file),
                                 "status": getattr(exc, "code", "parse_failed")})
        semantic, status = self.retriever.rank(query, {key: c["text"] for key, c in chunks.items()})
        scores = {}
        for key, chunk in chunks.items():
            lex = lexical_score(query, chunk["text"])
            sem = semantic.get(key, 0)
            if lex or sem >= 0.36:
                scores[key] = max(lex, max(0, sem - 0.25) * 1.5)
                chunk["match_reasons"] = [
                    *(["text_match"] if lex else []), *(["semantic_related"] if sem >= 0.36 else []),
                ]
        ranked = sorted(scores, key=lambda key: (-scores[key], key))
        def build(keys):
            matches = []
            for key in keys:
                chunk = chunks[key]
                # The passage_ref retains the whole located chunk for further reading.
                matches.append({**chunk, "text": chunk["text"][:context_chars],
                                "text_truncated": len(chunk["text"]) > context_chars})
            return {"matches": matches, "index_coverage": coverage, "semantic": status}
        signature = self._signature(store, "source-search", {
            "query": query, "files": sorted((sid, file_id(f)) for sid, f in selected),
            "context_chars": context_chars, "scope": scope.model_dump() if scope else None,
            "semantic_status": status,
        })
        result = self._page("search_source_content", revision, scope, ranked, build,
                            signature, cursor, limit, max_chars)
        if status["status"] != "ready" or any(c["status"] != "ready" for c in coverage):
            result.coverage["status"] = "degraded"
            result.warnings.append("Search coverage is partial; inspect per-file and semantic status.")
        result.coverage["total_count_kind"] = "retrieved_candidates"
        return result

    @query_read
    def read_source(self, *, source_id=None, file_id=None, evidence_id=None, passage_ref=None,
                    view="auto", selector=None, max_images=1, scope=None,
                    expected_persona_revision=None, max_chars=16000):
        bounded_int(max_chars, 1000, 200000, "max_chars")
        bounded_int(max_images, 1, 4, "max_images")
        if (sum(bool(x) for x in (source_id or file_id, evidence_id, passage_ref)) != 1
                or bool(source_id) != bool(file_id)):
            raise AgentServiceError("invalid_arguments", "Provide a file, evidence, or passage reference.")
        store, revision, scope, allowed, reader = self._context(scope, expected_persona_revision)
        selector = SourceSelector.model_validate(selector or {}) if isinstance(selector, (dict, type(None))) else selector
        expected_hash = None
        if evidence_id:
            loaded = store.records.get(evidence_id)
            evidence = loaded.record if loaded else None
            if not isinstance(evidence, Evidence) or evidence.status != "active":
                raise AgentServiceError("not_found_or_not_visible", "Evidence is not available.")
            allowed_relations = {e.id for e in self._edges(store, allowed)}
            if scope is not None and not set(evidence.supports) <= allowed | allowed_relations:
                raise AgentServiceError("not_found_or_not_visible", "Evidence is not in scope.")
            source_id = evidence.source_id
            source = reader.manifest(source_id)
            expected_hash = evidence.source_hash.removeprefix("sha256:")
            if expected_hash != source.content_hash:
                raise AgentServiceError("source_changed", "Evidence refers to a different source hash.")
            file = reader.by_path(source_id, str(evidence.locator.get("file", source.canonical_file)))
            locator = evidence.locator
            if not selector.model_fields_set:
                if "line_start" in locator:
                    selector = SourceSelector.model_validate({"lines": {
                        "start": locator["line_start"], "end": locator.get("line_end", locator["line_start"]),
                    }})
                elif "page" in locator:
                    selector = SourceSelector(pages=[int(locator["page"])])
            if view == "auto":
                view = "text"
        elif passage_ref:
            reference = unpack(passage_ref)
            if (set(reference) != {"source_id", "file_id", "file_hash", "selector", "extractor_version"}
                    or reference["extractor_version"] != EXTRACTOR_VERSION):
                raise AgentServiceError("invalid_arguments", "Unsupported passage reference.")
            source_id, file_id = reference["source_id"], reference["file_id"]
            file = reader.resolve(source_id, file_id)
            if file.sha256 != reference["file_hash"]:
                raise AgentServiceError("source_changed", "Passage belongs to a different source.")
            if not selector.model_fields_set:
                selector = SourceSelector.model_validate(reference["selector"])
            if view == "auto":
                view = "text"
        else:
            file = reader.resolve(source_id, file_id)
        # Leave space for the envelope and locator; adjust for JSON escaping below.
        budget = max(100, max_chars - 2000)
        while True:
            data, images = reader.read(source_id, file, view, selector, budget, max_images)
            result = self._result("read_source", revision, scope, data,
                                  truncated=data["truncated"],
                                  status="partial" if data["truncated"] else "complete")
            if evidence_id:
                result.data["evidence_provenance"] = provenance(evidence)
            if len(encoded(result.model_dump(mode="json"))) <= max_chars:
                result._images = images
                return result
            budget //= 2
            if budget < 50:
                raise AgentServiceError("budget_too_small", "Increase max_chars for source metadata.")
