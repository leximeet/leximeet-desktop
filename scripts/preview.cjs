const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { resolveProfile } = require("../electron/services/profiles.cjs");
const { JavaRuntime } = require("../electron/services/java-runtime.cjs");
const { createBridge, METHODS } = require("../electron/services/bridge.cjs");
const { TextDictionaryService } = require("../electron/services/text-dictionary.cjs");
const { PronunciationService } = require("../electron/services/pronunciation.cjs");

// 仅用于可视验收：绑定回环地址、使用独立临时库，浏览器不能获知 Java token。
async function preview({
  port = Number(process.env.LEXIMEET_PREVIEW_PORT || 4318),
  demo = false,
} = {}) {
  const root = path.resolve(__dirname, "..");
  const publicDir = path.join(root, "frontend/dist");
  const profile = resolveProfile({ name: "preview", projectDir: root });
  const core = await new JavaRuntime({
    jarPath: path.join(root, "core-java/target/leximeet-core.jar"),
    dataDir: profile.coreDir,
    demo,
  }).start();
  const textDictionary = new TextDictionaryService({
    core,
    profile,
    bundledPath: path.join(root, "resources/dictionary"),
    localSource: process.env.LEXIMEET_DICTIONARY_SOURCE,
  });
  try {
    await textDictionary.ensure();
  } catch (error) {
    await core.stop();
    throw error;
  }
  const pronunciation = new PronunciationService({
    directory: profile.root,
    nativeEvent: (event) => core.request("/api/desktop/guide-native", "POST", { event }),
  });
  const bridge = createBridge({
    core,
    profile,
    textDictionary,
    pronunciation,
  });
  const baseRuntime = bridge.runtime;
  bridge.runtime = () => ({
    ...baseRuntime(),
    dictionary: "leximeet-dictionary 0.0.3",
    dictionaryPack: textDictionary.status(),
    plugins: false,
    connectorProtocolVersion: null,
  });
  bridge.connectionSettings = () => {
    throw new Error("浏览器预览不注册本机连接，请使用隔离桌面应用");
  };
  const session = randomBytes(32).toString("hex");
  let origin;
  const server = http.createServer(async (req, res) => {
    const headers = {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'",
    };
    const json = (status, data) => {
      res.writeHead(status, { ...headers, "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    };
    try {
      if (req.headers.host !== new URL(origin).host) return json(403, { error: "Host 不匹配" });
      const url = new URL(req.url, origin);
      if (url.pathname.startsWith("/__bridge/")) {
        if (
          req.method !== "POST" ||
          req.headers.origin !== origin ||
          !req.headers.cookie?.split("; ").includes(`leximeet_preview=${session}`)
        )
          return json(403, { error: "只接受当前验收页面的请求" });
        const method = url.pathname.slice("/__bridge/".length);
        if (!METHODS.includes(method) || method === "openExternal")
          return json(404, { error: "未开放的验收接口" });
        const chunks = [];
        let bytes = 0;
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > (method === "importData" ? 64 : 2) * 1024 * 1024)
            return json(413, { error: "请求过大" });
          chunks.push(chunk);
        }
        const body = Buffer.concat(chunks).toString("utf8");
        const value = body ? JSON.parse(body) : undefined;
        return json(200, await bridge[method](value));
      }
      if (req.method !== "GET") return json(405, { error: "不支持的方法" });
      const filename = path.resolve(
        publicDir,
        `.${decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname)}`,
      );
      if (!filename.startsWith(publicDir + path.sep)) return json(403, { error: "无效路径" });
      if (!fs.existsSync(filename) || !fs.statSync(filename).isFile())
        return json(404, { error: "资源不存在，请先 npm run build" });
      const type =
        {
          ".html": "text/html; charset=utf-8",
          ".js": "text/javascript",
          ".css": "text/css",
          ".svg": "image/svg+xml",
          ".png": "image/png",
        }[path.extname(filename)] || "application/octet-stream";
      res.writeHead(200, {
        ...headers,
        "Content-Type": type,
        ...(path.extname(filename) === ".html"
          ? { "Set-Cookie": `leximeet_preview=${session}; HttpOnly; SameSite=Strict; Path=/` }
          : {}),
      });
      fs.createReadStream(filename).pipe(res);
    } catch (error) {
      json(400, { error: error.message });
    }
  });
  server.once("error", () => core.stop());
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  const stop = async () => {
    server.close();
    server.closeAllConnections();
    pronunciation.close();
    await textDictionary.close();
    await core.stop();
  };
  for (const signal of ["SIGTERM", "SIGINT"])
    process.once(signal, () => {
      stop().finally(() => process.exit(0));
    });
  console.log(JSON.stringify({ url: origin, profile: profile.name, dataDir: profile.root }));
  return { server, core, profile, origin, stop };
}
if (require.main === module)
  preview().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
module.exports = { preview };
