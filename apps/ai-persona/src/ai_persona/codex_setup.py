"""Codex onboarding: bounded discovery, reviewed Hook installation and a local probe."""

from __future__ import annotations

import contextlib
import fcntl
import hashlib
import json
import os
import re
import secrets
import shlex
import stat
import tempfile
import time
from pathlib import Path, PurePosixPath

from .agent import AgentServiceError
from .conversation_learning.contracts import SourceConnection, digest, encoded

PROBE_PREFIX = "AI Persona 接入测试 "
PROBE_PATTERN = re.compile(
    r"^AI Persona 接入测试 ([a-f0-9]{32})\n这是一条接入验证消息，请只回复收到。$"
)
MAX_CONFIG = 1_048_576


def invalid(message):
    raise AgentServiceError("invalid_request", message)


def absolute_directory(value):
    if not isinstance(value, str) or not value.strip() or len(value) > 4096:
        invalid("请填写有效的文件夹路径。")
    path = Path(value.strip()).expanduser()
    if not path.is_absolute():
        invalid("请填写文件夹的完整路径。")
    return path.resolve()


def codex_home(connection=None):
    configured = connection.adapter_config.get("codex_home") if connection else None
    if connection and connection.adapter_config.get("remote_host"):
        if not configured or not PurePosixPath(configured).is_absolute() or ".." in PurePosixPath(configured).parts:
            invalid("远端 Codex 目录必须是规范的绝对路径。")
        return PurePosixPath(configured)
    return absolute_directory(
        configured or os.environ.get("CODEX_HOME") or str(Path.home() / ".codex")
    )


def directory_info(path):
    return {
        "path": str(path),
        "exists": path.is_dir(),
        "readable": path.is_dir() and os.access(path, os.R_OK | os.X_OK),
    }


def environment(home=None):
    path = absolute_directory(home) if home else codex_home()
    return {
        "codex_home": str(path),
        "sessions": directory_info(path / "sessions"),
        "hooks_path": str(path / "hooks.json"),
    }


def normalize_connection(raw):
    connection = SourceConnection.model_validate(raw)
    if connection.adapter != "codex":
        invalid("当前版本仅支持 Codex 接入。")
    config = dict(connection.adapter_config)
    if config.get("remote_host"):
        codex_home(connection)
        for root in [*config.get("project_scopes", {}), *config.get("transcript_roots", [])]:
            if not PurePosixPath(root).is_absolute() or ".." in PurePosixPath(root).parts:
                invalid("远端路径必须是规范的绝对路径。")
        if not set(config.get("project_scopes", {}).values()) <= set(connection.allowed_scopes):
            invalid("项目范围配置不完整。")
        return connection
    config["codex_home"] = str(codex_home(connection))
    scopes = config.get("project_scopes", {})
    if not isinstance(scopes, dict) or len(scopes) > 100:
        invalid("项目范围配置无效。")
    config["project_scopes"] = {
        str(absolute_directory(root)): scope for root, scope in scopes.items()
    }
    if connection.scope_mode != "all" and not scopes:
        invalid("请添加至少一个项目路径，或选择所有本机 Codex 会话。")
    if not set(scopes.values()) <= set(connection.allowed_scopes):
        invalid("项目范围配置不完整，请刷新后重试。")
    roots = config.get("transcript_roots", [])
    if not isinstance(roots, list) or len(roots) > 20:
        invalid("会话目录最多填写 20 个。")
    normalized = list(dict.fromkeys(str(absolute_directory(root)) for root in roots))
    for root in normalized:
        if not directory_info(Path(root))["readable"]:
            invalid("会话目录不存在或不可读取：" + root + "。请检查路径，或选择仅使用本次输入。")
    config["transcript_roots"] = normalized
    return connection.model_copy(update={"adapter_config": config})


def require_codex(repository, identifier):
    connection = repository.connection(identifier)
    if connection.adapter != "codex":
        invalid("当前版本仅支持 Codex 接入。")
    return connection


def read_hooks(path):
    if path.is_symlink():
        invalid("接入配置是符号链接，请使用手动配置方式。")
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return b"", {"hooks": {}}, None
    except OSError:
        invalid("无法读取 Codex 接入配置，请检查文件权限。")
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_CONFIG:
            invalid("Codex 接入配置不是普通文件或超过大小限制，请使用手动配置方式。")
        content = stream.read(MAX_CONFIG + 1)
    try:
        value = json.loads(content)
    except (ValueError, UnicodeError):
        invalid("现有 hooks.json 格式无效，未修改文件；请先修复或使用手动配置方式。")
    if not isinstance(value, dict) or not isinstance(value.get("hooks", {}), dict):
        invalid("现有 hooks.json 结构无效，未修改文件。")
    for groups in value.get("hooks", {}).values():
        if not isinstance(groups, list) or any(
            not isinstance(g, dict)
            or not isinstance(g.get("hooks"), list)
            or any(not isinstance(h, dict) for h in g["hooks"])
            for g in groups
        ):
            invalid("现有 Hook 结构无法安全合并，请使用手动配置方式。")
    return content, value, stat.S_IMODE(info.st_mode)


