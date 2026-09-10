from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Any, Literal

import yaml
from fastapi import Request

Locale = Literal["zh-CN", "en"]
DEFAULT_LOCALE: Locale = "zh-CN"
SUPPORTED_LOCALES: tuple[Locale, ...] = ("zh-CN", "en")
LOCALE_COOKIE = "ai_persona_locale"


def _load_catalog(locale: Locale) -> dict[str, Any]:
    path = Path(__file__).resolve().parent / "i18n" / f"{locale}.yaml"
    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise RuntimeError(f"invalid translation catalog: {path}")
    return raw


CATALOGS = {locale: _load_catalog(locale) for locale in SUPPORTED_LOCALES}


def _resolve(catalog: dict[str, Any], key: str) -> Any:
    value: Any = catalog
    for part in key.split("."):
        if not isinstance(value, dict) or part not in value:
            raise KeyError(key)
        value = value[part]
    return value


def _leaf_keys(value: Any, prefix: str = "") -> set[str]:
    if not isinstance(value, dict):
        return {prefix}
    return {
        key
        for name, child in value.items()
        for key in _leaf_keys(child, f"{prefix}.{name}" if prefix else str(name))
    }


def validate_catalogs() -> None:
    expected = _leaf_keys(CATALOGS[DEFAULT_LOCALE])
    for locale, catalog in CATALOGS.items():
        actual = _leaf_keys(catalog)
        if actual != expected:
            missing = sorted(expected - actual)
            extra = sorted(actual - expected)
            raise RuntimeError(
                f"translation catalog {locale} differs from {DEFAULT_LOCALE}; "
                f"missing={missing}, extra={extra}"
            )


validate_catalogs()


def request_locale(request: Request) -> Locale:
    value = request.cookies.get(LOCALE_COOKIE, DEFAULT_LOCALE)
    return value if value in SUPPORTED_LOCALES else DEFAULT_LOCALE  # type: ignore[return-value]


def translator(locale: Locale) -> Callable[..., str]:
    def translate(key: str, **values: Any) -> str:
        text = _resolve(CATALOGS[locale], key)
        if not isinstance(text, str):
            raise KeyError(f"translation is not text: {key}")
        return text.format(**values)

    return translate


def label_map(locale: Locale, name: str) -> dict[str, str]:
    value = _resolve(CATALOGS[locale], f"labels.{name}")
    if not isinstance(value, dict) or not all(
        isinstance(key, str) and isinstance(item, str) for key, item in value.items()
    ):
        raise KeyError(f"translation is not a label map: labels.{name}")
    return dict(value)


def localized_error(locale: Locale, message: str) -> str:
    if locale == DEFAULT_LOCALE:
        return message
    replacements = _resolve(CATALOGS[locale], "error_replacements")
    if not isinstance(replacements, dict):
        return message
    translated = message
    for source, target in replacements.items():
        translated = translated.replace(str(source), str(target))
    return translated
