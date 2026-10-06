import AppKit
import Foundation
import Darwin

// 只读前台应用 PID，不读取窗口内容，不发送键鼠、不激活应用，不使用辅助功能权限。
let workspace = NSWorkspace.shared
func emit(_ values: [String: Any]) {
    var data = values
    data["at"] = Date().timeIntervalSince1970 * 1000
    guard let json = try? JSONSerialization.data(withJSONObject: data),
          let line = String(data: json, encoding: .utf8) else { exit(2) }
    print(line)
    fflush(stdout)
}
func sample(_ type: String, _ app: NSRunningApplication?) {
    guard let app = app else { return }
    emit(["type": type, "pid": Int(app.processIdentifier),
          "group": Int(getpgid(app.processIdentifier))])
}
let observer = workspace.notificationCenter.addObserver(
    forName: NSWorkspace.didActivateApplicationNotification,
    object: nil, queue: .main
) { notification in
    sample("activation", notification.userInfo?[NSWorkspace.applicationUserInfoKey]
        as? NSRunningApplication)
}
let frontmost = workspace.frontmostApplication
emit(["type": "ready", "pid": Int(getpid()), "observable": frontmost != nil])
sample("sample", frontmost)
// 事件通知之外再取样；只在前台 PID 改变时发出，不积累操作者的应用名称或正文。
var lastPid: pid_t = frontmost?.processIdentifier ?? 0
let timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { _ in
    let current = workspace.frontmostApplication
    let pid = current?.processIdentifier ?? 0
    if pid != lastPid { sample("sample", current); lastPid = pid }
}
DispatchQueue.global(qos: .utility).async {
    while let line = readLine() {
        if line == "stop" { break }
    }
    DispatchQueue.main.async {
        sample("sample", workspace.frontmostApplication)
        workspace.notificationCenter.removeObserver(observer)
        timer.invalidate()
        emit(["type": "finished"])
        exit(0)
    }
}
RunLoop.main.run()
