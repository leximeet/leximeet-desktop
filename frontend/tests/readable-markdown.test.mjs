import test from "node:test";
import assert from "node:assert/strict";
import { readableMarkdown, readableInline } from "../src/lib/readable-markdown.js";
test("词根文章转成标题、列表与段落，保留代码与强调", () => {
  const blocks = readableMarkdown(
    "### 词根分析\n\n词根是 **govern**。\n\n- management\n- punishment\n\n> 学习提示\n\n```text\n<script>literal</script>\n```",
  );
  assert.deepEqual(
    blocks.map((b) => b.tag),
    ["h4", "p", "ul", "blockquote", "pre"],
  );
  assert.deepEqual(blocks[2].items, ["management", "punishment"]);
  assert.equal(blocks[4].text, "<script>literal</script>");
  assert.equal(readableInline(blocks[1].text)[1].kind, "strong");
});
test("只输出文字和HTTP(S)安全链接，不执行HTML或加载图片", () => {
  const nodes = readableInline(
    "<img src=x onerror=alert(1)> [点击](javascript:alert) [参考](https://example.com)",
  );
  assert.equal(nodes.filter((n) => n.kind === "link").length, 1);
  assert.equal(nodes.find((n) => n.kind === "link").href, "https://example.com/");
  assert(nodes.some((n) => n.text.includes("onerror")));
  assert.equal(readableMarkdown("<script>alert(1)</script>")[0].tag, "p");
});
