"""Small, fixed regression fixture, independent of the editable public Demo."""
from pathlib import Path

from ai_persona.workspace import PersonaWorkspace


def demo_workspace() -> PersonaWorkspace:
    root = Path(__file__).parent / "fixtures" / "legacy-demo"
    return PersonaWorkspace(root, root / "persona-data", root / "persona-state")
