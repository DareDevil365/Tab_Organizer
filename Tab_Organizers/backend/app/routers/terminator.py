import json
from pathlib import Path
from typing import List, Optional
from pydantic import BaseModel
from fastapi import APIRouter

router = APIRouter(prefix="/api/terminator", tags=["terminator"])

DATA_DIR = Path("./data")
TERMINATOR_RULES_FILE = DATA_DIR / "terminator_rules.json"

DEFAULT_TERMINATOR_CONFIG = {
    "terminate_new_tabs": True,
    "deduplicate_tabs": True,
    "custom_targets": []
}


class TargetItem(BaseModel):
    pattern: str
    description: Optional[str] = ""
    enabled: bool = True


class TerminatorConfig(BaseModel):
    terminate_new_tabs: bool = True
    deduplicate_tabs: bool = True
    custom_targets: List[TargetItem] = []


def _load_terminator_rules() -> dict:
    if not TERMINATOR_RULES_FILE.exists():
        _save_terminator_rules(DEFAULT_TERMINATOR_CONFIG)
        return DEFAULT_TERMINATOR_CONFIG
    try:
        with open(TERMINATOR_RULES_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return DEFAULT_TERMINATOR_CONFIG


def _save_terminator_rules(config: dict) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with open(TERMINATOR_RULES_FILE, "w", encoding="utf-8") as f:
        json.dump(config, f, ensure_ascii=False, indent=2)


@router.get("/rules")
async def get_terminator_rules():
    """Returns the current Terminator cleanup rules configuration."""
    return _load_terminator_rules()


@router.put("/rules")
async def update_terminator_rules(config: TerminatorConfig):
    """Updates and persists the Terminator cleanup rules configuration."""
    data = config.model_dump()
    _save_terminator_rules(data)
    return {"status": "updated", "config": data}
