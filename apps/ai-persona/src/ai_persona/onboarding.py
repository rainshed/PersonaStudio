"""Local first-run setup, independent of any existing Persona workspace."""
from __future__ import annotations

import asyncio
import json
import logging
import re
import secrets
import socket
import threading
import webbrowser
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.background import BackgroundTask
from starlette.concurrency import run_in_threadpool

from .initialization import initialize_persona
from .launcher import start_ui
from .store import PersonaStore, StoreValidationError
from .web_access import StudioAccess, StudioAccessMiddleware
from .workspace import demo_workspace, resolve_workspace, save_configured_workspace

logger = logging.getLogger(__name__)

MESSAGES = {
    "en": {
        "title": "Make your AI feel more like you",
        "intro": "Keep your knowledge, materials and preferences together. Start with a sample, or create a private workspace of your own.",
        "demo": "Explore the demo", "demo_text": "Try all the pages with fictional example data. Your own workspace and model connections stay separate.",
        "create": "Create my workspace", "create_text": "Start with an empty Persona. You can add materials and preferences at your own pace.",
        "open": "Open an existing workspace", "open_text": "Continue with a folder containing persona-data. Your records and history are preserved.",
        "path": "Workspace folder", "path_hint": "Use a full path outside the source code folder. New workspaces require an empty folder.",
        "id": "Persona ID", "id_hint": "2–64 lowercase letters, numbers, hyphens or underscores.",
        "continue": "Open AI Persona", "busy": "Preparing your workspace…", "ready": "Your workspace is ready. Opening Studio…",
        "eyebrow": "AI PERSONA · YOUR KNOWLEDGE. YOUR PREFERENCES.",
        "local": "Your data stays in your chosen folder. AI models and app connections can be configured later in Settings.",
        "default_note": "Creating or opening a workspace makes it your default. Exploring the demo does not change your default.",
        "invalid_request": "Choose one of the three options and try again.",
        "invalid_path": "Choose a full folder path outside the application folder, not your home or filesystem root.",
        "not_empty": "This folder already contains files. Choose an empty folder, or use Open an existing workspace.",
        "invalid_id": "Use a Persona ID of 2–64 lowercase letters, numbers, hyphens or underscores, starting with a letter or number.",
        "open_invalid": "This folder is not a valid Persona workspace. Select the folder that contains persona-data/config/persona.toml.",
        "failed": "Studio could not start. Any workspace created here has been preserved. Try again, or expand the details below.",
        "permission_denied": "Setup cannot access a required folder. Check its permissions or choose a folder you can access, then try again.",
        "default_not_saved": "Studio is running, but your default workspace could not be saved. Open Studio using the link below, or retry saving the default.",
        "details": "Show details", "retry": "Try again", "open_running": "Open the running Studio",
        "forbidden": "Reload this setup page on this computer and try again.",
    },
    "zh-CN": {
        "title": "让 AI 更了解你", "intro": "把知识、材料与偏好整理在一起。先体验示例，或创建属于你的私人工作区。",
        "demo": "体验示例", "demo_text": "使用虚构示例数据探索所有页面。你的正式工作区与模型连接保持独立。",
        "create": "创建我的工作区", "create_text": "从空白 Persona 开始，按自己的节奏添加材料和偏好。",
        "open": "打开已有工作区", "open_text": "选择包含 persona-data 的文件夹，继续使用已有记录和历史。",
        "path": "工作区文件夹", "path_hint": "填写源代码目录之外的完整路径。创建新工作区需要一个空文件夹。",
        "id": "Persona 标识", "id_hint": "2–64 个小写字母、数字、连字符或下划线。",
        "continue": "打开 AI Persona", "busy": "正在准备工作区…", "ready": "工作区已就绪，正在打开 Studio…",
        "eyebrow": "AI PERSONA · 你的知识，你的偏好。",
        "local": "数据保存在你选择的文件夹中。稍后可在设置中配置 AI 模型与应用接入。",
        "default_note": "创建或打开工作区会将它设为默认工作区；体验示例不会更改默认设置。",
        "invalid_request": "请选择上面的三个选项之一，再试一次。",
        "invalid_path": "请选择应用目录之外的完整文件夹路径，不能使用主目录或文件系统根目录。",
        "not_empty": "这个文件夹已有内容。请选择空文件夹，或使用“打开已有工作区”。",
        "invalid_id": "Persona 标识须为 2–64 个小写字母、数字、连字符或下划线，并以字母或数字开头。",
        "open_invalid": "这不是有效的 Persona 工作区。请选择包含 persona-data/config/persona.toml 的文件夹。",
        "failed": "Studio 暂时无法启动，已创建的工作区会保留。请重试，或展开下方详情查看具体原因。",
        "permission_denied": "引导无法访问所需的文件夹。请检查访问权限，或改选你有权限的文件夹后重试。",
        "default_not_saved": "Studio 已启动，但默认工作区未能保存。你可以通过下方链接打开 Studio，或重试保存默认设置。",
        "details": "查看具体原因", "retry": "重试", "open_running": "打开已运行的 Studio",
        "forbidden": "请在这台电脑上重新加载引导页面后再试。",
    },
}


