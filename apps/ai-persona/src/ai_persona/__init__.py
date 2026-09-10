"""File-first AI persona storage demo."""

from .compiler import BuildResult, PersonaCompiler
from .store import PersonaStore, StoreValidationError

__all__ = [
    "BuildResult",
    "PersonaCompiler",
    "PersonaStore",
    "StoreValidationError",
]

__version__ = "0.1.0"
