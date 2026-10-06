"""Read-only, content-first projections for the Persona home page."""

from collections import Counter
from datetime import date
from urllib.parse import urlencode

from .i18n import label_map
from .proposals import ProposalError
from .review import proposal_presentation, review_values
from .studio_links import record_link


def pending_breakdown(proposals, store, locale):
    counts = Counter()
    for proposal in proposals:
        loaded = store.records.get(proposal.target_id)
        entity = proposal.target_entity_type or (loaded.record.entity_type if loaded else "")
        counts[entity] += 1
    labels = label_map(locale, "entity")
    return " · ".join(
        f"{count} {'条' if locale == 'zh-CN' else ''}{labels.get(entity, entity)}"
        for entity, count in counts.items()
    )


def recent_changes(revisions, repository, store, locale, *, limit=8):
    """Link confirmed changes to records, or to their audit when unavailable.

    Summaries use final proposals (including human corrections), not model
    reasoning or raw user prompts. Missing historical proposals are tolerated.
    """
    items = []
    for revision in revisions:
        for proposal_id in revision.get("proposal_ids", []):
            try:
                proposal = repository.get(proposal_id)
            except ProposalError:
                continue
            if proposal.status not in {"accepted", "edited_and_accepted"}:
                continue
            card = proposal_presentation(proposal, store, locale)
            values = review_values(proposal, store)
            values.update({change.field: change.after for change in proposal.review_patch})
            summary = card["summary"] if proposal.operation == "update" else next(
                (values[field] for field in ("summary", "description", "statement", "condition")
                 if isinstance(values.get(field), str) and values[field].strip()),
                "已确认并保存到 Persona。" if locale == "zh-CN" else "Confirmed and saved to Persona.",
            )
            loaded = store.records.get(proposal.target_id)
            url = "/inbox?" + urlencode({"view": "all", "proposal": proposal.id})
            if loaded and loaded.record.status == "active" and card["entity_type"] in {
                "knowledge_node", "course", "material", "preference", "preference_context",
                "preference_example", "relation",
            }:
                url = record_link(loaded.record, store)
            items.append({
                **card, "summary": summary, "url": url,
                "published_at": revision.get("published_at", ""),
                "revision": revision.get("persona_revision"),
            })
            if len(items) >= limit:
                return items
    return items


def studio_home(proposals, store, locale, *, grouped_ids=frozenset(), limit=4):
    """Extra projections for the Studio overview; titles and links only."""
    from .models import Idea, KnowledgeNode

    pending = []
    for proposal in sorted(proposals, key=lambda item: item.created_at, reverse=True)[:limit]:
        try:
            card = proposal_presentation(proposal, store, locale)
        except (ProposalError, KeyError, ValueError):
            continue
        pending.append({
            "title": card["title"], "action": card["action"],
            "entity_type": card["entity_type"],
            "created": proposal.created_at.date().isoformat(),
            "url": f"/review/{proposal.id}",
            "accept_url": f"/review/{proposal.id}/accept",
            # Grouped or conflicting candidates need the full review to keep dependencies intact.
            "quick_accept": proposal.id not in grouped_ids and not proposal.conflicts,
        })
    levels = Counter(node.knowledge_level for node in store.of_type(KnowledgeNode, active_only=True))
    total = sum(levels.values())
    distribution = [
        {"level": level, "count": levels.get(level, 0),
         "percent": round(levels.get(level, 0) * 100 / total, 1) if total else 0}
        for level in ("proficient", "familiar", "aware", "unspecified")
    ]
    ideas = sorted(
        (idea for idea in store.of_type(Idea, active_only=True) if idea.execution_status == "in_progress"),
        key=lambda idea: idea.updated_at, reverse=True,
    )[:3]
    today = date.today()
    weekday = ("星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日")[today.weekday()]
    return {
        "today_label": (f"{weekday} · {today.month} 月 {today.day} 日" if locale == "zh-CN"
                        else today.strftime("%A · %B %-d")),
        "pending_items": pending,
        "level_distribution": distribution,
        "ideas_in_progress": [
            {"title": idea.title, "url": f"/ideas/{idea.id}", "updated": idea.updated_at.date().isoformat()}
            for idea in ideas
        ],
    }
