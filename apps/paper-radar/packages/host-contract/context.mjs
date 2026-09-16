export const HOST_CONTEXT_VERSION = "paper-radar.host-context/v1";
export const CODEX_BASE_INSTRUCTIONS =
  "Use only the paper-radar MCP tools provided for this task. Never use shell, files, web search, apps, plugins, skills, subagents, hooks, memories, or any AI Persona integration.";
export const SUBMISSION_RECEIPT_SCHEMA = {
  type: "object",
  properties: { status: { type: "string", enum: ["submitted"] } },
  required: ["status"],
  additionalProperties: false,
};
export const missingSubmissionPrompt = (submitTool) =>
  `The task has no submitted result. The result interface is ${submitTool}.`;
export const codexToolDefinitions = (tools) =>
  tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters,
    annotations: {
      readOnlyHint: ![
        "notes_save",
        "task_save_result",
        "task_submit_result",
        "screening_submit_result",
      ].includes(tool.name),
      destructiveHint: false,
    },
  }));
export function hostContext(backend, request) {
  const known = ["codex", "dsh"].includes(backend);
  return {
    version: HOST_CONTEXT_VERSION,
    backend: known ? backend : "unconfigured",
    messages: [
      ...(backend === "codex"
        ? [
            {
              role: "baseInstructions",
              source: "paper-radar:codex-adapter",
              text: CODEX_BASE_INSTRUCTIONS,
            },
          ]
        : []),
      {
        role: backend === "codex" ? "developerInstructions" : "system",
        source: "paper-radar:prompt-settings",
        text: request.systemPrompt,
      },
      { role: "user", source: "paper-radar:task-input", text: request.prompt },
    ],
    ...(backend === "codex" && request.submitTool
      ? { response_schema: SUBMISSION_RECEIPT_SCHEMA }
      : {}),
    ...(backend === "codex" && request.tools
      ? { tool_definitions: codexToolDefinitions(request.tools) }
      : {}),
    conditional_messages:
      backend === "dsh"
        ? [
            {
              condition: "missing_submission",
              role: "user",
              source: "paper-radar:dsh-adapter",
              text: missingSubmissionPrompt(request.submitTool),
            },
          ]
        : [],
    visibility: "application_boundary",
    unavailable: known
      ? ["provider_internal_context", "provider_internal_compaction_content"]
      : ["host_not_selected"],
  };
}
