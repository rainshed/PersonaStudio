"""Read-only, content-first projections for the Persona home page."""

from collections import Counter
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
