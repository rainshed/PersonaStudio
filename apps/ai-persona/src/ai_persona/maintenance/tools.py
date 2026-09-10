"""Use exactly the public MCP definitions without a loopback MCP connection."""

from __future__ import annotations

import inspect
from typing import get_type_hints

from pydantic import ConfigDict, create_model

from ..agent import AgentServiceError
from ..query_mcp import register_query_tools
from ..query_service import KnowledgeQueryService


class ToolRegistry:
    def __init__(self, data_root, state_root, *, source_ids=(), snapshot_store=None):
        self.entries = {}
        service = KnowledgeQueryService(
            data_root, state_root, extra_sources=set(source_ids), snapshot_store=snapshot_store
        )
        register_query_tools(self, data_root, state_root, service=service)

    def tool(self, *, name, description, **_):
        def register(fn):
            hints = get_type_hints(fn, include_extras=True)
            fields = {
                key: (
                    hints[key],
                    ... if value.default is inspect.Parameter.empty else value.default,
                )
                for key, value in inspect.signature(fn).parameters.items()
            }
            schema = create_model(name + "Input", __config__=ConfigDict(extra="forbid"), **fields)
            self.entries[name] = (fn, schema, description)
            return fn

        return register

    def definitions(self, names=None):
        return [
            {"name": name, "description": desc, "parameters": schema.model_json_schema()}
            for name, (_, schema, desc) in self.entries.items()
            if names is None or name in names
        ]

    def call(self, name, arguments):
        if name not in self.entries:
            raise AgentServiceError("invalid_tool", "未知查询工具。")
        fn, schema, _ = self.entries[name]
        values = schema.model_validate(arguments)
        result = fn(**{key: getattr(values, key) for key in type(values).model_fields})
        payload = result.structured_content
        return payload, [
            {"type": "image", "data": c.data, "mimeType": c.mime_type}
            for c in result.content
            if c.type == "image"
        ]
