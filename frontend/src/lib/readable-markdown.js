// 词典学习文章只需要可读排版；生成结构化节点，不执行原始 HTML、图片或脚本。

export function readableInline(text) {
  const result = [];
  const pattern =
    /\*\*([^*\n]+)\*\*|__([^_\n]+)__|`([^`\n]+)`|\*([^*\n]+)\*|_([^_\n]+)_|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let end = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > end) result.push({ kind: "text", text: text.slice(end, match.index) });
    if (match[1] || match[2]) result.push({ kind: "strong", text: match[1] || match[2] });
    else if (match[3]) result.push({ kind: "code", text: match[3] });
    else if (match[4] || match[5]) result.push({ kind: "em", text: match[4] || match[5] });
    else {
      // 只有绝对 HTTP(S) 链接成为可点击链接；协议仍由浏览器验证。
      try {
        const url = new URL(match[7]);
        if (!["https:", "http:"].includes(url.protocol)) throw new Error();
        result.push({ kind: "link", text: match[6], href: url.href });
      } catch {
        result.push({ kind: "text", text: match[0] });
      }
    }
    end = match.index + match[0].length;
  }
  if (end < text.length) result.push({ kind: "text", text: text.slice(end) });
  return result;
}

export function readableMarkdown(text) {
  const blocks = [];
  let paragraph = [],
    code = null;
  const flush = () => {
    if (paragraph.length) blocks.push({ tag: "p", text: paragraph.join("\n") });
    paragraph = [];
  };
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    if (/^```/.test(line)) {
      flush();
      if (code) {
        blocks.push({ tag: "pre", text: code.join("\n") });
        code = null;
      } else code = [];
      continue;
    }
    if (code) {
      code.push(raw);
      continue;
    }
    if (!line) {
      flush();
      continue;
    }
    const heading = /^(#{1,6})\s+(.+?)\s*#*$/.exec(line);
    if (heading) {
      flush();
      blocks.push({
        tag: heading[1].length <= 3 ? "h4" : heading[1].length === 4 ? "h5" : "h6",
        text: heading[2],
      });
      continue;
    }
    const list = /^(?:[-+*]\s+|(\d+)[.)]\s+)(.+)$/.exec(line);
    if (list) {
      flush();
      const tag = list[1] ? "ol" : "ul",
        last = blocks.at(-1);
      if (last?.tag === tag) last.items.push(list[2]);
      else blocks.push({ tag, items: [list[2]] });
      continue;
    }
    if (/^>\s?/.test(line)) {
      flush();
      blocks.push({ tag: "blockquote", text: line.replace(/^>\s?/, "") });
      continue;
    }
    paragraph.push(raw.trim());
  }
  flush();
  if (code) blocks.push({ tag: "pre", text: code.join("\n") });
  return blocks;
}
