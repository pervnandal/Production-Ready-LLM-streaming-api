import asyncio
from collections.abc import AsyncGenerator
from langchain_groq import ChatGroq
from src.config import settings


def _get_llm(temperature: float = 0.7) -> ChatGroq:
    """Initialize a ChatGroq client using values from src.config.settings."""
    return ChatGroq(
        api_key=settings.api_key,
        model=settings.model_name,
        temperature=temperature,
    )


async def call_llm(
    message: str,
    temperature: float = 0.7,
) -> str:
    """Make a single non-streaming asynchronous LLM call."""
    llm = _get_llm(temperature=temperature)
    response = await llm.ainvoke(message)
    return str(response.content)


async def call_llm_with_retry(
    message: str,
    temperature: float = 0.7,
    max_attempts: int = 3,
) -> str:
    """Call the LLM with exponential backoff retries."""
    for attempt in range(1, max_attempts + 1):
        try:
            return await call_llm(
                message=message,
                temperature=temperature,
            )
        except Exception:
            if attempt == max_attempts:
                raise
            await asyncio.sleep(2 ** (attempt - 1))  # 1s, 2s, ...


async def stream_llm_words(
    message: str,
    temperature: float = 0.7,
    max_attempts: int = 3,
) -> AsyncGenerator[str, None]:
    """Stream real LLM tokens in Server-Sent Events (SSE) format."""
    llm = _get_llm(temperature=temperature)

    for attempt in range(1, max_attempts + 1):
        started_streaming = False
        try:
            async for chunk in llm.astream(message):
                content = chunk.content
                if not content:
                    # Skip empty metadata/reasoning chunks
                    continue

                started_streaming = True
                # Keep multi-line tokens compliant with the SSE protocol
                safe_content = str(content).replace("\n", "\ndata: ")
                yield f"data: {safe_content}\n\n"

            yield "event: done\ndata: completed\n\n"
            return

        except Exception as e:
            # Retry only if no tokens have been sent to the client yet
            if started_streaming or attempt == max_attempts:
                safe_error = str(e).replace("\n", " ")
                yield f"event: error\ndata: {safe_error}\n\n"
                return
            await asyncio.sleep(2 ** (attempt - 1))
