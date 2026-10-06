"""Regenerate static/studio-ui/remap.css after changing any Classic stylesheet."""
from pathlib import Path

from ai_persona.studio_theme import build_remap

STATIC = Path(__file__).resolve().parents[1] / "src/ai_persona/static"

if __name__ == "__main__":
    target = STATIC / "studio-ui" / "remap.css"
    target.parent.mkdir(exist_ok=True)
    target.write_text(build_remap(STATIC), encoding="utf-8")
    print(f"Wrote {target.relative_to(STATIC.parent)} ({target.stat().st_size // 1024} KB)")
