import test from "node:test";
import assert from "node:assert/strict";
import { prepareToolValue, renderToolValue } from "../src/tool-content.mjs";
test("Persona images become durable DSH image blocks instead of base64 text", async () => {
  const input = {
    data: { citation_ref: "persona:source:a" },
    _image_content: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
  };
  const ref = { attachmentId: "image-1", mediaType: "image/png", bytes: 5, width: 1, height: 1 };
  const ctx = {
    attachments: {
      saveImages: async (images) => {
        assert.equal(images[0].data.toString(), "image");
        assert.equal(images[0].mediaType, "image/png");
        return [ref];
      },
    },
  };
  const value = await prepareToolValue(ctx, input);
  const content = renderToolValue(value);
  assert.deepEqual(content[1], { type: "image", attachment: ref });
  assert.equal(content[0].text, JSON.stringify(input.data ? { data: input.data } : {}));
  await assert.rejects(prepareToolValue({}, input), { code: "image_unavailable" });
});
