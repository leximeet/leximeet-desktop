# 后台自动化测试

日常回归通过 Playwright 向测试页面发送输入，不使用系统键鼠自动操作。真实 Electron、preload / Main、Java Core 和 SQLite 保留；页面截图不需要把应用切到前台。

## 一键运行

在仓库目录执行：

```bash
bash scripts/test-background.sh
```

也可使用 `npm run test:background`。脚本复用现有 Node.js 24+ / JDK 21 / Maven 3.9 的隔离环境准备，并将测试进程优先级降低 10。Desktop 单元最多同时运行两个文件，Electron 串行运行；降低优先级不等于没有 CPU / 内存开销。

`bash scripts/test-desktop.sh --verify` 与 `npm run verify:desktop` 保留为兼容入口。直接使用 npm 时须先准备 JDK 21。`test:desktop` 单独运行当前 Electron 用例，`test:package:desktop` 验证本平台的实际应用包。

七天连续使用另有后台入口 `bash scripts/test-desktop.sh --journey`：首启、普通/教学练习回归、七天、明暗视觉分别报告；日期由 test profile 内的业务时钟文件推进，不改变系统时间。两份不同版本真实应用的升级专项使用 `--journey --upgrade 旧可执行文件 新可执行文件`。完整说明见[日常使用与升级测试](日常使用与升级测试.md)。

**可见人工验收是另一入口**：`bash scripts/test-desktop.sh` 或 `npm run accept:desktop` 会打开应用窗口，供用户亲自体验；旧 `test:lmcp:manual` 还会打开独立浏览器，不属于工作期间的后台回归。

## 隔离与保护

| 环节                         | 后台测试行为                                                                    | 保留的验证                                                   |
| ---------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 桌面窗口                     | 创建时隐藏、不可聚焦；阻止 show / showInactive / focus / restore 和重新启用聚焦 | 真实 renderer、输入、滚动、尺寸、布局、截图与 IPC            |
| 音频                         | Chromium 输出静音，不能通过取消静音逃逸；通知不启动 afplay                      | 获取、缓存、加载解码、结束回执、失败与取消链路；实际听感另验 |
| 系统剪贴板与全局快捷键       | 受控输入与注册替身，不占用操作者剪贴板或快捷键                                  | 识别、目标匹配、采集事务、逐词队列、倒计时与业务回调         |
| 系统通知                     | 受控投递；通知正文点击也遵守隐藏策略                                            | 真实 Main、固定题目、Core 判题、幂等、SQLite 与页面刷新      |
| Finder、系统设置与原生文件框 | 误调用明确失败，不能拉起宿主窗口或伪造成功                                      | 命名操作和参数约束；真实系统展示另验                         |
| 资料与下载                   | 每例独立目录和动态端口，下载绑定本例目录                                        | 持久化、重启、升级、随包 Java 与 Full 词典                   |
| 学习与采集时间               | 明确的 test profile 专属业务时钟文件；协议会话/超时仍为真实时间                 | 七天计划、休息、计分/FSRS、去重窗口与提醒调度                |

自动用例不能通过 `extraEnv` 覆盖测试 profile、资料目录或静默设置。Playwright 配置拒绝 `--headed`、`--debug`、`--ui` 以及启用 `PWDEBUG`，避免自动打开可见浏览器或 Inspector。

## macOS 的系统焦点检查

窗口是否聚焦与系统前台应用是否切换分别检查：

1. Main 在框架创建窗口前安装保护，累计首窗及后来采集窗口的真实 show / focus 违规，不在启动后清零。
2. 启动 Electron **之前**运行只读的 AppKit 监测工具，通过前台应用激活事件及 100ms 变化取样观察 PID。
3. `launch()` 返回后登记本轮 Electron PID / 独立进程组，启动期间已记录的激活也参与检查；正常切换到其他工作应用不算失败。
4. 应用退出并完成本轮进程清理后停止监测。监测自身不能变成前台应用，中途退出或证据不完整使验收失败。

