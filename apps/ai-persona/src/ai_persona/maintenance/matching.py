"""Deterministic identity checks shared by both maintenance entry adapters."""

from __future__ import annotations

import re
import unicodedata


def text_key(text):
    return re.sub(r"[\s_-]+", "", unicodedata.normalize("NFKC", text).casefold())


def preference_key(values, context_keys):
    refs = [*values.get("context_refs", []), *values.get("context_client_refs", [])]
    return (
        text_key(values.get("instruction", "")),
        values.get("behavior"),
        values.get("scope", "global"),
        text_key(values.get("condition", "")),
        tuple(sorted(context_keys.get(ref, ref) for ref in refs)),
    )
