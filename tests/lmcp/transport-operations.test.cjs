"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { HostOperations } = require("../../electron/services/lmcp/host-operations.cjs");
const {
  validateHostParams,
  validateHostResponse,
} = require("../../electron/services/lmcp/host-validation.cjs");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lmcp-host-operations-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "operations.json");
  const operations = new HostOperations(file);
  const owner = {
    pairingId: randomUUID(),
    desktopInstanceId: randomUUID(),
    clientInstanceId: randomUUID(),
    workspaceId: randomUUID(),
    generation: randomUUID(),
    authorizationEpoch: "1",
  };
  return { file, operations, grant: { grantId: randomUUID(), owner } };
}

test("Desktop 重启保留未知反向调用，日志不存 URL、选区或 grant token", (t) => {
  const { file, operations, grant } = fixture(t);
  const invocationId = randomUUID();
  operations.begin(grant, invocationId, "browser.openSource", {
    url: "https://example.org/private-reading",
  });
  const restored = new HostOperations(file);
  restored.load();
  assert.equal(restored.list()[0].status, "unknown");
  assert.equal(restored.list()[0].invocationId, invocationId);
  assert(!fs.readFileSync(file, "utf8").includes("private-reading"));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("新 grant 可同归属查旧回执，换workspace/epoch/client禁止，跨grant不重执行", (t) => {
  const { operations, grant } = fixture(t);
  const invocationId = randomUUID();
  operations.begin(grant, invocationId, "browser.getContext", {});
  const renewed = { ...grant, grantId: randomUUID() };
  assert.equal(operations.recover(renewed, grant.grantId, invocationId).status, "pending");
  for (const key of [
    "pairingId",
    "desktopInstanceId",
    "clientInstanceId",
    "workspaceId",
    "generation",
    "authorizationEpoch",
  ])
    assert.throws(
      () =>
        operations.recover(
          { ...renewed, owner: { ...grant.owner, [key]: "different" } },
          grant.grantId,
          invocationId,
        ),
      /FORBIDDEN/,
    );
  assert.throws(
    () => operations.begin(renewed, invocationId, "browser.getContext", {}),
    /OPERATION_RECOVERY_REQUIRED/,
  );
});

test("同grant同载荷重试幂等，换载荷拒绝，完成后保留摘要", (t) => {
  const { operations, grant } = fixture(t);
  const invocationId = randomUUID();
  const original = operations.begin(grant, invocationId, "browser.openSource", {
    url: "https://example.org",
  });
  assert.equal(
    operations.begin(grant, invocationId, "browser.openSource", { url: "https://example.org" }),
    original,
  );
  assert.throws(
    () =>
      operations.begin(grant, invocationId, "browser.openSource", { url: "https://example.com" }),
    /IDEMPOTENCY_KEY_REUSED/,
  );
  operations.finish(original, "applied", { status: "opened", actionId: null });
  assert.match(operations.list()[0].resultDigest, /^[a-f0-9]{64}$/);
});

test("宿主方法不接受任意JS/CSS/tabId，选区响应不能越界或换文档", () => {
  const page = {
    pageHandle: randomUUID(),
    documentRevision: randomUUID(),
    url: "https://example.org",
    title: "阅读",
  };
  assert.equal(validateHostParams("browser.getContext", { tabId: 1 }), false);
  assert.equal(
    validateHostParams("browser.highlight", {
      pageHandle: page.pageHandle,
      documentRevision: page.documentRevision,
      exact: "word",
      prefix: "",
      suffix: "",
      css: ".x",
    }),
    false,
  );
  assert.equal(
    validateHostParams("browser.openSource", { url: "https://user:password@example.org" }),
    false,
  );
  const response = {
    method: "browser.readSelection",
    ok: true,
    result: { page, text: "word", ranges: [{ start: 0, end: 4 }] },
  };
  assert.equal(validateHostResponse(response, page), true);
  assert.equal(
    validateHostResponse(
      { ...response, result: { ...response.result, ranges: [{ start: 0, end: 5 }] } },
      page,
    ),
    false,
  );
  assert.equal(validateHostResponse(response, { ...page, documentRevision: randomUUID() }), false);
});

test("恢复回执保留原方法成功/失败形态，不接受口头宣称 applied", () => {
  const params = { sourceGrantId: randomUUID(), invocationId: randomUUID() };
  const result = {
    ...params,
    status: "applied",
    resultDigest: "a".repeat(64),
    contentStatus: "available",
    receipt: {
      method: "browser.openSource",
      ok: true,
      result: { status: "opened", actionId: null },
    },
  };
  assert.equal(
    validateHostResponse({ method: "browser.getOperation", ok: true, result }, params),
    true,
  );
  assert.equal(
    validateHostResponse(
      { method: "browser.getOperation", ok: true, result: { ...result, receipt: null } },
      params,
    ),
    false,
  );
  assert.equal(
    validateHostResponse(
      {
        method: "browser.getOperation",
        ok: true,
        result: { ...result, sourceGrantId: randomUUID() },
      },
      params,
    ),
    false,
  );
});

test("权限收窄可恢复终态与摘要，正文不可读；pending不接受伪终态摘要", (t) => {
  const params = { sourceGrantId: randomUUID(), invocationId: randomUUID() };
  const result = {
    ...params,
    status: "applied",
    resultDigest: "a".repeat(64),
    contentStatus: "not-authorized",
    receipt: null,
  };
  assert.equal(
    validateHostResponse({ method: "browser.getOperation", ok: true, result }, params),
    true,
  );
  assert.equal(
    validateHostResponse(
      {
        method: "browser.getOperation",
        ok: true,
        result: { ...result, contentStatus: "available" },
      },
      params,
    ),
    false,
  );
  assert.equal(
    validateHostResponse(
      { method: "browser.getOperation", ok: true, result: { ...result, contentStatus: undefined } },
      params,
    ),
    false,
  );
  assert.equal(
    validateHostResponse(
      {
        method: "browser.getOperation",
        ok: true,
        result: { ...result, status: "pending", contentStatus: "not-applicable" },
      },
      params,
    ),
    false,
  );
  const { operations, grant } = fixture(t);
  const original = operations.begin(grant, params.invocationId, "browser.openSource", {
    url: "https://example.org",
  });
  operations.recovered(original, result.status, result.resultDigest);
  assert.equal(operations.list()[0].status, "applied");
  assert.equal(operations.list()[0].resultDigest, result.resultDigest);
});
