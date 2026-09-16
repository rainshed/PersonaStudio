"""Isolated integration server using the sibling AI Persona's actual query tools."""
import shutil
import sys
from pathlib import Path

project = Path(sys.argv[1])
workspace = Path(sys.argv[2])
sys.path.insert(0, str(project / "src"))

from mcp.server import MCPServer
from ai_persona.query_mcp import register_query_tools
from ai_persona.query_service import KnowledgeQueryService


class NoSemantic:
    signature = "paper-radar-test-no-semantic"

    def rank(self, query, documents):
        return {}, {"status": "disabled", "documents": len(documents)}


data = workspace / "persona-data"
shutil.copytree(project / "examples/demo-persona/persona-data", data)
state = workspace / "state"
service = KnowledgeQueryService(data, state, retriever=NoSemantic())
server = MCPServer(name="paper-radar-persona-integration-test")
register_query_tools(server, data, state, service=service)
server.run(transport="stdio")
