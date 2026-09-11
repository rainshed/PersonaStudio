"""File-first AI persona storage demo."""

from importlib.metadata import version

from .compiler import BuildResult, PersonaCompiler
from .store import PersonaStore, StoreValidationError

__all__ = [
    "BuildResult",
    "PersonaCompiler",
    "PersonaStore",
    "StoreValidationError",
]

__version__ = version("ai-persona")
