/**
 * ee-core 5.0.1 的构造器在 init 前写入 EE_*，默认从 public/electron 加载，
 * 并在用户 home 创建 .App/data。这里集中处理这处版本适配：原样分发可读 CJS，
 * 框架数据目录也进入选定 profile；不修改系统 HOME、依赖源码或 Electron home。
 */
function scopedEggClass(ElectronEgg, { electronDir, profile }) {
  return class LexiMeetEgg extends ElectronEgg {
    init() {
      process.env.EE_ELECTRON_DIR = electronDir;
      process.env.EE_USER_HOME = profile.root;
      process.env.LEXIMEET_LOG_DIR = require("node:path").join(profile.root, "logs");
      super.init();
    }
  };
}
module.exports = { scopedEggClass };