class SetupError(ValueError):
    pass


def _workspace_path(value: object) -> Path:
    if not isinstance(value, str) or not value.strip() or len(value) > 4096:
        raise SetupError("invalid_path")
    if any(ord(c) < 32 for c in value) or ".." in Path(value).parts:
        raise SetupError("invalid_path")
    candidate = Path(value.strip()).expanduser()
    if not candidate.is_absolute():
        raise SetupError("invalid_path")
    candidate = candidate.resolve()
    source = Path(__file__).resolve().parents[2]
    protected = [source, *(p for p in source.parents if (p / ".git").exists())]
    if source.parent.name == "apps":
        protected.append(source.parent.parent)
    if candidate in {Path(candidate.anchor), Path.home().resolve()} or any(
        candidate == p or p in candidate.parents for p in protected
    ):
        raise SetupError("invalid_path")
    if candidate.exists() and not candidate.is_dir():
        raise SetupError("invalid_path")
    return candidate


def create_setup_app(*, default_workspace: Path | None = None) -> FastAPI:
    app = FastAPI(title="Persona Studio setup", docs_url=None, redoc_url=None, openapi_url=None)
    app.add_middleware(StudioAccessMiddleware, policy=StudioAccess())
    package = Path(__file__).resolve().parent
    templates = Jinja2Templates(directory=package / "templates")
    app.mount("/static", StaticFiles(directory=package / "static"), name="static")
    app.state.setup_token = secrets.token_urlsafe(32)
    app.state.shutdown = None
    app.state.completed = None
    lock = threading.Lock()
    created_here: set[Path] = set()

    @app.middleware("http")
    async def private_page(request, call_next):
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; style-src 'self'; script-src 'self'; "
            "img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
        )
        return response

    @app.get("/")
    def index(request: Request):
        language = request.query_params.get("lang")
        if language not in MESSAGES:
            language = "zh-CN" if request.headers.get("accept-language", "").startswith("zh") else "en"
        return templates.TemplateResponse(request, "onboarding.html", {
            "language": language, "text": MESSAGES[language], "token": app.state.setup_token,
            "default_workspace": str(default_workspace or Path.home() / "PersonaStudioData/my-persona"),
        })

    def prepare(payload):
        with lock:
            if app.state.completed:
                return app.state.completed
            mode = payload.get("mode")
            if mode == "demo":
                workspace = demo_workspace()
            elif mode in {"create", "open"}:
                root = _workspace_path(payload.get("path"))
                if mode == "create" and root not in created_here:
                    if root.exists() and any(root.iterdir()):
                        raise SetupError("not_empty")
                    persona_id = payload.get("persona_id", "my-persona")
                    if not isinstance(persona_id, str) or not re.fullmatch(r"[a-z0-9][a-z0-9_-]{1,63}", persona_id):
                        raise SetupError("invalid_id")
                    initialize_persona(root / "persona-data", root / "persona-state", persona_id=persona_id)
                    created_here.add(root)
                if not (root / "persona-data/config/persona.toml").is_file():
                    raise SetupError("open_invalid")
                try:
                    PersonaStore(root / "persona-data").load()
                    workspace = resolve_workspace(workspace=root, data_root=None, state_root=None,
                                                  demo=False, require_data=True, require_state=True)
                except (ValueError, StoreValidationError) as exc:
                    raise SetupError("open_invalid") from exc
                if workspace.is_demo:
                    raise SetupError("open_invalid")
            else:
                raise SetupError("invalid_request")
            result = start_ui(workspace, host="127.0.0.1", open_browser=False)
            completed = {"ok": True, "url": result["url"], "demo": workspace.is_demo}
            if mode != "demo":
                try:
                    save_configured_workspace(workspace.root)
                except (OSError, ValueError) as exc:
                    logger.exception("Studio started, but saving the default workspace failed")
                    return {**completed, "warning": "default_not_saved", "details": str(exc)[:8000]}
            app.state.completed = completed
            return app.state.completed

    async def shutdown():
        if app.state.shutdown:
            await asyncio.sleep(0.3)
            app.state.shutdown()

    @app.post("/api/setup")
    async def setup(request: Request):
        language = request.headers.get("X-Persona-Language", "en")
        language = language if language in MESSAGES else "en"
        text = MESSAGES[language]
        token = request.headers.get("X-Persona-Setup", "")
        if (not secrets.compare_digest(token.encode(), app.state.setup_token.encode())
                or request.headers.get("origin") != f"{request.url.scheme}://{request.url.netloc}"):
            return JSONResponse({"ok": False, "error": text["forbidden"]}, status_code=403)
        try:
            if not request.headers.get("content-type", "").startswith("application/json"):
                raise SetupError("invalid_request")
            chunks, size = [], 0
            async for chunk in request.stream():
                size += len(chunk)
                if size > 8192:
                    raise SetupError("invalid_request")
                chunks.append(chunk)
            try:
                payload = json.loads(b"".join(chunks))
            except ValueError as exc:
                raise SetupError("invalid_request") from exc
            if not isinstance(payload, dict):
                raise SetupError("invalid_request")
            result = await run_in_threadpool(prepare, payload)
            if result.get("warning"):
                result = {**result, "warning": text[result["warning"]]}
            response = JSONResponse(
                result, background=None if result.get("warning") else BackgroundTask(shutdown),
            )
            response.set_cookie("ai_persona_locale", language, samesite="strict", max_age=31536000)
            return response
        except SetupError as exc:
            return JSONResponse({"ok": False, "error": text[str(exc)]}, status_code=400)
        except PermissionError as exc:
            logger.exception("Workspace setup could not access a required folder")
            return JSONResponse({"ok": False, "error": text["permission_denied"],
                                 "details": str(exc)[:8000]}, status_code=400)
        except (ValueError, OSError, RuntimeError) as exc:
            logger.exception("Workspace setup failed")
            return JSONResponse({"ok": False, "error": text["failed"],
                                 "details": str(exc)[:8000]}, status_code=400)

    return app


def run_setup(*, port: int = 0, open_browser: bool = True) -> int:
    """Serve a loopback wizard until it launches Studio or the user stops it."""
    import uvicorn

    if not 0 <= port <= 65535:
        raise ValueError("port must be between 0 and 65535")
    app = create_setup_app()
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", proxy_headers=False, log_level="warning"))
    app.state.shutdown = lambda: setattr(server, "should_exit", True)
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", port))
        listener.listen(128)
        url = f"http://127.0.0.1:{listener.getsockname()[1]}"
        print(f"Persona Studio setup: {url}", flush=True)
        if open_browser:
            try:
                webbrowser.open(url)
            except webbrowser.Error:
                pass
        try:
            server.run(sockets=[listener])
        except KeyboardInterrupt:
            pass
    return 0
