import time
from fastapi import HTTPException
from src.config import settings

# For teaching only.
#
# Example:
# {
#     "course-secret": [timestamp1, timestamp2]
# }
request_history: dict[str, list[float]] = {}


def check_rate_limit(client_id: str):
    """
    Allow only a limited number of requests
    inside a fixed time window.

    Production systems normally use Redis
    or an API gateway instead of a Python dictionary.
    """

    now = time.time()

    # First request from this client?
    if client_id not in request_history:
        request_history[client_id] = []

    # Keep only requests that are still
    # inside the configured time window.
    request_history[client_id] = [
        timestamp
        for timestamp in request_history[client_id]
        if now - timestamp < settings.rate_window_seconds
    ]

    # Too many requests?
    if len(request_history[client_id]) >= settings.rate_limit:
        raise HTTPException(
            status_code=429, detail="Too many requests. Please try again later."
        )

    # Record the current request.
    request_history[client_id].append(now)
