"""An independent loopback setup process survives the old Studio stopping."""

import argparse
import json
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import ProxyHandler, Request, build_opener

from .demo import is_demo_data, workspace_identity
from .launcher import active_ui
from .workspace import PersonaWorkspace


def workspace(data, state):
    root = (
        data.parent
        if data.name == "persona-data" and state == data.parent / "persona-state"
        else None
    )
    return PersonaWorkspace(root, data, state)


def prepare_original(original, *, release=False):
    info = active_ui()
    if not info:
        return
    if info.data_root != str(original.data_root) or info.state_root != str(original.state_root):
        raise RuntimeError("正在运行的工作区已改变，请重新打开工作区管理。")
    payload = json.dumps(
        {
            "workspace_id": workspace_identity(original.data_root, original.state_root),
            "release": release,
        }
    ).encode()
    request = Request(
        info.url + "/api/studio/workspaces/prepare-switch",
        data=payload,
        headers={"Content-Type": "application/json", "X-AI-Persona": "1"},
    )
    try:
        with build_opener(ProxyHandler({})).open(request, timeout=10) as response:
            if not json.load(response).get("ok"):
                raise RuntimeError("工作区尚未准备好切换。")
    except HTTPError as exc:
        value = json.load(exc)
        raise RuntimeError(
            value.get("error", {}).get("message", "请完成当前任务后再切换。")
        ) from exc


def launch_manager(data_root, state_root):
    from .workspace_registry import remember

    root = workspace(data_root, state_root).root
    if root and not is_demo_data(data_root):
        remember(root)
    directory = Path(tempfile.mkdtemp(prefix="persona-workspaces-"))
    ready = directory / "ready.json"
    child = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "ai_persona.workspace_switch",
            "--data",
            str(data_root),
            "--state",
            str(state_root),
            "--ready",
            str(ready),
        ],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    for _ in range(100):
        if ready.exists():
            return json.loads(ready.read_text())["url"]
        if child.poll() is not None:
            raise RuntimeError("工作区管理未能启动，请重试。")
        time.sleep(0.1)
    child.terminate()
    raise RuntimeError("工作区管理启动超时，请重试。")


def main():
    import uvicorn

    from .onboarding import create_setup_app

    p = argparse.ArgumentParser()
    p.add_argument("--data", type=Path, required=True)
    p.add_argument("--state", type=Path, required=True)
    p.add_argument("--ready", type=Path, required=True)
    args = p.parse_args()
    original = workspace(args.data, args.state)
    app = create_setup_app(switch_from=original)
    server = uvicorn.Server(
        uvicorn.Config(app, host="127.0.0.1", proxy_headers=False, log_level="warning")
    )
    app.state.shutdown = lambda: setattr(server, "should_exit", True)
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen(128)
        args.ready.write_text(
            json.dumps({"url": "http://127.0.0.1:" + str(listener.getsockname()[1])})
        )
        server.run(sockets=[listener])
    args.ready.unlink(missing_ok=True)
    args.ready.parent.rmdir()


if __name__ == "__main__":
    main()
