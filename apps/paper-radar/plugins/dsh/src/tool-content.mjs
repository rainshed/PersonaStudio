import { toolTextValue } from "@paper-radar/host-contract/tool-content";
import { BridgeError } from "./transport.mjs";

export async function prepareToolValue(ctx, value) {
  if (!value?._image_content?.length) return value;
  if (!ctx.attachments?.saveImages)
    throw new BridgeError("image_unavailable", "宿主未提供图片附件读取能力。");
  const refs = await ctx.attachments.saveImages(
    value._image_content.map((image) => ({
      data: Buffer.from(image.data, "base64"),
      mediaType: image.mimeType,
    })),
  );
  return {
    ...toolTextValue(value),
    _dsh_image_content: refs.map((attachment) => ({ type: "image", attachment })),
  };
}
export function renderToolValue(value) {
  if (!value?._dsh_image_content) return [{ type: "text", text: JSON.stringify(value) }];
  const { _dsh_image_content: images, ...text } = value;
  return [{ type: "text", text: JSON.stringify(text) }, ...images];
}
