from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import Field

class Settings(BaseSettings):
    """
    Central place for application configuration

    values can come from
    1. environment variables
    2. .env files
    3. the defaults below
    """

    app_name: str = "Production streaming LLM"
    environment: str = "development"

    # clients must sent this api key
    api_key: str = Field(validation_alias="GROQ_API_KEY")

    # LLM model
    model_name: str

    # rate limit settings
    rate_limit: int = 10
    rate_window_seconds: int = 60

    # load variables from .env
    model_config=SettingsConfigDict(
        env_file='.env',
        extra='ignore'
    )

settings=Settings()