"""Local-only transport for shared result handling. No model calls or auto-approval."""
from fastapi import Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from .ai_web import check_request, failure, input_json
from .candidate_review import ReviewInputError
from .conversation_learning.service import ConversationLearningService
from .i18n import request_locale
from .inbox import InboxService
from .proposals import ProposalError, StaleProposalError
from .store import PersonaStore


def mount_inbox_routes(app, data_root, state_root, templates, common_context):
    def service(request):
        if not hasattr(app.state, "learning_service"):
            app.state.learning_service = ConversationLearningService(data_root, state_root)
        return InboxService(data_root, state_root, app.state.learning_service, request_locale(request))

    @app.get("/inbox")
    async def page(request: Request):
        check_request(request)
        context = common_context(request, PersonaStore(data_root).load(verify_source_files=False), section="inbox")
        return templates.TemplateResponse(request, "inbox.html", context)

    @app.get("/api/inbox/v1/items")
    async def items(request: Request):
        try:
            check_request(request)
            return JSONResponse(await run_in_threadpool(service(request).list, request.query_params), headers={"Cache-Control": "no-store"})
        except Exception as exc:
            return failure(exc)

    @app.get("/api/inbox/v1/items/{ref}")
    async def detail(ref: str, request: Request):
        try:
            check_request(request)
            return JSONResponse(await run_in_threadpool(service(request).detail, ref), headers={"Cache-Control": "no-store"})
        except Exception as exc:
            return failure(exc)

    @app.get("/api/inbox/v1/items/{ref}/review")
    async def candidates(ref: str, request: Request):
        try:
            check_request(request)
            return JSONResponse(await run_in_threadpool(service(request).review, ref), headers={"Cache-Control": "no-store"})
        except Exception as exc:
            return failure(exc)

    @app.post("/api/inbox/v1/items/{ref}/review/{proposal_id}")
    async def decide(ref: str, proposal_id: str, request: Request):
        try:
            body = await input_json(request)
            return JSONResponse(await run_in_threadpool(service(request).review, ref, proposal_id, body), headers={"Cache-Control": "no-store"})
        except ProposalError as exc:
            return JSONResponse({"error": {"message": str(exc), "fields": exc.fields if isinstance(exc, ReviewInputError) else {}}}, status_code=409 if isinstance(exc, StaleProposalError) else 422, headers={"Cache-Control": "no-store"})
        except Exception as exc:
            return failure(exc)
