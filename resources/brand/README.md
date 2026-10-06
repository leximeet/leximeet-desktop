# 品牌图标

应用与通知使用词遇正式品牌的透明符号，不添加底板。安装图标和前端横向 Logo 分别维护，界面仍根据明暗主题选择对应的 Logo。

| 文件              | 用途                                     |
| ----------------- | ---------------------------------------- |
| symbol-source.png | 1254×1254 透明正式符号，导出母版         |
| icon.png          | 512×512，窗口、Dock、托盘及系统通知      |
| icon-512x512.png  | 同版 512×512，Linux 安装图标             |
| LexiMeet.icns     | macOS 应用包，16–1024px                  |
| LexiMeet.ico      | Windows 应用包，16/24/32/48/64/128/256px |

在 macOS 上重新导出：`node scripts/export-brand-icons.cjs`。脚本只缩小母版并封装 ICNS/ICO，其他平台直接使用已提交的文件。`transparent-icons.test.cjs` 检查 PNG 与 ICO 各层的透明像素和尺寸。

macOS 通知的外壳、图标蒙版与应用身份由系统决定；透明资源不保证系统移除自己的底板。开发运行时还可能显示 Electron 身份，正式应用以安装包为准。
