// Renderer 只有业务方法，没有文件系统、IPC 通道名或任意端口访问权限。
const METHODS = new Set([
  "captureAction",
  "desktopState",
  "desktopQuery",
  "desktopCommand",
  "dictionaryAction",
  "pronounce",
  "audioSettings",
  "snapshot",
  "settings",
  "cardLayout",
  "exportData",
  "importData",
  "runtime",
  "diagnostics",
  "desktopAction",
  "connectionSettings",
  "openExternal",
]);

export async function invoke(method, payload) {
  if (!METHODS.has(method)) throw new Error("不支持的操作");
  // 业务接口只接受 JSON 数据；先去掉 Vue Proxy，保证原生 IPC 与浏览器预览使用相同数据。
  const data = payload === undefined ? undefined : JSON.parse(JSON.stringify(payload));
  if (window.leximeet?.[method]) return window.leximeet[method](data);
  // 浏览器验收适配器由开发脚本提供，写入的是独立 Java 数据目录，绝不回退到 localStorage。
  const response = await fetch(`/__bridge/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data ?? null),
    signal: AbortSignal.timeout(method === "importData" || method === "exportData" ? 90000 : 30000),
  });
  const type = response.headers.get("content-type") || "";
  if (!type.includes("application/json"))
    throw new Error("尚未连接词遇本地核心。请使用项目的桌面启动或浏览器验收命令。");
  const result = await response.json();
  if (!response.ok || result?.error)
    throw new Error(
      typeof result.error === "string"
        ? result.error
        : result.error?.message || "本地核心暂时不可用",
    );
  return result;
}

export const api = Object.fromEntries(
  [...METHODS].map((method) => [method, (payload) => invoke(method, payload)]),
);
