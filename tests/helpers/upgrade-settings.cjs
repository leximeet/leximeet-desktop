// 当前正式资料格式内升级必须完整保留偏好；不兼容未发布的 0.x 缺省字段。
function expectPreservedSettings(expect, before, after) {
  expect(before, "升级前必须取得真实完整设置").toBeTruthy();
  expect(after, "同一资料格式升级原样保留设置").toEqual(before);
}
module.exports = { expectPreservedSettings };
