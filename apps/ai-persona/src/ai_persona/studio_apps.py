"""Open another installed PersonaStudio application using a fixed local launcher."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
from hashlib import sha256
from pathlib import Path
from urllib.parse import urlsplit

from .workspace import user_config_path

ERROR_MESSAGES = {
    "not_installed": (
        "Paper Radar 未安装或缺少运行环境，请在扩展应用中完成安装。",
        "Paper Radar or its runtime is missing. Complete installation in Extensions.",
    ),
    "not_built": (
        "Paper Radar 网页尚未构建，请完成安装或运行 npm run setup:radar。",
        "Paper Radar needs a local build. Complete installation or run npm run setup:radar.",
    ),
    "data_in_use": (
        "Paper Radar 的数据目录正被另一服务占用。请在扩展应用中关联正确目录，或先停止占用该目录的服务。",
        "Another service is using this Paper Radar data directory. Select the correct directory in Extensions or stop that service first.",
    ),
    "unresponsive": (
        "已记录的 Paper Radar 服务未通过身份检查或没有响应，请检查其运行状态和日志。",
        "The recorded Paper Radar service did not respond or pass its identity check. Check its status and logs.",
    ),
    "starting": (
        "Paper Radar 正在启动，请稍后重试。",
        "Paper Radar is already starting. Try again shortly.",
    ),
    "timeout": (
        "Paper Radar 启动超时，请检查运行状态和日志后重试。",
        "Paper Radar startup timed out. Check its status and logs before retrying.",
    ),
    "invalid_response": (
        "Paper Radar 未返回有效的本机地址，请检查安装和运行状态。",
        "Paper Radar did not return a valid local application address. Check its installation and status.",
    ),
    "invalid_home": (
        "请选择已存在的 Paper Radar 应用目录（包含 data、models 等子目录）。",
        "Choose an existing Paper Radar home directory containing data, models and other application folders.",
    ),
    "invalid_binding": (
        "Paper Radar 目录关联无法读取，请在扩展应用中重新保存关联目录。",
        "The Paper Radar directory setting could not be read. Save it again in Extensions.",
    ),
    "save_failed": (
        "Paper Radar 目录关联未能保存，请检查本机配置目录的写入权限。",
        "The Paper Radar directory setting could not be saved. Check write access to the local configuration directory.",
    ),
    "launch_failed": (
        "Paper Radar 启动失败，请检查关联目录中的 data/.runtime/server.log。",
        "Paper Radar could not start. Check data/.runtime/server.log in its selected home directory.",
    ),
}


class PaperRadarError(ValueError):
    def __init__(self, code: str):
        self.code = code if code in ERROR_MESSAGES else "launch_failed"
        super().__init__(self.message("en"))

    def message(self, locale: str) -> str:
        return ERROR_MESSAGES[self.code][0 if locale == "zh-CN" else 1]


def _binding_path(workspace: Path) -> Path:
    key = sha256(str(workspace.resolve()).encode()).hexdigest()
    return user_config_path().parent / "paper-radar" / f"{key}.json"


def paper_radar_home(workspace: Path) -> str:
    """A workspace-specific selection; an empty value retains launcher defaults."""
    try:
        value = json.loads(_binding_path(workspace).read_text(encoding="utf-8"))
        home = value["home"]
        if (
            value["workspace"] != str(workspace.resolve())
            or not isinstance(home, str)
            or not home
            or not Path(home).is_absolute()
        ):
            raise ValueError("Invalid directory binding")
        return home
    except FileNotFoundError:
        return ""
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise PaperRadarError("invalid_binding") from exc


def save_paper_radar_home(workspace: Path, home: str) -> str:
    if not isinstance(home, str) or len(home) > 4096 or "\0" in home:
        raise PaperRadarError("invalid_home")
    home = home.strip()
    if home:
        directory = Path(home).expanduser()
        if not directory.is_absolute() or not directory.is_dir():
            raise PaperRadarError("invalid_home")
        home = str(directory.resolve())
    path = _binding_path(workspace)
    temporary = None
    try:
        if not home:
            path.unlink(missing_ok=True)
            return ""
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=path.parent, delete=False
        ) as stream:
            temporary = Path(stream.name)
            json.dump({"workspace": str(workspace.resolve()), "home": home}, stream)
            stream.write("\n")
        os.replace(temporary, path)
    except OSError as exc:
        raise PaperRadarError("save_failed") from exc
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    return home


def radar_launcher() -> Path | None:
    configured = os.environ.get("PERSONASTUDIO_ROOT")
    installed = os.environ.get("AI_PERSONA_INSTALL_ROOT")
    root = (
        Path(installed) / "current"
        if installed
        else Path(configured)
        if configured
        else Path(__file__).resolve().parents[4]
    )
    launcher = root / "apps/paper-radar/scripts/launcher.mjs"
    return launcher if launcher.is_file() else None


def open_paper_radar(workspace: Path) -> str:
    launcher = radar_launcher()
    managed_node = (
        launcher.parent.parent.parent.parent / "runtime/node/bin/node" if launcher else None
    )
    node = str(managed_node) if managed_node and managed_node.is_file() else shutil.which("node")
    if launcher is None or node is None:
        raise PaperRadarError("not_installed")
    env = {**os.environ, "AI_PERSONA_WORKSPACE": str(workspace)}
    home = paper_radar_home(workspace)
    if home:
        if not Path(home).is_dir():
            raise PaperRadarError("invalid_home")
        # A saved workspace binding selects the whole profile, including models.
        # Do not mix it with another Radar's inherited paths or fixed port.
        for name in (
            "PAPER_RADAR_STORAGE_DIR",
            "PAPER_RADAR_DATA_DIR",
            "PAPER_RADAR_PERSONA_CONFIG",
            "PAPER_RADAR_PORT",
        ):
            env.pop(name, None)
        env["PAPER_RADAR_HOME"] = home
    try:
        result = subprocess.run(
            [node, str(launcher), "start", "--no-open", "--json"],
            env=env,
            capture_output=True,
            text=True,
            timeout=50,
            check=True,
        )
    except subprocess.TimeoutExpired as exc:
        raise PaperRadarError("timeout") from exc
    except subprocess.CalledProcessError as exc:
        try:
            code = json.loads(exc.stderr)["error"]["code"]
            if not isinstance(code, str):
                code = "launch_failed"
        except (ValueError, KeyError, TypeError):
            code = "launch_failed"
        raise PaperRadarError(code) from exc
    except OSError as exc:
        raise PaperRadarError("launch_failed") from exc
    try:
        url = json.loads(result.stdout)["url"]
        if not isinstance(url, str):
            raise ValueError("Invalid address")
        parsed = urlsplit(url)
        if (
            parsed.scheme != "http"
            or parsed.hostname != "127.0.0.1"
            or not parsed.port
            or parsed.username
            or parsed.password
            or parsed.path not in {"", "/"}
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError("Invalid address")
    except (ValueError, KeyError, TypeError) as exc:
        raise PaperRadarError("invalid_response") from exc
    return url
