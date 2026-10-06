"""Build the Studio UI color layer from the Classic stylesheets.

Classic CSS keeps its literal colors. This module re-declares every color-related
declaration under ``html[data-ui="studio"]`` and replaces each literal with a
Studio token, so every existing page follows the Studio palette and dark mode
without editing (or forking) the Classic styles. The output is committed as
``static/studio-ui/remap.css``; ``scripts/build_studio_remap.py`` regenerates it.

All color properties are copied, including ones without literals, because the
prefix raises specificity uniformly: copying only literal-bearing declarations
would let a remapped rule beat a more specific Classic rule such as
``.x .a { color: inherit }``.
"""
from __future__ import annotations

import colorsys
import re
from pathlib import Path

PREFIX = 'html[data-ui="studio"]'

# Loaded by base.html on every page, in cascade order. Page files follow alphabetically.
GLOBAL_FILES = ("app.css", "studio.css", "error-feedback.css", "ai.css", "evaluations.css",
                "first-use.css")
# Standalone pages that never render the Studio shell.
EXCLUDED_FILES = {"onboarding.css"}

COLOR_PROPERTIES = re.compile(
    r"^(?:color|background(?:-color|-image)?|border(?:-(?:top|right|bottom|left|block|inline)"
    r"(?:-(?:start|end))?)?(?:-color)?|outline(?:-color)?|box-shadow|text-shadow|fill|stroke"
    r"|text-decoration(?:-color)?|caret-color|accent-color|column-rule(?:-color)?"
    r"|-webkit-text-fill-color|scrollbar-color|--[\w-]+)$"
)
ROLE_LINE = re.compile(r"^(?:border|outline|stroke|column-rule|text-decoration)")
ROLE_TEXT = re.compile(r"^(?:color|caret-color|accent-color|-webkit-text-fill-color)$")
ROLE_SHADOW = re.compile(r"^(?:box-shadow|text-shadow)$")

# Classic design variables have known meanings; map them directly.
KNOWN_VARIABLES = {
    "--ink": "var(--s-ink)", "--muted": "var(--s-ink-3)", "--line": "var(--s-line)",
    "--canvas": "var(--s-bg)", "--paper": "var(--s-surface)", "--sidebar": "var(--s-sidebar)",
    "--nav-active": "var(--s-hover)", "--accent": "var(--s-accent)",
    "--accent-soft": "var(--s-accent-soft)", "--green": "var(--s-green)",
    "--green-soft": "var(--s-green-soft)", "--ochre": "var(--s-ochre)",
    "--ochre-soft": "var(--s-ochre-soft)", "--coral": "var(--s-red)",
    "--coral-soft": "var(--s-red-soft)", "--shadow": "var(--s-shadow-sm)",
}

HEX = r"#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b"
FUNC = r"(?:rgba?|hsla?)\([^()]*\)"
NAMED = r"(?<![\w-])(?:white|black)(?![\w-])"
COLOR = re.compile(f"{HEX}|{FUNC}|{NAMED}")
URL = re.compile(r"url\((?:[^()'\"]|'[^']*'|\"[^\"]*\")*\)")


def _channel(value: str) -> float:
    value = value.strip()
    return float(value[:-1]) * 2.55 if value.endswith("%") else float(value)


