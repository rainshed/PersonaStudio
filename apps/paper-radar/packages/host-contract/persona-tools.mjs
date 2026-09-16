// Business query parameters are shared by every research task. The caller owns
// scope and revision; these tools never expose preference or mutation APIs.
export const PERSONA_READING_VERSION = "persona-query-tools/v1";
const str = { type: "string", minLength: 1, maxLength: 12000 };
const integer = (minimum, maximum) => ({
  type: "integer",
  minimum,
  ...(maximum == null ? {} : { maximum }),
});
const choice = (...values) => ({ type: "string", enum: values });
const list = (items, maxItems = 100) => ({ type: "array", items, minItems: 1, maxItems });
const object = (properties, required = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const ids = list(str, 10);
const relations = list(
  choice("broader_than", "part_of", "requires", "applied_in", "related_to", "covers"),
);
const graph = {
  focus_ids: ids,
  max_hops: integer(1, 2),
  relation_types: relations,
  direction: choice("incoming", "outgoing", "both"),
};
const page = { max_chars: integer(1000, 60000), cursor: str };
const file = object({ source_id: str, file_id: str }, ["source_id", "file_id"]);
const selector = object({
  lines: object({ start: integer(1), end: integer(1) }, ["start", "end"]),
  pages: list(integer(1)),
  section_id: str,
  offset: integer(0),
  length: integer(1),
  range: str,
});
const tool = (name, description, properties, required = []) => ({
  name,
  description,
  parameters: object(properties, required),
});
export const PERSONA_QUERY_TOOLS = [
  tool(
    "get_knowledge_map",
    "Read the selected knowledge graph or expand known nodes and relationships. Results carry citation_ref, revision and coverage.",
    {
      ...graph,
      knowledge_role: choice(
        "topic",
        "problem",
        "method",
        "theory",
        "model",
        "application",
        "result",
        "background",
        "mentioned",
      ),
      salience: choice("primary", "secondary", "mentioned"),
      ...page,
    },
  ),
  tool(
    "search_knowledge",
    "Search knowledge, courses and materials in the selected scope. Empty query lists records matching filters. Interest and mastery are explicit user fields; unspecified is unknown. citation_ref identifies evidence; coverage describes this query only.",
    {
      query: { type: "string", maxLength: 12000 },
      ...graph,
      focus_mode: choice("prefer", "only"),
      entity_types: list(choice("knowledge_node", "course", "material")),
      knowledge_levels: list(choice("proficient", "familiar", "aware", "unspecified")),
      interest_levels: list(choice("high", "medium", "low", "unspecified")),
      material_types: list(
        choice(
          "article",
          "note",
          "paper",
          "book",
          "course_material",
          "conversation",
          "resume",
          "other",
        ),
      ),
      user_relationships: list(choice("authored", "studied", "read", "skimmed")),
      limit: integer(1, 50),
      ...page,
    },
  ),
  tool(
    "get_persona_records",
    "Read up to ten knowledge, course, material or relation records. Optional fields select content; body selects original notes. citation_ref identifies the delivered evidence; cursors continue partial records.",
    {
      record_ids: ids,
      fields: list(str),
      include_evidence: { type: "boolean" },
      ...page,
    },
    ["record_ids"],
  ),
  tool(
    "list_source_files",
    "List files belonging to an in-scope source. Returns file IDs, types, available views, hashes and parse status.",
    {
      source_id: str,
      directory: { type: "string", maxLength: 12000 },
      recursive: { type: "boolean" },
      file_types: list(str),
      limit: integer(1, 200),
      ...page,
    },
    ["source_id"],
  ),
  tool(
    "search_source_content",
    "Search one or more in-scope sources or files. Results include original passages, citation_ref, locators, passage_ref and index coverage.",
    {
      query: str,
      source_ids: list(str),
      files: list(file),
      limit: integer(1, 50),
      context_chars: integer(100, 4000),
      ...page,
    },
    ["query"],
  ),
  tool(
    "read_source",
    "Read an in-scope source_id + file_id, evidence_id, or passage_ref directly. Choose outline, text, image or structured view and a selector. Pages and lines are one-based. next_selector continues incomplete content; citation_ref identifies the returned evidence.",
    {
      source_id: str,
      file_id: str,
      evidence_id: str,
      passage_ref: str,
      view: choice("auto", "outline", "text", "image", "structured"),
      selector,
      max_images: integer(1, 4),
      max_chars: integer(1000, 60000),
    },
  ),
];
export const PERSONA_QUERY_NAMES = new Set(PERSONA_QUERY_TOOLS.map((t) => t.name));

export function personaArguments(name, args = {}) {
  const definition = PERSONA_QUERY_TOOLS.find((t) => t.name === name);
  const fail = (path) => {
    throw Object.assign(new Error(`Invalid Persona query argument: ${path}`), {
      code: "invalid_arguments",
    });
  };
  function check(value, schema, path) {
    if (schema.enum && !schema.enum.includes(value)) fail(path);
    if (schema.type === "object") {
      if (!value || typeof value !== "object" || Array.isArray(value)) fail(path);
      for (const key of schema.required ?? [])
        if (!Object.hasOwn(value, key)) fail(`${path}.${key}`);
      for (const [key, v] of Object.entries(value)) {
        if (!Object.hasOwn(schema.properties, key)) fail(`${path}.${key}`);
        check(v, schema.properties[key], `${path}.${key}`);
      }
    } else if (schema.type === "array") {
      if (!Array.isArray(value) || value.length < schema.minItems || value.length > schema.maxItems)
        fail(path);
      value.forEach((v, i) => check(v, schema.items, `${path}[${i}]`));
    } else if (schema.type === "integer") {
      if (
        !Number.isSafeInteger(value) ||
        value < schema.minimum ||
        (schema.maximum != null && value > schema.maximum)
      )
        fail(path);
    } else if (
      typeof value !== schema.type ||
      (typeof value === "string" &&
        (value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity)))
    )
      fail(path);
  }
  if (!definition) fail(name);
  check(args, definition.parameters, name);
  if (
    name === "read_source" &&
    (Number(!!(args.source_id || args.file_id)) +
      Number(!!args.evidence_id) +
      Number(!!args.passage_ref) !==
      1 ||
      !!args.source_id !== !!args.file_id)
  )
    fail("read_source.reference");
  if (name === "search_source_content" && Number(!!args.source_ids) + Number(!!args.files) !== 1)
    fail("search_source_content.sources");
  if (args.focus_mode === "only" && !args.focus_ids) fail("focus_ids");
  if (args.selector?.lines && args.selector.lines.start > args.selector.lines.end)
    fail("selector.lines");
  return { max_chars: 16000, ...args };
}
