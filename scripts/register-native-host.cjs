"use strict";
// 首次发布前不继续旧协议入口。所有参数和隔离校验由新 CLI 处理。
const { main } = require("./lmcp/register-host.cjs");
if (require.main === module) {
  Promise.resolve()
    .then(() => main(process.argv.slice(2)))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
