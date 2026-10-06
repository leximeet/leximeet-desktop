"use strict";

/**
 * 验收读取逐例结果，而非只相信进程退出码或汇总数字。
 * 这是纯校验器：不修报告、不补结果，也不依赖浏览器或运行目录。
 */
function validatePlaywrightReport(report, { label, project, requiredTitles = [] }) {
  const reject = (reason) => {
    throw new Error(`${label} 验收失败：${reason}`);
  };
  if (!Array.isArray(report?.suites) || !report.stats) reject("缺少有效报告");
  if (!Array.isArray(report.errors) || report.errors.length) reject("存在运行器错误或错误字段缺失");
  const specs = [];
  function visit(suites) {
    for (const suite of suites) {
      specs.push(...(suite.specs || []));
      visit(suite.suites || []);
    }
  }
  visit(report.suites);
  if (!specs.length) reject("套件为空");
  let passed = 0;
  for (const spec of specs) {
    if (!spec.tests?.length) reject(`用例没有执行结果：${spec.title}`);
    for (const test of spec.tests) {
      if (test.projectName !== project) reject(`出现非目标项目：${spec.title}`);
      // test.fail() 的符合预期失败、skip/fixme、重试通过都不是一次验收成功。
      if (
        test.expectedStatus !== "passed" ||
        test.status !== "expected" ||
        test.results?.length !== 1 ||
        test.results[0].status !== "passed" ||
        test.results[0].retry !== 0
      )
        reject(`用例必须首次实际通过：${spec.title}`);
      passed++;
    }
  }
  if (
    report.stats.expected !== passed ||
    ["unexpected", "skipped", "flaky"].some((key) => report.stats[key] !== 0)
  )
    reject("汇总与逐例结果不符，或含失败、跳过、重试");
  if (new Set(requiredTitles).size !== requiredTitles.length) reject("必需用例清单重复");
  for (const title of requiredTitles) {
    if (specs.filter((spec) => spec.title === title).length !== 1)
      reject(`必需用例缺失或重名：${title}`);
  }
  return { passed, required: requiredTitles.length, skipped: 0, flaky: 0 };
}

module.exports = { validatePlaywrightReport };
