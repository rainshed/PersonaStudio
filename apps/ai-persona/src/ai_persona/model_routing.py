"""Resolve the four model selections while preserving earlier routing versions."""


def model_task(settings: dict, task: str) -> str:
    version = settings.get("routingVersion")
    if version not in {2, 3}:
        return task
    if task == "conversation_signal":
        return "conversation_learning" if version == 2 else task
    return {
        "material": "maintenance",
        "conversation_candidate": "conversation_learning",
    }.get(task, task)
