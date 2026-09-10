"""Local-only Studio transport; the worker is independent of the HTTP lifecycle."""

from __future__ import annotations

from fastapi import Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from .. import codex_setup
from ..ai_web import check_request, failure, input_json
from ..proposals import ProposalError, StaleProposalError
from ..studio_links import legacy_inbox
from .cli import hook_config
from .contracts import ContextSnapshot, ConversationEvent, LearningSettings, SourceConnection
from .review import LearningReview, ReviewInputError
from .service import ConversationLearningService
from .views import LearningViews
from .worker import start_worker, stop_worker, worker_status


def mount_learning_routes(app, data_root, state_root, templates, common_context):
    # Lazy storage initialization: merely creating the app does not create a queue.
    def service():
        if not hasattr(app.state, "learning_service"):
            app.state.learning_service = ConversationLearningService(data_root, state_root)
        return app.state.learning_service

    @app.get("/learning")
    async def page(request: Request):
        check_request(request)
        if request.query_params.get("settings") == "1":
            from fastapi.responses import RedirectResponse
            return RedirectResponse("/settings?tab=capabilities", status_code=303)
        return legacy_inbox(request, kind="learning", key=request.query_params.get("event"), defaults={"view": "all", "type": "learning"})

    @app.get("/api/learning/v1/config")
    async def config(request: Request):
        try:
            check_request(request)
            current = service()
            return JSONResponse(
                {
                    "settings": current.repository.settings().model_dump(),
                    "connections": [c.model_dump() for c in current.repository.connections()],
                    "worker": worker_status(current.repository),
                    **current.repository.health(),
                },
                headers={"Cache-Control": "no-store"},
            )
        except Exception as exc:
            return failure(exc)

    @app.post("/api/learning/v1/settings")
    async def settings(request: Request):
        try:
            value = LearningSettings.model_validate(await input_json(request))
            service().repository.save_settings(value)
            return {"settings": value.model_dump()}
        except Exception as exc:
            return failure(exc)

    @app.post("/api/learning/v1/connections")
    async def connections(request: Request):
        try:
            value = SourceConnection.model_validate(await input_json(request))
            resumed = service().repository.save_connection(value)
            return {"connection": value.model_dump(), "resumed_events": resumed}
        except Exception as exc:
            return failure(exc)

    @app.get("/api/learning/v1/codex/environment")
    async def codex_environment(request: Request):
        try:
            check_request(request)
            return JSONResponse(codex_setup.environment(request.query_params.get("home")), headers={"Cache-Control": "no-store"})
        except Exception as exc:
            return failure(exc)

    @app.post("/api/learning/v1/codex/connections")
    async def codex_connection(request: Request):
        try:
            raw = await input_json(request)
            if not isinstance(raw.get("expected_revision"), str):
                raise ValueError("需要接入设置版本。")
            value = codex_setup.normalize_connection(raw.get("connection"))
            current = service()
            resumed = current.repository.save_connection(value, expected_revision=raw["expected_revision"])
            return {"connection": value.model_dump(), "resumed_events": resumed,
                    "setup": codex_setup.status(current, value.id)}
        except Exception as exc:
            return failure(exc)

    @app.get("/api/learning/v1/connections/{identifier}/setup")
    async def codex_setup_status(identifier: str, request: Request):
        try:
            check_request(request)
            return JSONResponse(codex_setup.status(service(), identifier), headers={"Cache-Control": "no-store"})
        except Exception as exc:
            return failure(exc)

    @app.post("/api/learning/v1/connections/{identifier}/setup/install")
    async def codex_install(identifier: str, request: Request):
        try:
            raw = await input_json(request)
            return await run_in_threadpool(codex_setup.install, service(), identifier, raw.get("revision"))
        except Exception as exc:
            return failure(exc)

    @app.post("/api/learning/v1/connections/{identifier}/setup/probe")
    async def codex_probe(identifier: str, request: Request):
        try:
            if await input_json(request):
                raise ValueError("此操作不接受参数。")
            return {"probe": codex_setup.begin_probe(service().repository, identifier)}
        except Exception as exc:
            return failure(exc)

    @app.get("/api/learning/v1/events")
    async def events(request: Request):
        try:
            check_request(request)
            return JSONResponse(
                await run_in_threadpool(LearningViews(service()).list, request.query_params),
                headers={"Cache-Control": "no-store"},
            )
        except Exception as exc:
            return failure(exc)

    @app.post("/api/learning/v1/events")
    async def ingest(request: Request):
        try:
            body = await input_json(request)
            snapshot = body.pop("snapshot", None)
            event = ConversationEvent.model_validate(body)
            # This transport remains trusted-local-only. Remote connectors must bind a
            # real authenticated principal; the anti-CSRF header is not remote auth.
            result = await run_in_threadpool(
                service().ingest_event,
                event,
                event.source_connection_id,
                ContextSnapshot.model_validate(snapshot) if snapshot else None,
            )
            return JSONResponse(result, status_code=202 if result["status"] == "accepted" else 200)
        except Exception as exc:
            return failure(exc)

    @app.get("/api/learning/v1/events/{identifier}")
    async def event_detail(identifier: str, request: Request):
        try:
            check_request(request)
            return JSONResponse(
                await run_in_threadpool(LearningViews(service()).detail, identifier),
                headers={"Cache-Control": "no-store"},
            )
        except Exception as exc:
            return failure(exc)

    @app.post("/api/learning/v1/events/{identifier}/{action}")
    async def event_action(identifier: str, action: str, request: Request):
        try:
            body = await input_json(request)
            current = service()
            row = current.repository.get(identifier)
            if action == "context":
                return current.attach_context(
                    identifier, ContextSnapshot.model_validate(body), row["connection_id"]
                )
            if set(body) != {"version"} or type(body["version"]) is not int:
                raise ValueError("需要任务版本。")
            if action in {"retry", "confirm-human"}:
                return current.retry_job(
                    identifier,
                    body["version"],
                    row["connection_id"],
                    confirm_human=action == "confirm-human",
                )
            if action == "cancel":
                return current.cancel(identifier, body["version"], row["connection_id"])
            raise ValueError("不支持的操作。")
        except Exception as exc:
            return failure(exc)

    @app.get("/api/learning/v1/events/{identifier}/review")
    async def review_candidates(identifier: str, request: Request):
        try:
            check_request(request)
            return JSONResponse(await run_in_threadpool(LearningReview(service()).list, identifier), headers={"Cache-Control": "no-store"})
        except Exception as exc:
            return failure(exc)

    @app.post("/api/learning/v1/events/{identifier}/review/{proposal_id}")
    async def review_candidate(identifier: str, proposal_id: str, request: Request):
        try:
            body = await input_json(request)
            return JSONResponse(await run_in_threadpool(LearningReview(service()).decide, identifier, proposal_id, body), headers={"Cache-Control": "no-store"})
        except ProposalError as exc:
            return JSONResponse({"error": {"message": str(exc), "fields": exc.fields if isinstance(exc, ReviewInputError) else {}}}, status_code=409 if isinstance(exc, StaleProposalError) else 422, headers={"Cache-Control": "no-store"})
        except Exception as exc:
            return failure(exc)

    @app.get("/api/learning/v1/connections/{identifier}/hook-config")
    async def hook(identifier: str, request: Request):
        try:
            check_request(request)
            return JSONResponse(
                hook_config(service(), identifier), headers={"Cache-Control": "no-store"}
            )
        except Exception as exc:
            return failure(exc)

    @app.post("/api/learning/v1/worker/start")
    async def worker_start(request: Request):
        try:
            if await input_json(request):
                raise ValueError("此操作不接受参数。")
            return start_worker(service())
        except Exception as exc:
            return failure(exc)

    @app.post("/api/learning/v1/cleanup")
    async def cleanup(request: Request):
        try:
            if await input_json(request):
                raise ValueError("此操作不接受参数。")
            return service().cleanup()
        except Exception as exc:
            return failure(exc)

    @app.post("/api/learning/v1/worker/stop")
    async def worker_stop(request: Request):
        try:
            if await input_json(request):
                raise ValueError("此操作不接受参数。")
            return stop_worker(service())
        except Exception as exc:
            return failure(exc)