def parse_color(token: str) -> tuple[float, float, float, float] | None:
    token = token.strip().lower()
    if token == "white":
        return 255.0, 255.0, 255.0, 1.0
    if token == "black":
        return 0.0, 0.0, 0.0, 1.0
    if token.startswith("#"):
        digits = token[1:]
        if len(digits) in (3, 4):
            digits = "".join(ch * 2 for ch in digits)
        r, g, b = (int(digits[i:i + 2], 16) for i in (0, 2, 4))
        alpha = int(digits[6:8], 16) / 255 if len(digits) == 8 else 1.0
        return float(r), float(g), float(b), alpha
    match = re.fullmatch(r"(rgba?|hsla?)\((.*)\)", token)
    if not match:
        return None
    parts = [p for p in re.split(r"[\s,/]+", match.group(2).strip()) if p]
    if len(parts) < 3:
        return None
    alpha = 1.0
    if len(parts) > 3:
        a = parts[3]
        alpha = float(a[:-1]) / 100 if a.endswith("%") else float(a)
    if match.group(1).startswith("rgb"):
        return _channel(parts[0]), _channel(parts[1]), _channel(parts[2]), alpha
    hue = float(parts[0].removesuffix("deg")) / 360
    sat = float(parts[1].rstrip("%")) / 100
    light = float(parts[2].rstrip("%")) / 100
    r, g, b = colorsys.hls_to_rgb(hue, light, sat)
    return r * 255, g * 255, b * 255, alpha


def _neutral_token(role: str, lightness: float) -> str:
    if role == "text":
        steps = ((0.93, "on-accent"), (0.6, "ink-4"), (0.42, "ink-3"), (0.28, "ink-2"))
    elif role == "line":
        steps = ((0.985, "surface"), (0.87, "line"), (0.75, "line-2"), (0.55, "ink-4"),
                 (0.3, "ink-3"), (0.2, "ink-2"))
    else:
        steps = ((0.985, "surface"), (0.955, "surface-2"), (0.925, "fill"), (0.87, "hover"),
                 (0.75, "line-2"), (0.55, "ink-4"), (0.35, "ink-3"), (0.22, "ink-2"))
    return next((token for floor, token in steps if lightness >= floor), "ink")


def _family(hue: float) -> str:
    degrees = hue * 360
    if degrees < 18 or degrees >= 335:
        return "red"
    if degrees < 70:
        return "ochre"
    if degrees < 165:
        return "green"
    if degrees < 200:
        return "teal"
    if degrees < 262:
        return "accent"
    return "violet"


def token_for(rgba: tuple[float, float, float, float], role: str) -> str:
    r, g, b, alpha = rgba
    high, low = max(r, g, b), min(r, g, b)
    chroma = (high - low) / 255
    hue, lightness, _ = colorsys.rgb_to_hls(r / 255, g / 255, b / 255)
    neutral = chroma < 0.045 if lightness >= 0.9 else chroma < 0.145
    if neutral:
        if role == "shadow" and lightness < 0.5:
            name = "shadow"
        else:
            name = _neutral_token(role, lightness)
    else:
        family = _family(hue)
        if role == "text":
            level = "" if lightness >= 0.38 else "-ink"
        elif lightness >= 0.9:
            level = "-soft"
        elif lightness >= 0.78:
            level = "-line"
        elif lightness >= 0.38:
            level = ""
        else:
            level = "-ink"
        name = family + level
    value = f"var(--s-{name})"
    if alpha < 1:
        return f"color-mix(in srgb, {value} {round(alpha * 100, 1):g}%, transparent)"
    return value


def remap_value(prop: str, value: str) -> str:
    if prop in KNOWN_VARIABLES and not value.strip().startswith("var("):
        return KNOWN_VARIABLES[prop]
    role = ("text" if ROLE_TEXT.match(prop) else "shadow" if ROLE_SHADOW.match(prop)
            else "line" if ROLE_LINE.match(prop) else "bg")
    urls: list[str] = []

    def hide(match: re.Match) -> str:
        urls.append(match.group(0))
        return f"\x00{len(urls) - 1}\x00"

    masked = URL.sub(hide, value)

    def swap(match: re.Match) -> str:
        parsed = parse_color(match.group(0))
        return match.group(0) if parsed is None or parsed[3] == 0 else token_for(parsed, role)

    masked = COLOR.sub(swap, masked)
    return re.sub(r"\x00(\d+)\x00", lambda m: urls[int(m.group(1))], masked)


