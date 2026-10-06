const { contextBridge, ipcRenderer } = require("electron");

// 沙箱 preload 不导入 Node 文件；每个能力都是固定 channel，没有通用 IPC 入口。
const names = [
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
  "openExternal",
  "diagnostics",
  "desktopAction",
  "connectionSettings",
];
const api = Object.fromEntries(
  names.map((name) => [
    name,
    async (value) => {
      const result = await ipcRenderer.invoke(`leximeet:${name}`, value);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    },
  ]),
);
// 导航是固定业务事件；不能订阅任意 channel 或传入路径。
api.onNavigate = (listener) => {
  if (typeof listener !== "function") throw new Error("需要导航回调");
  const receive = async (_event, value) => {
    if (
      !["library", "plan", "settings"].includes(value?.page) ||
      !/^[0-9a-f-]{36}$/.test(value?.requestId || "")
    )
      return;
    let opened = false;
    try {
      opened =
        (await listener({
          page: value.page,
          ...(typeof value.wordId === "string" &&
          value.wordId.length <= 120 &&
          typeof value.searchTerm === "string" &&
          value.searchTerm.length <= 200
            ? {
                wordId: value.wordId,
                searchTerm: value.searchTerm,
                scope: value.scope === "dictionary" ? "dictionary" : "library",
              }
            : {}),
        })) === true;
    } catch {
      // 页面尚未就绪或拒绝导航，向 Main 返回未接受，不能伪造打开成功。
    } finally {
      // 回调返回明确的路由接受结果。不给网页暴露通用 IPC 或确认函数。
      ipcRenderer.send("leximeet:navigation-ack", {
        requestId: value.requestId,
        opened,
      });
    }
  };
  ipcRenderer.on("leximeet:navigate", receive);
  return () => ipcRenderer.removeListener("leximeet:navigate", receive);
};
api.onDataChanged = (listener) => {
  if (typeof listener !== "function") throw new Error("需要刷新回调");
  const receive = () => listener();
  ipcRenderer.on("leximeet:data-changed", receive);
  return () => ipcRenderer.removeListener("leximeet:data-changed", receive);
};
api.onClipboardPreview = (listener) => {
  if (typeof listener !== "function") throw new Error("需要剪贴板预览回调");
  const receive = (_event, value) => {
    if (["shortcut", "cleared"].includes(value?.source)) listener({ source: value.source });
    else if (
      value?.source === "clipboard" &&
      typeof value.text === "string" &&
      value.text.length <= 100
    )
      listener({ source: "clipboard", text: value.text });
  };
  ipcRenderer.on("leximeet:clipboard-preview", receive);
  return () => ipcRenderer.removeListener("leximeet:clipboard-preview", receive);
};
contextBridge.exposeInMainWorld("leximeet", Object.freeze(api));
