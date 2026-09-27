"""Idea relationships encoded as ordinary v1 resources for older Studio clients.

No new frontmatter keys: old readers, backups and full revision snapshots remain
compatible. The editor presents these managed links separately from attachments.
"""
import re

from .agent import AgentServiceError
from .library_references import library_items

KB_PREFIX = "res_kb_"
PROJECT_PREFIX = "res_project_"


def links(item):
    resources = item.get("resources", [])
    project = next(({"id": r["id"][len(PROJECT_PREFIX):], "title": r["title"]}
                    for r in resources if r["id"].startswith(PROJECT_PREFIX)), None)
    return {"related_refs": [r["id"][len(KB_PREFIX):] for r in resources
                             if r["id"].startswith(KB_PREFIX)], "project": project}


def linked_payload(item):
    return {**item, **links(item)}


def apply_links(data, values, store, origin, old_resources=()):
    resources = data.get("resources", [])
    if not isinstance(resources, list) or any(not isinstance(r, dict) for r in resources):
        raise AgentServiceError("invalid_request", "资源列表无效。")
    previous = {r.id: r.model_dump(mode="json") for r in old_resources}
    if "related_refs" in values:
        ids = values["related_refs"]
        if (not isinstance(ids, list) or len(ids) > 150 or
                any(not isinstance(i, str) or not re.fullmatch(r"ps_[a-f0-9]{16}_[a-f0-9]{32}", i) for i in ids)):
            raise AgentServiceError("invalid_reference", "知识与材料关联格式无效。")
        catalog = {r["id"]: r for r in library_items(store, origin)}
        resources = [r for r in resources if not str(r.get("id", "")).startswith(KB_PREFIX)]
        for identifier in dict.fromkeys(ids):
            old = previous.get(KB_PREFIX + identifier)
            item = catalog.get(identifier)
            if not old and (not item or item["archived"]):
                raise AgentServiceError("invalid_reference", "请选择当前知识库中未归档的知识或材料。已有引用仍可保留。")
            resources.append(old or {"id": KB_PREFIX + identifier, "kind": "link",
                                     "title": item["title"], "url": item["detail_url"], "note": "与它有关"})
    if "project" in values:
        project = values["project"]
        resources = [r for r in resources if not str(r.get("id", "")).startswith(PROJECT_PREFIX)]
        if project is not None:
            if (not isinstance(project, dict) or set(project) != {"id", "title"} or
                    not isinstance(project["id"], str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", project["id"]) or
                    not isinstance(project["title"], str) or not 1 <= len(project["title"].strip()) <= 1000):
                raise AgentServiceError("invalid_reference", "项目关联无效。")
            rid = PROJECT_PREFIX + project["id"]
            old = previous.get(rid)
            resources.append({**(old or {}), "id": rid, "kind": "link", "title": project["title"].strip(),
                              "url": old["url"] if old else origin + "/projects/#project/" + project["id"] + "/overview",
                              "note": "所属项目"})
    data["resources"] = resources