def _split_top(text: str, separator: str) -> list[str]:
    parts, depth, quote, start = [], 0, "", 0
    for index, char in enumerate(text):
        if quote:
            if char == quote and text[index - 1] != "\\":
                quote = ""
        elif char in "'\"":
            quote = char
        elif char in "([":
            depth += 1
        elif char in ")]":
            depth -= 1
        elif char == separator and depth == 0:
            parts.append(text[start:index])
            start = index + 1
    parts.append(text[start:])
    return parts


def _block_end(css: str, start: int) -> int:
    """Index of the ``}`` closing the block opened just before ``start``."""
    depth, quote, index = 1, "", start
    while index < len(css):
        char = css[index]
        if quote:
            if char == quote and css[index - 1] != "\\":
                quote = ""
        elif char in "'\"":
            quote = char
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return index
        index += 1
    raise ValueError("Unbalanced braces in stylesheet")


def prefix_selector(selector: str) -> str:
    selector = " ".join(selector.split())
    if selector.startswith(":root"):
        return PREFIX + selector[len(":root"):]
    if re.match(r"html(?![\w-])", selector):
        return PREFIX + selector[len("html"):]
    return f"{PREFIX} {selector}"


def _generic(selector: str) -> bool:
    return not re.search(r"[.#\[]", selector)


def remap_rules(css: str, *, page_file: bool) -> list[str]:
    css = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
    output: list[str] = []
    index = 0
    while index < len(css):
        brace = css.find("{", index)
        semicolon = css.find(";", index)
        if brace < 0:
            break
        if 0 <= semicolon < brace and css[index:semicolon].strip().startswith("@"):
            index = semicolon + 1  # @import / @charset
            continue
        prelude = css[index:brace].strip()
        end = _block_end(css, brace + 1)
        body = css[brace + 1:end]
        index = end + 1
        if prelude.startswith("@"):
            if re.match(r"@(?:media|supports|container|layer)\b", prelude):
                inner = remap_rules(body, page_file=page_file)
                if inner:
                    output.append(prelude + " {\n" + "\n".join("  " + r for r in inner) + "\n}")
            continue  # @keyframes, @font-face and friends keep Classic values
        selectors = [s.strip() for s in _split_top(prelude, ",") if s.strip()]
        if page_file:
            # Page stylesheets are bundled globally here; drop element-only selectors.
            selectors = [s for s in selectors if not _generic(s)]
        if not selectors:
            continue
        declarations = []
        for declaration in _split_top(body, ";"):
            if ":" not in declaration:
                continue
            prop, value = declaration.split(":", 1)
            prop = prop.strip()
            if not COLOR_PROPERTIES.match(prop.lower() if not prop.startswith("--") else prop):
                continue
            declarations.append(f"{prop}: {remap_value(prop, value.strip())}")
        if declarations:
            output.append(", ".join(prefix_selector(s) for s in selectors)
                          + " { " + "; ".join(declarations) + " }")
    return output


def stylesheet_order(static_root: Path) -> list[Path]:
    pages = sorted(
        path for path in [*static_root.glob("*.css"), *static_root.glob("projects/*.css")]
        if path.name not in GLOBAL_FILES and path.name not in EXCLUDED_FILES
    )
    return [static_root / name for name in GLOBAL_FILES] + pages


def build_remap(static_root: Path) -> str:
    chunks = [
        "/* Generated by scripts/build_studio_remap.py from the Classic stylesheets. Do not edit.",
        "   Maps Classic color literals to Studio tokens (static/studio-ui/tokens.css). */",
    ]
    for path in stylesheet_order(static_root):
        rules = remap_rules(path.read_text(encoding="utf-8"),
                            page_file=path.name not in GLOBAL_FILES)
        if rules:
            chunks.append(f"\n/* {path.relative_to(static_root).as_posix()} */")
            chunks.extend(rules)
    return "\n".join(chunks) + "\n"
