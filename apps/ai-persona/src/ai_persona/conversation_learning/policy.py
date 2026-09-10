"""Platform-independent source scope and user-selected origin policy."""

from .contracts import ConversationEvent, SourceConnection


def authorized(connection: SourceConnection, event: ConversationEvent) -> bool:
    if not connection.enabled:
        return False
    if connection.scope_mode == "all":
        return True
    if event.scope_ref is not None and event.scope_ref not in connection.allowed_scopes:
        return False
    if connection.allowed_scopes and event.scope_ref not in connection.allowed_scopes:
        return False
    if (
        connection.allowed_conversations
        and event.conversation_id not in connection.allowed_conversations
    ):
        return False
    return bool(
        connection.allowed_scopes
        or connection.allowed_conversations
        or connection.allow_all_conversations
    )


def origin_basis(
    connection: SourceConnection, event: ConversationEvent, *, human_confirmed: bool = False
) -> str | None:
    """Permission to generate review candidates; never rewrite the observed origin."""
    if event.message.role != "user" or event.message.origin == "automation":
        return None
    if human_confirmed:
        return "confirmed_human"
    if event.message.origin == "human" and connection.capabilities.verified_human_origin:
        return "verified_human"
    if connection.trust_user_messages:
        return "trusted_source"
    return None
