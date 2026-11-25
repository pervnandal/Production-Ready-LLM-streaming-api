import asyncio
import json
from collections.abc import AsyncGenerator
from pathlib import Path

import uvicorn
from fastapi import BackgroundTasks, Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from src.config import settings
from src.models import ChatRequest, ChatResponse
from src.rate_limiter import check_rate_limit
from src.security import verify_api_key
from src.services.llm_service import call_llm_with_retry, stream_llm_words

# --------------------------------------------------
# APP SETUP
# --------------------------------------------------
app = FastAPI(title=settings.app_name, version="1.0.0")

# --------------------------------------------------
# TEMPLATES + STATIC FILES
# --------------------------------------------------
BASE_DIR = Path(__file__).resolve().parent

app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")
templates = Jinja2Templates(directory=BASE_DIR / "templates")

# --------------------------------------------------
# SIMPLE IN-MEMORY IDEMPOTENCY STORE
# --------------------------------------------------
# For teaching only. Production systems should use Redis or a database.
idempotency_store: dict[str, ChatResponse] = {}


# --------------------------------------------------
# BACKGROUND LOGGING
# --------------------------------------------------
def save_chat_log(message: str, answer: str):
    """Save chat information after the user receives the API response."""
    with open(BASE_DIR / "chat_logs.txt", "a", encoding="utf-8") as file:
        file.write(
            json.dumps({"message": message, "answer": answer}, ensure_ascii=False)
            + "\n"
        )


# --------------------------------------------------
# WEB PAGE
# --------------------------------------------------
@app.get("/", response_class=HTMLResponse)
async def home(request: Request):
    """Render the frontend UI."""
    return templates.TemplateResponse(
        request=request,
        name="index.html",
        context={
            "app_name": settings.app_name,
            "environment": settings.environment,
            "model_name": settings.model_name,
        },
    )


# --------------------------------------------------
# HEALTH CHECK
# --------------------------------------------------
@app.get("/health")
async def health():
    """Monitoring endpoint to verify API availability and active model."""
    return {
        "status": "healthy",
        "environment": settings.environment,
        "model": settings.model_name,
    }


# --------------------------------------------------
# NORMAL CHAT API
# --------------------------------------------------
@app.post("/v1/chat", response_model=ChatResponse)
async def chat(
    request: ChatRequest,
    background_tasks: BackgroundTasks,
    api_key: str = Depends(verify_api_key),
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
):
    """Normal non-streaming AI endpoint with auth, rate limiting, and idempotency."""
    check_rate_limit(api_key)

    # Return cached result if this idempotency key was already processed
    if idempotency_key and idempotency_key in idempotency_store:
        stored = idempotency_store[idempotency_key]
        return ChatResponse(answer=stored.answer, model=stored.model, cache=True)

    try:
        answer = await asyncio.wait_for(
            call_llm_with_retry(
                message=request.message,
                temperature=request.temperature,
            ),
            timeout=30,
        )
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="LLM request timed out")
    except Exception as error:
        raise HTTPException(status_code=503, detail=f"LLM service failed: {error}")

    response = ChatResponse(answer=answer, model=settings.model_name, cache=False)

    if idempotency_key:
        idempotency_store[idempotency_key] = response

    background_tasks.add_task(save_chat_log, request.message, answer)
    return response


# --------------------------------------------------
# STREAMING CHAT API
# --------------------------------------------------
@app.post("/v1/chat/stream")
async def chat_stream(
    request: ChatRequest,
    api_key: str = Depends(verify_api_key),
):
    """Authenticated, rate-limited SSE streaming endpoint."""
    check_rate_limit(api_key)

    async def logged_stream() -> AsyncGenerator[str, None]:
        collected: list[str] = []
        async for event in stream_llm_words(
            message=request.message,
            temperature=request.temperature,
        ):
            yield event

            # Collect streamed tokens so we can log the completed reply
            if event.startswith("data:"):
                lines = event.rstrip("\n").split("\n")
                chunk_text = "\n".join(
                    line[6:] if line.startswith("data: ") else line[5:]
                    for line in lines
                    if line.startswith("data:")
                )
                collected.append(chunk_text)

        if collected:
            save_chat_log(request.message, "".join(collected))

    return StreamingResponse(
        logged_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


if __name__ == "__main__":
    uvicorn.run("app:app", host="0.0.0.0", port=8000, reload=True)
