"""Private Studio access through a loopback reverse proxy.

The configured origin is trusted configuration, never an X-Forwarded header.
The HTTP server must disable proxy_headers so client remains the socket peer.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from urllib.parse import urlsplit

from starlette.requests import Request
from starlette.responses import JSONResponse

from .agent import AgentServiceError

LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1", "testserver"}
LOCAL_CLIENTS = {"127.0.0.1", "::1", "testclient"}
SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


def origin_parts(value: str) -> tuple[str, str]:
    parsed = urlsplit(value)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path
        or parsed.query
        or parsed.fragment
        or "?" in value or "#" in value
        or any(c.isspace() for c in value)
        or "\\" in value
        or parsed.port == 0
        or parsed.netloc.endswith(":")
    ):
        raise ValueError("Expected an HTTP(S) origin without a path, credentials or query")
    return parsed.scheme, parsed.netloc.lower()


@dataclass(frozen=True)
class StudioAccess:
    public_origin: str = ""

    def __post_init__(self):
        if self.public_origin:
            origin_parts(self.public_origin)

    @classmethod
    def from_environment(cls):
        try:
            return cls(os.environ.get("AI_PERSONA_PUBLIC_ORIGIN", ""))
        except ValueError as exc:
            raise ValueError("AI_PERSONA_PUBLIC_ORIGIN must be a complete HTTP(S) origin") from exc

    def check(self, request: Request) -> None:
        if request.client and request.client.host not in LOCAL_CLIENTS:
            raise AgentServiceError("forbidden", "请通过本机 Studio 或已配置的私有入口访问。")
        try:
            # Reject ambiguous/multiple authorities before Starlette interprets the URL.
            hosts = request.headers.getlist("host")
            if len(hosts) != 1:
                raise ValueError("Ambiguous Host")
            _, host = origin_parts("http://" + hosts[0])
            local = urlsplit("http://" + host).hostname in LOCAL_HOSTS
            public = origin_parts(self.public_origin) if self.public_origin else None
            if not local and (public is None or host != public[1]):
                raise ValueError("Unconfigured Host")
            origins = request.headers.getlist("origin")
            if len(origins) > 1:
                raise ValueError("Ambiguous Origin")
            if origins:
                origin = origin_parts(origins[0])
                allowed = {public} if public and host == public[1] else {
                    (request.url.scheme, host), public,
                }
                if origin not in allowed:
                    raise ValueError("Cross-origin request")
            elif not local and request.method not in SAFE_METHODS:
                raise ValueError("Remote writes require Origin")
            if request.headers.get("sec-fetch-site") == "cross-site":
                raise ValueError("Cross-site request")
        except ValueError as exc:
            raise AgentServiceError("forbidden", "不允许此访问来源，请使用已配置的 Studio 地址。") from exc


class StudioAccessMiddleware:
    def __init__(self, app, policy: StudioAccess):
        self.app = app
        self.policy = policy

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            request = Request(scope)
            try:
                self.policy.check(request)
            except AgentServiceError as exc:
                response = JSONResponse(
                    {"ok": False, "error": {"code": exc.code, "message": exc.message}},
                    status_code=403, headers={"Cache-Control": "no-store"},
                )
                return await response(scope, receive, send)
            if self.policy.public_origin:
                scheme, host = origin_parts(self.policy.public_origin)
                if request.headers["host"].lower() == host:
                    # Correct generated redirects without trusting forwarded headers.
                    scope = {**scope, "scheme": scheme}
        await self.app(scope, receive, send)