macOS 需要 Xcode Command Line Tools 的 `xcrun swiftc` 编译只读工具；编译缓存和 Swift 模块缓存均在 `.runtime/test-tools`。无需辅助功能、录屏授权，也不读取窗口标题、文档正文或应用名称。缺少编译工具或前台环境不可观测时，测试在启动 Electron 前报错；不会静默跳过焦点门禁，也不会自动打开系统安装或授权窗口。

依据：[Apple 前台应用属性](https://developer.apple.com/documentation/appkit/nsworkspace/frontmostapplication)、[应用激活通知](https://developer.apple.com/documentation/appkit/nsworkspace/didactivateapplicationnotification)、[Electron 激活策略](https://www.electronjs.org/docs/latest/api/app#appsetactivationpolicypolicy-macos)。

Windows / Linux 仍使用隐藏窗口、静音、受控输入和资源隔离，但本轮没有实现这些平台的系统前台应用监测；报告明确标记 `supported: false`，不冒称完成 macOS 同等验收。

## 查看报告与验收边界

当前桌面报告：`playwright-report/desktop-001`；实际应用包报告：`playwright-report/desktop-001-package`。每个启动会话附加：

- `*-window-guard.json`：首窗起的窗口违规、被阻止的激活 / 宿主操作和静音策略。
- `*-os-focus.json`：观测起止时间、完整性、本轮 PID 和系统激活违规；不输出操作者其他应用的 PID 明细。
- 页面截图、trace、隔离日志和真实运行时信息。

测试通过表示，本次运行未观测到测试进程抢焦点，窗口保护、业务断言和进程清理也已通过；这不保证在所有系统版本上永远不会抢焦点。系统可见通知、权限选择、实际的全局快捷键、真人操作输入法时的候选窗，以及扬声器听感，仍需明确安排人工验收；如需自动操作这些宿主能力，应使用独立 macOS 测试机器或虚拟机。

`test:ui` 为真实 `test:desktop` 的别名；旧页面的 Renderer 替身、旧模型原生用例及其像素基线已退休。`npm run test:visual` 运行当前 `practice-usage-capture.spec.cjs`，实际操作 Electron → Main → Core → SQLite，并输出明亮、黑暗和窄窗截图及布局断言。它是人工视觉审查的截图来源，不是像素差异门禁；不存在自动更新旧基线的入口。后台运行不会减少当前业务、教学、明暗布局及随包 Java 的验收要求。

[操作演示](操作演示.md)的笔记与多词本截图可独立复现：准备当前前端与 Core 后，运行 `npx playwright test --config playwright.desktop.config.cjs tests/desktop001/docs-note-capture.spec.cjs`。默认输出到 `test-results/docs-demo`，也可通过 `LEXIMEET_DOCS_CAPTURE` 指定本轮截图目录。用例通过真实界面创建词本、手动记录与编辑，保存后核对 Core 的笔记和关系；沿用隐藏窗口、静音与焦点门禁，不操作日常剪贴板。网页、插件确认窗口和连接成功状态应从真实双端用例截取，不能在独立桌面用例中伪造连接状态。

## 持续集成门禁

| 工作流             | 范围                                                                                            |
| ------------------ | ----------------------------------------------------------------------------------------------- |
| ci.yml             | macOS arm64：格式/文档/契约、单元、Core、真实 HTTP/Host、隐藏原生 UI、七天链路、真实包          |
| lmcp-workspace.yml | 固定 Browser 引用和 Core gitlink；生产扩展通过真实 Native Host 连接源码与打包 Desktop           |
| visual.yml         | 手动运行当前真实原生使用链路及明暗/窄窗截图，供人工审查；不宣称像素比较通过                     |
| candidate.yml      | 人工候选或正式标签：完整门禁、构建/安装验证、对应源码；标签通过后公开 Release；可信旧包另验升级 |

`ci.yml` 整体作业预算为 60 分钟，给全新 runner 的依赖准备、完整 UI、七天链路和随包验证留出时间。业务请求的 15 秒预算、单例断言和零重试策略保持不变；作业预算不代表实测耗时或远端检查已经通过。

Core 子模块单元测试在临时空仓中让 Git 解析相对来源，覆盖 GitHub / Gitee 的 HTTPS 与 SSH 地址；随后从本地 Core 检出固定 gitlink 并核对源码。解析检查不访问网络，也不改开发者的远端或全局配置；远端是否能取得该提交仍由实际递归检出验证。

Actions 固定到完整 SHA，检查和构建任务使用只读凭据，只有正式标签的最终发布任务取得 Release 写权限；证据包含生产物料指纹。`macos-15` 当前为 arm64，平台规格以[GitHub 官方文档](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)为准。配置校验通过不代表远程执行通过；获得推送授权后，还需实际运行远程 Actions。

## 当前版本的验收记录

旧页面、实验模型和标签功能退休后，测试总数会随有效用例变化。结果以最终候选的报告为准，不累加历史套件的数量；当前前端、Main、Core 和 Browser 的运行物料必须对应同轮来源。

| 层次               | 必须证明的事情                                              | 报告                                                        |
| ------------------ | ----------------------------------------------------------- | ----------------------------------------------------------- |
| Desktop 单元       | 当前入口闭包、命名合同、异步草稿、练习确认、隐私、物料负例  | `npm run test:unit`                                         |
| Core               | 当前 SQLite 结构、真实事务、积分/FSRS、备份、身份与拒旧入口 | `core-java/target/surefire-reports`                         |
| HTTP / Native Host | 真实子进程、鉴权、传输、失败清理                            | `test:integration` / `test:lmcp:transport`                  |
| 完整原生 UI        | 新装、教学、六方式、重启、词库、Full 切换与明暗窄窗         | `test-results/desktop-001`                                  |
| 七天使用           | 业务时钟、学三休一再学三、模式切换、笔记、提醒与恢复        | `test-results/daily-journey`                                |
| 源码双端           | 生产扩展、实际侧栏/浮球、连接归属、采集去重与回执           | `test-results/connected-real-browser`                       |
| 安装后的应用       | 安装器实际展开、随包 Java、离线词典、规划、练习和恢复       | `test-results/install` 与 `desktop-001/package-report.json` |
| 随包双端           | 同一候选的 JRE / 外置 Host，无可用宿主 Java 仍可连接采集    | `test-results/connected-package`                            |

此前本地收尾复验于 2026-10-04 至 2026-10-05 完成，以下是历史基线，使用的是收敛 note-only 之前的协议和资料结构。发行源码为 Desktop `e9e38369` / Core `8603bf2c`；源码连接使用 Browser `2a22e574`，随包连接还使用 Desktop `6c4c256` 的测试断言修正。后两次修正只处理教学前置竞态及现行索引 v3，不改变已验收运行物料。

| 历史基线实际运行       |   通过数 | 范围                                 |
| ---------------------- | -------: | ------------------------------------ |
| Desktop 单元           |      321 | 当前入口、合同、练习、隐私与打包负例 |
| Core                   |      167 | 37 套件，真实 SQLite 与拒旧/备份     |
| HTTP / Native Host     |   9 / 47 | 实际 Core 子进程和本机传输           |
| 原生 Electron UI       |       55 | 当前正式页面及持久化                 |
| 七天源码使用           |        7 | 学三休一再学三、教学与恢复           |
| Browser 单元 / 独立 UI | 407 / 70 | 同一原样生产扩展                     |
| 源码双端               |        9 | 当前 Main、Core 与 Native Host       |
| DMG 隔离安装           |        1 | 实际安装后应用，含离线词典和重启     |
| 实际应用包双端         |        9 | 随包 Java/Host、采集归属及退出清理   |

以上完整运行均零失败、零跳过、零重试；修复前失败报告保留供排障，不加入成功计数。源码双端报告记录测试及 1,123 个扩展文件前后字节一致。Browser 原样 ZIP、源码组合和升级边界见其[验收基线](https://github.com/leximeet/leximeet-browser/blob/main/docs/验收基线.md)。

本轮 macOS arm64 安装候选为 1.0.0，DMG 581,939,079 字节、ZIP 580,423,031 字节；实际 Jar 与规范摘要均经物料门禁核对。各次构建的准确摘要以该轮 `BUILD-MANIFEST.json` / `SHA256SUMS` 为准。完整对应源码另附独立摘要，不自动发布。

## 当前正式规范的本机复验

当前 Desktop/Core 消费 LMCP `1.0.0` 的正式 note-only 规范，来源记录见随仓的 `resources/lmcp/source.json`，摘要 `61a44cc2f7f73fef81b007c844e1f2fa4deb955bf21a69236ee7b4f713808c49`。Core 固定于本仓 `core-java` gitlink 的正式提交。构建门禁逐字节验证 17 项规范，业务测试同时拒绝旧字段，包括空值。

2026-10-05 本机复验已通过 Core 174 项/40 套、真实 Core 管理器 9 项、参考 Native Host 传输 47 项、原生 Electron UI 56 项、七天使用 7 项，均零失败、零跳过、零自动重试。Desktop 单元与物料边界检查共 326 项。生产依赖审计为零已知漏洞；完整构建依赖的一项已知问题及约束见[安全与许可](安全与许可.md)。最终应用包的来源、字节数、SHA-256、实际安装和隔离回收结果由 `release:local` 生成的 `BUILD-MANIFEST.json` 与报告记录，不能把上方旧包的字节数视为本次产物。

Browser 已纳入首次正式发布准备。参考 Native Host 传输与本机 UI 验证只证明 Desktop 的对应能力；每次冻结新的公开源码组合后，必须分别重跑真实生产扩展的源码与随包双端验收，保存实际源码 SHA、规范摘要、扩展文件指纹和结果。发布附件以对应轮次的清单为准，不把此前通过记录改名为新提交的证据。远端 Actions、Developer ID、公证、其他平台与系统可见通知仍需分别验收。

正确选择专项会逐帧观察 DOM 和数据库：从反馈到换题至少一秒，期间保持题卡内容和位置，每词只写入一条事实。故障专项暂停测试自身的 Core，重启后按原提交身份恢复，不能以新 ID 重复计分。日常用例暂停首次列表、临摹、听音或选义草稿 IPC，核对等待期间操作禁用、真实保存后自动恢复及教学首击继续；不增加固定等待、不跳过，也不自动重试。

当前应用初发没有可信的已发布前一版本；不承诺未发布 0.x/rc 或开发候选结构的迁移。正式后的升级测试必须使用两份真实不同且兼容的安装候选。清理前的同号 schema 100 报告只是历史证据，不能替代现行结构验收。[日常与升级](日常使用与升级测试.md)说明正确运行方式。

本地安装候选使用独立目录与 `BUILD-MANIFEST.json`。构建成功仅证明物料完整，`applicationStartup` 由实际安装验收记录；源码与应用包连接分别报告。[本地打包与安装](本地打包与安装.md)提供一条命令及失败处理。

人工系统可见通知、权限、快捷键、声音、Developer ID 签名/公证、远程 Actions 和其他 OS 仍有独立门禁。浏览器独立模式报告见 Browser 仓库 `docs/测试与验收.md`。

随包双端的个人资料断言只读真实扩展创建的 IndexedDB，不指定旧版本，也不代建或升级缺失的库。扩展与桌面数据库分别初始化，不能把两端资料格式号混用；封存/恢复仍通过真实 UI、SQLite 和同一份 A 的前后内容核对。
