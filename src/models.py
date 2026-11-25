from pydantic import Field, BaseModel


class ChatRequest(BaseModel):
    """Request sent by client"""

    # Message
    message: str = Field(min_length=1, max_length=2000)

    # Temperature
    temperature: float = Field(default=0.7, ge=0, le=2)


class ChatResponse(BaseModel):
    """
    Normal Non-streaming response
    """

    answer: str
    model: str
    cache: bool = False
