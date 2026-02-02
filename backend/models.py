from pydantic import BaseModel, Field
from typing import List


class CampaignRequest(BaseModel):
    brief: str = Field(..., description="Short campaign brief or request")
    goal: str = Field("Increase awareness", description="Primary campaign goal")
    audience: str = Field("General audience", description="Target audience")
    channels: List[str] = Field(default_factory=lambda: ["Email", "LinkedIn", "Web"], description="Channels to target")
    tone: str = Field("Confident, helpful", description="Tone of voice")
    brand_constraints: str = Field("", description="Brand or compliance constraints")
    loop_limit: int = Field(2, description="Max writer-reviewer loops before human review")
