"use strict";
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");

/**
 * 只在本例 descriptor 前放一个 loopback 故障代理。
 * 请求/鉴权/业务响应均来自真实 Native、Main、Core；只丢弃一次已完成 CaptureBatch 的回包。
 * 不记录或输出传输密钥，不提供假回执。finally 恢复 descriptor 并关闭全部本例连接。
 */
async function dropCaptureAck(profileDir) {
  const descriptor = path.join(profileDir, "native-messaging/gateway.properties");
  const original = fs.readFileSync(descriptor, "utf8");
  const port = Number(/^port=(\d+)$/m.exec(original)?.[1]);
  if (!port) throw new Error("本例网关未就绪");
  let dropped = false;
  const requests = new Set();
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const method = JSON.parse(body).method;
    const upstream = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/rpc",
        method: "POST",
        headers: { ...req.headers, host: `127.0.0.1:${port}` },
      },
      (response) => {
        if (!dropped && method === "CaptureBatch") {
          response.resume();
          response.on("end", () => {
            dropped = true;
            res.destroy();
          });
        } else {
          res.writeHead(response.statusCode, response.headers);
          response.pipe(res);
        }
      },
    );
    requests.add(upstream);
    upstream.once("close", () => requests.delete(upstream));
    upstream.once("error", () => res.destroy());
    upstream.end(body);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  fs.writeFileSync(descriptor, original.replace(/^port=\d+$/m, `port=${server.address().port}`), {
    mode: 0o600,
  });
  return {
    get dropped() {
      return dropped;
    },
    async close() {
      fs.writeFileSync(descriptor, original, { mode: 0o600 });
      requests.forEach((request) => request.destroy());
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      });
    },
  };
}
module.exports = { dropCaptureAck };
