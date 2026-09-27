"""Studio factory for an externally supervised, private ASGI service.

Use AI_PERSONA_WORKSPACE and AI_PERSONA_PUBLIC_ORIGIN to select the workspace
and existing reverse-proxy origin. The ordinary desktop launcher remains the
managed single-instance entry point.
"""

import os
from pathlib import Path

from .web import create_app as create_studio_app
from .workspace import configured_workspace, resolve_workspace


def create_app():
    selected = os.environ.get("AI_PERSONA_WORKSPACE")
    workspace = resolve_workspace(
        workspace=Path(selected) if selected else configured_workspace(),
        data_root=None, state_root=None,
        demo=False, require_data=True, require_state=True, allow_demo=False,
    )
    return create_studio_app(workspace.data_root, workspace.state_root)