def owns_handler(handler, expected):
    if handler.get("type") != "command" or not isinstance(handler.get("command"), str):
        return False
    try:
        def fields(command):
            tokens = shlex.split(command)
            if len(tokens) >= 2 and tokens[0] == "env" and tokens[1].startswith("PYTHONPATH="):
                tokens = tokens[2:]
            if not tokens or not Path(tokens[0]).is_absolute():
                return None
            if len(tokens) >= 5 and tokens[1:5] == ["-m", "ai_persona", "codex-hook", "run"]:
                if not Path(tokens[0]).name.lower().startswith("python"):
                    return None
                arguments = tokens[5:]
            elif len(tokens) >= 3 and tokens[1:3] == ["codex-hook", "run"]:
                if Path(tokens[0]).name != "ai-persona":
                    return None
                arguments = tokens[3:]
            else:
                return None
            if len(arguments) != 8:
                return None
            result = {}
            for flag in ["--data", "--state", "--queue-dir", "--connection"]:
                if arguments.count(flag) != 1:
                    return None
                result[flag] = arguments[arguments.index(flag) + 1]
            return result

        found, target = fields(handler["command"]), fields(expected["command"])
        if found is None or target is None:
            return False
        # Match the workspace and source, not just the display name or module name.
        return found == target
    except (ValueError, IndexError):
        return False


def installation(service, identifier):
    from .codex_hook import hook_config

    connection = require_codex(service.repository, identifier)
    if connection.adapter_config.get("remote_host"):
        return {"path": str(codex_home(connection) / "hooks.json"), "snippet": {},
                "installed": False, "can_install": False, "status": "remote",
                "error": "远端接入由 ai-persona remote 管理；请在远端 Codex 使用 /hooks 检查。",
                "revision": None, "replace_count": 0}
    snippet = hook_config(service.data_root, service.state_root, service.repository, identifier)
    expected = snippet["hooks"]["UserPromptSubmit"][0]["hooks"][0]
    path = codex_home(connection) / "hooks.json"
    result = {
        "path": str(path),
        "snippet": snippet,
        "installed": False,
        "can_install": True,
        "status": "missing",
        "error": None,
        "revision": None,
        "replace_count": 0,
    }
    try:
        content, existing, _ = read_hooks(path)
        handlers = [
            h
            for group in existing.get("hooks", {}).get("UserPromptSubmit", [])
            for h in group["hooks"]
        ]
        matches = [h for h in handlers if owns_handler(h, expected)]
        result.update(
            replace_count=len(matches),
            installed=matches == [expected],
            status="installed" if matches == [expected] else "update" if matches else "missing",
            revision=digest(
                [str(path), hashlib.sha256(content).hexdigest(), snippet, digest(connection)]
            ),
        )
    except AgentServiceError as exc:
        result.update(can_install=False, status="blocked", error=exc.message)
    # Inline hooks are not rewritten; show their presence so users can avoid duplicates.
    try:
        import tomllib

        config = codex_home(connection) / "config.toml"
        if config.is_file() and config.stat().st_size <= MAX_CONFIG:
            raw = tomllib.loads(config.read_text())
            result["inline_hooks"] = bool(raw.get("hooks"))
            result["hooks_disabled"] = (
                raw.get("features", {}).get("hooks", raw.get("features", {}).get("codex_hooks"))
                is False
            )
    except (OSError, ValueError, TypeError):
        pass
    return result


