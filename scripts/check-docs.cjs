"use strict";
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");

// 公开文档不得依赖个人工作区；检查本仓文件链接和敏感路径，不请求外部 URL。
function checkDocs(directory = root) {
  const docRoot = path.resolve(directory);
  const files = [
    ...fs.readdirSync(docRoot).filter((name) => name.endsWith(".md")),
    "frontend/README.md",
    ...fs
      .readdirSync(path.join(docRoot, "docs"))
      .filter((name) => name.endsWith(".md"))
      .map((name) => `docs/${name}`),
  ];
  const errors = [];
  for (const name of files) {
    const body = fs.readFileSync(path.join(docRoot, name), "utf8");
    if (/\/Users\/[\w\u4e00-\u9fff-]+\//u.test(body)) errors.push(`${name}: 个人绝对路径`);
    // 移除示例代码，避免把代码中的括号误识别为 Markdown 链接。
    const markdown = body.replace(/```[\s\S]*?```/g, "");
    for (const match of markdown.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = match[1].replace(/^<|>$/g, "").split(/\s+"/)[0];
      if (/^(?:https?:|mailto:|#)/i.test(target)) continue;
      const file = decodeURIComponent(target.split(/[?#]/)[0]);
      const destination = path.resolve(docRoot, path.dirname(name), file);
      const relative = path.relative(docRoot, destination);
      // 多仓工作区可能恰好存在邻仓；公开文档仍须在单独克隆后可用。
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
        errors.push(`${name}: 链接越出仓库，请使用公开 URL ${file}`);
      else if (!fs.existsSync(destination)) errors.push(`${name}: 缺失链接 ${file}`);
    }
    for (const match of markdown.matchAll(/(?:src|href)="([^"]+)"/g)) {
      if (/^(?:https?:|#)/i.test(match[1])) continue;
      const destination = path.resolve(docRoot, path.dirname(name), decodeURIComponent(match[1]));
      const relative = path.relative(docRoot, destination);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
        errors.push(`${name}: HTML 链接越出仓库，请使用公开 URL ${match[1]}`);
      else if (!fs.existsSync(destination)) errors.push(`${name}: 缺失 HTML 链接 ${match[1]}`);
    }
  }
  if (errors.length) throw new Error(errors.join("\n"));
  console.log(`公开文档 ${files.length} 篇：本地链接与个人路径检查通过`);
}
if (require.main === module) {
  try {
    checkDocs();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
module.exports = { checkDocs };
