from __future__ import annotations

import json
import os
import tomllib
from dataclasses import dataclass
from pathlib import Path

WORKSPACE_ENV = "AI_PERSONA_WORKSPACE"
CONFIG_ENV = "AI_PERSONA_CONFIG"


@dataclass(frozen=True)
class PersonaWorkspace:
    """Resolved canonical and generated-state locations for one persona."""

    root: Path | None
    data_root: Path | None
    state_root: Path | None
    is_demo: bool = False


def project_root() -> Path:
    return Path(__file__).resolve().parents[2]


def user_config_path() -> Path:
    configured = os.environ.get(CONFIG_ENV)
    if configured:
        return Path(configured).expanduser().resolve()
    config_home = os.environ.get("XDG_CONFIG_HOME")
    root = Path(config_home).expanduser() if config_home else Path.home() / ".config"
    return root / "ai-persona" / "config.toml"


def configured_workspace() -> Path | None:
    path = user_config_path()
    try:
        payload = tomllib.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except tomllib.TOMLDecodeError as exc:
        raise ValueError(f"AI Persona config is not valid TOML: {path}") from exc
    value = payload.get("defaults", {}).get("workspace")
    if value is None:
        return None
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"AI Persona config workspace is not valid: {path}")
    return Path(value).expanduser().resolve()


def save_configured_workspace(workspace: Path) -> Path:
    path = user_config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    content = f"[defaults]\nworkspace = {json.dumps(str(workspace.resolve()))}\n"
    temporary.write_text(content, encoding="utf-8")
    temporary.chmod(0o600)
    os.replace(temporary, path)
    return path


def demo_workspace() -> PersonaWorkspace:
    from .demo import prepare_demo

    root = prepare_demo()
    return PersonaWorkspace(
        root=root.resolve(),
        data_root=root / "persona-data",
        state_root=(root / "persona-state").resolve(),
        is_demo=True,
    )


def resolve_workspace(
    *,
    workspace: Path | None,
    data_root: Path | None,
    state_root: Path | None,
    demo: bool,
    require_data: bool,
    require_state: bool,
    allow_demo: bool = True,
) -> PersonaWorkspace:
    """Resolve one explicit workspace selection without falling back to Demo data."""

    configured_workspace = workspace
    if configured_workspace is None and not demo and data_root is None and state_root is None:
        environment_value = os.environ.get(WORKSPACE_ENV)
        if environment_value:
            configured_workspace = Path(environment_value).expanduser()

    if demo and not allow_demo:
        raise ValueError("初始化真实人格时不能使用 --demo")
    if demo and any(value is not None for value in (configured_workspace, data_root, state_root)):
        raise ValueError("--demo 不能与 --workspace、--data 或 --state 同时使用")
    if configured_workspace is not None and any(
        value is not None for value in (data_root, state_root)
    ):
        raise ValueError("--workspace 不能与 --data 或 --state 同时使用")

    if demo:
        return demo_workspace()

    if configured_workspace is not None:
        root = configured_workspace.expanduser().absolute()
        selected = PersonaWorkspace(
            root=root,
            data_root=root / "persona-data" if require_data else None,
            state_root=root / "persona-state" if require_state else None,
        )
        return _check_selection(selected, allow_demo=allow_demo)

    if data_root is None and state_root is None:
        raise ValueError(
            "请选择 Persona 工作区：使用 --workspace 指向真实人格，或使用 --demo 打开示例"
        )
    if require_data and data_root is None:
        raise ValueError("当前命令需要 --data，或改用 --workspace")
    if require_state and state_root is None:
        raise ValueError("当前命令需要 --state，或改用 --workspace")

    selected = PersonaWorkspace(
        root=None,
        data_root=data_root.expanduser().absolute() if data_root is not None else None,
        state_root=state_root.expanduser().absolute() if state_root is not None else None,
    )
    return _check_selection(selected, allow_demo=allow_demo)


def _check_selection(selected: PersonaWorkspace, *, allow_demo: bool) -> PersonaWorkspace:
    from .demo import check_demo_paths, is_demo_data

    location = selected.data_root or (
        selected.state_root.parent / "persona-data" if selected.state_root else None
    )
    demo = location is not None and is_demo_data(location)
    if demo:
        if not allow_demo:
            raise ValueError("此操作不支持 Demo，请选择正式工作区。")
        check_demo_paths(location, selected.state_root)
    return PersonaWorkspace(
        selected.root.resolve() if selected.root else None,
        selected.data_root.resolve() if selected.data_root else None,
        selected.state_root.resolve() if selected.state_root else None,
        demo,
    )
