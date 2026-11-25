from fastapi import Depends,HTTPException
from fastapi.security import APIKeyHeader
from src.config import settings

# Read the API key from:

# X-API-KEY 

api_key_header=APIKeyHeader(
    name="X-API-KEY",
    auto_error=False
)

def verify_api_key(api_key: str | None = Depends(api_key_header)):
    """Simple API-KEY authentication"""
    
    if api_key != settings.api_key:
        raise HTTPException(
            status_code=401,
            detail="Invalid or missing API key"
        )
    return api_key