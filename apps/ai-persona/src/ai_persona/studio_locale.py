"""Translations for authored Studio UI only, never user or model content."""
import json
from pathlib import Path

STUDIO_EN = json.loads((Path(__file__).parent / "i18n/studio.en.json").read_text(encoding="utf-8"))


def studio_text(message, locale):
    return STUDIO_EN.get(message, message) if locale == "en" else message
