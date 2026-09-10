from typing import Protocol

from ..contracts import ContextRequest, ContextSnapshot


class ContextProvider(Protocol):
    def resolve_context(
        self,
        source_connection_id: str,
        context_ref: str,
        boundary: str,
        request: ContextRequest,
    ) -> ContextSnapshot: ...
