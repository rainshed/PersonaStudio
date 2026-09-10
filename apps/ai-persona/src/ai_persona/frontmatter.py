from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml
from yaml.events import AliasEvent
from yaml.tokens import AliasToken, AnchorToken


class FrontmatterError(ValueError):
    """Raised when a record does not use the supported frontmatter format."""


class StrictLoader(yaml.SafeLoader):
    """Safe YAML loader with duplicate-key and alias rejection."""

    def compose_node(self, parent: Any, index: Any) -> Any:
        if self.check_event(AliasEvent):
            raise FrontmatterError("YAML aliases are not supported")
        return super().compose_node(parent, index)


StrictLoader.yaml_implicit_resolvers = {
    key: [
        (tag, pattern)
        for tag, pattern in resolvers
        if tag != "tag:yaml.org,2002:timestamp"
    ]
    for key, resolvers in yaml.SafeLoader.yaml_implicit_resolvers.items()
}


def _construct_unique_mapping(
    loader: StrictLoader,
    node: yaml.MappingNode,
    deep: bool = False,
) -> dict[str, Any]:
    loader.flatten_mapping(node)
    result: dict[str, Any] = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if not isinstance(key, str):
            raise FrontmatterError("all YAML mapping keys must be strings")
        if key in result:
            raise FrontmatterError(f"duplicate YAML key: {key!r}")
        result[key] = loader.construct_object(value_node, deep=deep)
    return result


StrictLoader.add_constructor(
    yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG,
    _construct_unique_mapping,
)


def load_yaml_text(text: str, *, source: str) -> dict[str, Any]:
    try:
        for token in yaml.scan(text):
            if isinstance(token, (AnchorToken, AliasToken)):
                raise FrontmatterError(f"{source}: YAML anchors and aliases are not supported")
        value = yaml.load(text, Loader=StrictLoader)
    except FrontmatterError:
        raise
    except yaml.YAMLError as exc:
        raise FrontmatterError(f"{source}: invalid YAML: {exc}") from exc
    if not isinstance(value, dict):
        raise FrontmatterError(f"{source}: YAML root must be an object")
    return value


def load_yaml_file(path: Path) -> dict[str, Any]:
    return load_yaml_text(path.read_text(encoding="utf-8"), source=str(path))


def load_markdown_record(path: Path) -> tuple[dict[str, Any], str]:
    text = path.read_text(encoding="utf-8")
    lines = text.splitlines(keepends=True)
    if not lines or lines[0].strip() != "---":
        raise FrontmatterError(f"{path}: record must start with a YAML frontmatter fence")
    closing_index = next(
        (index for index, line in enumerate(lines[1:], start=1) if line.strip() == "---"),
        None,
    )
    if closing_index is None:
        raise FrontmatterError(f"{path}: frontmatter fence is not closed")
    frontmatter_text = "".join(lines[1:closing_index])
    body = "".join(lines[closing_index + 1 :]).strip()
    return load_yaml_text(frontmatter_text, source=str(path)), body


def dump_markdown_record(data: dict[str, Any], body: str) -> str:
    """Serialize one canonical record using the strict frontmatter convention."""
    frontmatter = yaml.safe_dump(
        data,
        allow_unicode=True,
        default_flow_style=False,
        sort_keys=False,
    ).rstrip()
    normalized_body = body.replace("\r\n", "\n").replace("\r", "\n").strip()
    if normalized_body:
        return f"---\n{frontmatter}\n---\n\n{normalized_body}\n"
    return f"---\n{frontmatter}\n---\n"
