const { contextBridge, ipcRenderer } = require("electron");
// 弹出窗口没有通用业务 / IPC 入口，只有经 Main 校验的命名采集动作。
contextBridge.exposeInMainWorld(
  "leximeetCapture",
  Object.freeze({
    action: async (value) => {
      const result = await ipcRenderer.invoke("leximeet:captureAction", value);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    },
    onChanged: (listener) => {
      const receive = () => listener();
      ipcRenderer.on("leximeet:capture-state", receive);
      return () => ipcRenderer.removeListener("leximeet:capture-state", receive);
    },
  }),
);
