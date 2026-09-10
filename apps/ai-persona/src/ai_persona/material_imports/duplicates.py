from __future__ import annotations

import re
from difflib import SequenceMatcher

from ..models import Material
from ..store import PersonaStore
from .models import DuplicateMatch, ImportMetadata


def _normalized_title(value: str) -> str:
    return re.sub(r"[^\w\u3400-\u9fff]+", " ", value.casefold()).strip()


def _version_number(value: str | None) -> int | None:
    match = re.fullmatch(r"v(\d+)", (value or "").casefold())
    return int(match.group(1)) if match else None


def _same_year(left: str | None, right: str | None) -> bool:
    return bool(left and right and left[:4] == right[:4])


def _shared_author(left: list[str], right: list[str]) -> bool:
    return bool({item.casefold() for item in left} & {item.casefold() for item in right})


def find_duplicate_matches(
    store: PersonaStore,
    values: ImportMetadata,
    *,
    source_hash: str,
    source_version: str | None,
) -> list[DuplicateMatch]:
    """Find deterministic, user-actionable matches before a proposal is created."""

    incoming_ids = values.bibliography.identifiers
    incoming_title = _normalized_title(values.title)
    matches: dict[str, DuplicateMatch] = {}

    for material in store.of_type(Material, active_only=True):
        manifest = store.sources.get(material.source_ref)
        existing_ids = material.bibliography.identifiers
        match: DuplicateMatch | None = None

        if incoming_ids.arxiv and existing_ids.arxiv:
            if incoming_ids.arxiv.casefold() == existing_ids.arxiv.casefold():
                current_version = manifest.origin.version if manifest else None
                incoming_number = _version_number(source_version)
                current_number = _version_number(current_version)
                if incoming_number is not None and current_number is not None:
                    if incoming_number > current_number:
                        kind, reason = "newer_version", "同一 arXiv 论文有更新版本"
                    elif incoming_number < current_number:
                        kind, reason = "older_version", "已保存的 arXiv 版本更新"
                    else:
                        kind, reason = "exact", "arXiv ID 和版本相同"
                elif manifest and manifest.content_hash == source_hash:
                    kind, reason = "exact", "arXiv ID 和原文内容相同"
                else:
                    kind, reason = "exact", "arXiv ID 相同"
                match = DuplicateMatch(
                    material_id=material.id,
                    title=material.title,
                    kind=kind,
                    reason=reason,
                    current_version=current_version,
                )

        if match is None and incoming_ids.doi and existing_ids.doi:
            if incoming_ids.doi.casefold() == existing_ids.doi.casefold():
                match = DuplicateMatch(
                    material_id=material.id,
                    title=material.title,
                    kind="exact",
                    reason="DOI 相同",
                    current_version=manifest.origin.version if manifest else None,
                )

        if match is None and manifest and manifest.content_hash == source_hash:
            match = DuplicateMatch(
                material_id=material.id,
                title=material.title,
                kind="exact",
                reason="原文件内容完全相同",
                current_version=manifest.origin.version,
            )

        if match is None:
            existing_title = _normalized_title(material.title)
            title_ratio = SequenceMatcher(None, incoming_title, existing_title).ratio()
            likely_same_work = (
                incoming_title == existing_title
                or title_ratio >= 0.9
                and (
                    _same_year(
                        values.bibliography.published_at,
                        material.bibliography.published_at,
                    )
                    or _shared_author(
                        values.bibliography.authors,
                        material.bibliography.authors,
                    )
                )
            )
            if incoming_title and likely_same_work:
                match = DuplicateMatch(
                    material_id=material.id,
                    title=material.title,
                    kind="possible",
                    reason="标题高度相似，请确认是否为同一材料",
                    current_version=manifest.origin.version if manifest else None,
                )

        if match is not None:
            matches[material.id] = match

    order = {"exact": 0, "newer_version": 1, "older_version": 2, "possible": 3}
    return sorted(
        matches.values(),
        key=lambda item: (order[item.kind], item.title.casefold(), item.material_id),
    )
