// Image bytes travel separately from model-facing JSON and become actual image
// blocks at each host, rather than base64 text in the model context.
export const MAX_TOOL_RESPONSE_BYTES = 24 * 1024 * 1024;
export function toolTextValue(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const { _image_content: _images, ...text } = value;
  return text;
}
export function toolContent(value) {
  return [
    { type: "text", text: JSON.stringify(toolTextValue(value)) },
    ...(value?._image_content ?? []),
  ];
}
