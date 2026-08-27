"""Internal, network-free production passes for Comic30 game projects.

The browser/backend boundary is only transport. These functions never call an
LLM or third-party API and produce deterministic engine data from project state.
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from typing import Any


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _id(prefix: str, project: dict[str, Any], module: str) -> str:
    raw = f"{project.get('id')}:{module}:{len(project.get(module, []))}"
    return f"{prefix}_{hashlib.sha256(raw.encode()).hexdigest()[:12]}"


def _ensure(project: dict[str, Any]) -> None:
    for key in ("story", "scenes", "levels", "characters", "worlds", "terrain", "builds", "buildJobs", "activity"):
        project.setdefault(key, [])
    project.setdefault("gameplay", {}).setdefault("mechanics", [])
    economy = project.setdefault("economy", {})
    for key in ("iapProducts", "rewards", "sinks"):
        economy.setdefault(key, [])


def execute(project: dict[str, Any], module: str, prompt: str = "") -> dict[str, Any]:
    _ensure(project)
    title = project.get("title") or "Untitled Game"
    premise = project.get("premise") or project.get("design", {}).get("premise") or prompt
    stamp = _now()
    actions: list[dict[str, str]] = []

    if module == "story":
        value = {"id": _id("arc", project, module), "title": f"{title}: Rising Conflict", "summary": premise, "objectives": ["Establish the threat", "Force a player choice", "Persist the consequence"], "choices": [{"label": "Protect the team", "consequence": "Loyalty increases"}, {"label": "Pursue the objective", "consequence": "Mission pressure increases"}], "generatedAt": stamp}
        project["story"].append(value)
    elif module == "scene":
        value = {"id": _id("scene", project, module), "name": f"{title} Playable Scene {len(project['scenes']) + 1}", "type": "playable", "objective": prompt or "Resolve the encounter", "triggers": ["enter", "objective_complete", "choice_resolved"], "generatedAt": stamp}
        project["scenes"].append(value)
    elif module == "level":
        value = {"id": _id("level", project, module), "name": f"Level {len(project['levels']) + 1}", "order": len(project["levels"]) + 1, "objectives": ["Enter", "Complete encounter", "Extract"], "encounters": ["patrol", "elite", "choice_gate"], "generatedAt": stamp}
        project["levels"].append(value)
    elif module == "character":
        value = {"id": _id("char", project, module), "name": f"Playable Character {len(project['characters']) + 1}", "role": "player-controlled protagonist", "abilities": ["Traverse", "Interact", "Primary ability", "Ultimate"], "rig": {"skeleton": "humanoid", "animations": ["idle", "walk", "run", "interact"]}, "generatedAt": stamp}
        project["characters"].append(value)
    elif module == "gameplay":
        value = {"id": _id("mechanic", project, module), "name": prompt or "Context action", "input": "context_action", "stateMachine": ["ready", "active", "cooldown"], "effect": "Updates world and story state", "generatedAt": stamp}
        project["gameplay"]["mechanics"].append(value)
    elif module in ("world", "terrain"):
        world_id = _id("world", project, "worlds")
        terrain_id = _id("terrain", project, "terrain")
        project["worlds"].append({"id": world_id, "name": f"{title} World", "streaming": "cell-based", "sceneGraph": {"root": "world", "children": [terrain_id]}, "generatedAt": stamp})
        project["terrain"].append({"id": terrain_id, "name": "Production Terrain", "biome": "adaptive", "heightfield": {"seed": terrain_id, "resolution": 1024}, "navigation": {"mesh": "pending-bake"}, "generatedAt": stamp})
        value = project["worlds"][-1]
    elif module == "economy":
        value = {"id": _id("reward", project, module), "name": "Mission completion reward", "trigger": "mission_complete", "amount": 50, "generatedAt": stamp}
        project["economy"]["rewards"].append(value)
    elif module in ("build", "export"):
        value = {"id": _id("build", project, "builds"), "target": "android-ios", "status": "queued", "manifest": {"android": {"renderer": "Vulkan 1.3", "format": "AAB"}, "ios": {"renderer": "Metal", "format": "Xcode archive"}}, "createdAt": stamp}
        project["buildJobs"].append(value)
    else:
        raise ValueError(f"Unsupported engine module: {module}")

    actions.append({"type": module, "id": value["id"], "label": value.get("name") or value.get("title") or module})
    project["engine"] = {"core": "comic30-python", "renderer": {"android": "Vulkan 1.3", "ios": "Metal", "preview": "WebGL"}, "lastModule": module, "lastRunAt": stamp}
    project["updatedAt"] = stamp
    project["activity"].insert(0, {"id": _id("event", project, "activity"), "type": f"engine.{module}", "detail": f"{module} production pass completed", "createdAt": stamp})
    return {"project": project, "actions": actions, "engine": project["engine"]}


def main() -> None:
    import sys
    request = json.load(sys.stdin)
    json.dump(execute(request["project"], request["module"], request.get("prompt", "")), sys.stdout)


if __name__ == "__main__":
    main()
