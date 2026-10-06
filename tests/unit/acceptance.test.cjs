"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { validatePlaywrightReport } = require("../../scripts/lib/acceptance.cjs");

const options = { label: "验收自测", project: "lmcp", requiredTitles: ["配对采集"] };
function report() {
  return {
    errors: [],
    stats: { expected: 1, unexpected: 0, skipped: 0, flaky: 0 },
    suites: [
      {
        suites: [
          {
            specs: [
              {
                title: "配对采集",
                tests: [
                  {
                    projectName: "lmcp",
                    expectedStatus: "passed",
                    status: "expected",
                    results: [{ status: "passed", retry: 0 }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}
const caseResult = (value) => value.suites[0].suites[0].specs[0].tests[0];

test("验收递归读取用例并区分通过数与必需场景数", () => {
  const value = report();
  value.suites.push({
    specs: [{ ...structuredClone(value.suites[0].suites[0].specs[0]), title: "撤销" }],
  });
  value.stats.expected++;
  assert.deepEqual(validatePlaywrightReport(value, options), {
    passed: 2,
    required: 1,
    skipped: 0,
    flaky: 0,
  });
});
test("退出成功或汇总为绿不能掩盖缺失和空报告", () => {
  for (const value of [null, {}, { ...report(), suites: [] }])
    assert.throws(() => validatePlaywrightReport(value, options), /验收失败/);
});
test("运行器全局错误也必须失败", () => {
  const value = report();
  value.errors.push({ message: "fixture 清理失败" });
  assert.throws(() => validatePlaywrightReport(value, options), /运行器错误/);
});
test("其他用例通过不能替代必需场景，重名也不能冒充覆盖", () => {
  const missing = report();
  missing.suites[0].suites[0].specs[0].title = "普通截图";
  assert.throws(() => validatePlaywrightReport(missing, options), /必需用例缺失/);
  const duplicate = report();
  duplicate.suites.push(structuredClone(duplicate.suites[0]));
  duplicate.stats.expected++;
  assert.throws(() => validatePlaywrightReport(duplicate, options), /重名/);
});
test("跳过、预期失败和没有运行结果均不能通过", () => {
  for (const mutate of [
    (t) => {
      t.expectedStatus = "failed";
      t.results[0].status = "failed";
    },
    (t) => {
      t.results[0].status = "skipped";
    },
    (t) => {
      t.results = [];
    },
  ]) {
    const value = report();
    mutate(caseResult(value));
    assert.throws(() => validatePlaywrightReport(value, options), /首次实际通过/);
  }
});
test("重试后成功以及仅保留最后一次成功均被拒绝", () => {
  for (const mutate of [
    (t) => {
      t.results.unshift({ status: "failed", retry: 0 });
      t.results[1].retry = 1;
    },
    (t) => {
      t.results[0].retry = 1;
    },
    (t) => {
      t.status = "flaky";
    },
  ]) {
    const value = report();
    mutate(caseResult(value));
    assert.throws(() => validatePlaywrightReport(value, options), /首次实际通过/);
  }
});
test("错项目与不一致的汇总不能成为验收证据", () => {
  const wrong = report();
  caseResult(wrong).projectName = "ui";
  assert.throws(() => validatePlaywrightReport(wrong, options), /非目标项目/);
  for (const stats of [{ expected: 2 }, { skipped: 1 }, { flaky: 1 }, { unexpected: 1 }])
    assert.throws(
      () =>
        validatePlaywrightReport({ ...report(), stats: { ...report().stats, ...stats } }, options),
      /汇总/,
    );
});
test("必需清单重复项明确失败，防止虚增覆盖数量", () => {
  assert.throws(
    () =>
      validatePlaywrightReport(report(), { ...options, requiredTitles: ["配对采集", "配对采集"] }),
    /清单重复/,
  );
});
