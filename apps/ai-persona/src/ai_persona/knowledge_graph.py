"""The active knowledge graph, without server-side presentation coordinates."""
from urllib.parse import quote

from .models import KnowledgeNode, Relation
from .store import PersonaStore


def knowledge_graph_data(store: PersonaStore) -> dict:
    nodes = store.of_type(KnowledgeNode, active_only=True)
    ids = {node.id for node in nodes}
    return {
        "nodes": [
            {
                "id": node.id,
                "title": node.title,
                "aliases": node.aliases,
                "role": node.semantic_role,
                "level": node.knowledge_level,
                "interest": node.interest_level,
                "href": f"/knowledge/{quote(node.id, safe='')}",
            }
            for node in nodes
        ],
        "edges": [
            {"id": edge.id, "source": edge.source_id, "target": edge.target_id,
             "type": edge.relation_type}
            for edge in store.of_type(Relation, active_only=True)
            if edge.source_id in ids and edge.target_id in ids
            and edge.relation_type in {"broader_than", "requires", "applied_in", "related_to"}
        ],
    }