def install(service, identifier, revision):
    connection = require_codex(service.repository, identifier)
    if connection.adapter_config.get("remote_host"):
        invalid("远端 Hook 必须安装到对应主机，不能安装到本机。")
    home = codex_home(connection)
    home.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (home / ".ai-persona-hooks.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        preview = installation(service, identifier)
        if Path(preview["path"]).parent != home:
            raise AgentServiceError("conflict", "Codex 目录已变化，请重新检查后再安装。")
        if not preview["can_install"]:
            invalid(preview["error"])
        if not isinstance(revision, str) or revision != preview["revision"]:
            raise AgentServiceError("conflict", "配置已发生变化，请重新检查后再安装。")
        if preview["installed"]:
            return {"installation": preview, "backup": None, "changed": False}
        path = Path(preview["path"])
        content, existing, mode = read_hooks(path)
        expected = preview["snippet"]["hooks"]["UserPromptSubmit"][0]["hooks"][0]
        groups = []
        for group in existing.setdefault("hooks", {}).get("UserPromptSubmit", []):
            kept = [h for h in group["hooks"] if not owns_handler(h, expected)]
            if kept or not group["hooks"]:
                groups.append({**group, "hooks": kept})
        groups.append(preview["snippet"]["hooks"]["UserPromptSubmit"][0])
        existing["hooks"]["UserPromptSubmit"] = groups
        updated = (json.dumps(existing, ensure_ascii=False, indent=2) + "\n").encode()
        if len(updated) > MAX_CONFIG:
            invalid("合并后的配置超过大小限制，请使用手动配置方式。")
        backup = None
        if content:
            backup = path.with_name(
                "hooks.json.ai-persona-backup-"
                + time.strftime("%Y%m%d-%H%M%S")
                + "-"
                + secrets.token_hex(3)
            )
            with os.fdopen(
                os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb"
            ) as stream:
                stream.write(content)
        fd, temporary = tempfile.mkstemp(prefix=".ai-persona-hooks-", dir=home)
        try:
            with os.fdopen(fd, "wb") as stream:
                os.fchmod(stream.fileno(), mode if mode is not None else 0o600)
                stream.write(updated)
                stream.flush()
                os.fsync(stream.fileno())
            # Guard against an editor changing the file after the preview or backup.
            if read_hooks(path)[0] != content:
                raise AgentServiceError("conflict", "配置刚刚被其他程序修改，请重新检查后再安装。")
            os.replace(temporary, path)
            with service.repository.transaction() as db:
                db.execute("DELETE FROM setup_checks WHERE connection_id=?", (identifier,))
        finally:
            with contextlib.suppress(FileNotFoundError):
                os.unlink(temporary)
    return {
        "installation": installation(service, identifier),
        "backup": str(backup) if backup else None,
        "changed": True,
    }


def probe_state(repository, connection):
    with repository.connect() as db:
        row = db.execute(
            "SELECT value FROM setup_checks WHERE connection_id=?", (connection.id,)
        ).fetchone()
    if not row:
        return None
    value = json.loads(row[0])
    if value["connection_revision"] != digest(connection):
        return {"status": "stale"}
    if value.get("result"):
        return {"status": "received", **value["result"]}
    if value["expires_at"] <= time.time():
        return {"status": "expired"}
    return {
        "status": "waiting",
        "expires_at": value["expires_at"],
        "message": PROBE_PREFIX + value["token"] + "\n这是一条接入验证消息，请只回复收到。",
    }


def begin_probe(repository, identifier):
    connection = require_codex(repository, identifier)
    value = {
        "token": secrets.token_hex(16),
        "expires_at": time.time() + 900,
        "connection_revision": digest(connection),
    }
    with repository.transaction() as db:
        db.execute(
            "INSERT INTO setup_checks VALUES (?,?) ON CONFLICT(connection_id) DO UPDATE SET value=excluded.value",
            (identifier, encoded(value)),
        )
    return probe_state(repository, connection)


def handle_probe(repository, connection, payload, *, captured=None):
    from .codex_input import capture_input, scope_for
    from .conversation_learning.input_text import learning_text

    prompt = learning_text(payload["prompt"]).strip()
    if not prompt.startswith(PROBE_PREFIX):
        return False
    match = PROBE_PATTERN.fullmatch(prompt)
    if not match:
        return False
    with repository.connect() as db:
        row = db.execute(
            "SELECT value FROM setup_checks WHERE connection_id=?", (connection.id,)
        ).fetchone()
    if not row:
        return True
    value = json.loads(row[0])
    if (
        value["expires_at"] <= time.time()
        or value["connection_revision"] != digest(connection)
        or not secrets.compare_digest(value["token"], match[1])
    ):
        return True
    _, reason = scope_for(connection, payload["cwd"], payload["session_id"])
    result = {
        "received_at": time.time(),
        "scope_ok": reason is None,
        "scope_reason": reason,
        "context_status": "not_checked",
        "context_messages": 0,
    }
    if reason is None:
        if captured is not None:
            captured.verify(connection.id, payload)
        else:
            captured = capture_input(connection, payload)
        result["context_status"] = (
            "disabled"
            if not connection.adapter_config.get("transcript_roots")
            else "readable"
            if captured.snapshot
            else captured.warning or "context_unavailable"
        )
        result["context_messages"] = len(captured.recent_messages)
    value["result"] = result
    with repository.transaction() as db:
        # A restarted probe or changed connection must not accept a late result.
        current = db.execute(
            "SELECT value FROM setup_checks WHERE connection_id=?", (connection.id,)
        ).fetchone()
        latest = repository.connection(connection.id, db)
        if (
            current
            and json.loads(current[0])["token"] == value["token"]
            and digest(latest) == value["connection_revision"]
        ):
            db.execute(
                "UPDATE setup_checks SET value=? WHERE connection_id=?",
                (encoded(value), connection.id),
            )
    return True


def status(service, identifier):
    connection = require_codex(service.repository, identifier)
    remote = bool(connection.adapter_config.get("remote_host"))
    return {
        "connection": connection.model_dump(),
        "connection_revision": digest(connection),
        "environment": ({"codex_home": str(codex_home(connection)), "remote": True,
                         "hostname": connection.adapter_config["remote_host"],
                         "sessions": {"path": str(codex_home(connection) / "sessions"),
                                      "exists": None, "readable": False},
                         "hooks_path": str(codex_home(connection) / "hooks.json")}
                        if remote else environment(str(codex_home(connection)))),
        "installation": installation(service, identifier),
        "probe": probe_state(service.repository, connection),
        "directories": [] if remote else [
            directory_info(Path(p)) for p in connection.adapter_config.get("transcript_roots", [])
        ],
    }
