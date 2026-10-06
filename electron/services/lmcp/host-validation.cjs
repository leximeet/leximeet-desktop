"use strict";
const uuid = (value) =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const object = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value, maximum, minimum = 0) =>
  typeof value === "string" && value.length >= minimum && value.length <= maximum;
const keys = (value, allowed) =>
  object(value) &&
  Object.keys(value).every((key) => allowed.includes(key)) &&
  allowed.every((key) => Object.hasOwn(value, key));
const page = (value) =>
  object(value) &&
  uuid(value.pageHandle) &&
  uuid(value.documentRevision) &&
  text(value.url, 2000, 1) &&
  text(value.title, 300);
const error = (value) =>
  object(value) &&
  /^[A-Z][A-Z0-9_]{0,79}$/.test(value.code || "") &&
  text(value.message, 300, 1) &&
  typeof value.retryable === "boolean";

// 七个封闭宿主方法的传输边界；Core 业务 Schema 独立，不提供任意 JS/CSS/tabId 调用。
function validateHostParams(method, params) {
  if (!object(params)) return false;
  switch (method) {
    case "browser.getContext":
      return keys(params, []);
    case "browser.readSelection":
      return (
        keys(params, ["pageHandle", "documentRevision"]) &&
        uuid(params.pageHandle) &&
        uuid(params.documentRevision)
      );
    case "browser.highlight":
      return (
        keys(params, ["pageHandle", "documentRevision", "exact", "prefix", "suffix"]) &&
        uuid(params.pageHandle) &&
        uuid(params.documentRevision) &&
        text(params.exact, 120, 1) &&
        text(params.prefix, 120) &&
        text(params.suffix, 120)
      );
    case "browser.openSource": {
      if (!keys(params, ["url"]) || !text(params.url, 2000, 1)) return false;
      try {
        const url = new URL(params.url);
        return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
      } catch {
        return false;
      }
    }
    case "browser.requestSidePanel":
      return keys(params, ["pageHandle"]) && uuid(params.pageHandle);
    case "browser.getOperation":
      return (
        keys(params, ["sourceGrantId", "invocationId"]) &&
        uuid(params.sourceGrantId) &&
        uuid(params.invocationId)
      );
    case "browser.cancelOperation":
      return keys(params, ["invocationId"]) && uuid(params.invocationId);
    default:
      return false;
  }
}

function validateHostResult(method, result, params) {
  if (!object(result)) return false;
  switch (method) {
    case "browser.getContext":
      return result.page === null || page(result.page);
    case "browser.readSelection":
      return (
        page(result.page) &&
        result.page.pageHandle === params.pageHandle &&
        result.page.documentRevision === params.documentRevision &&
        text(result.text, 4000) &&
        Array.isArray(result.ranges) &&
        result.ranges.length <= 100 &&
        result.ranges.every(
          (range) =>
            object(range) &&
            Number.isInteger(range.start) &&
            Number.isInteger(range.end) &&
            range.start >= 0 &&
            range.end > range.start &&
            range.end <= result.text.length,
        )
      );
    case "browser.highlight":
      return (
        Number.isInteger(result.matched) &&
        result.matched >= 0 &&
        result.matched <= 100 &&
        typeof result.highlighted === "boolean"
      );
    case "browser.openSource":
    case "browser.requestSidePanel":
      return (
        ["opened", "requires-user-action"].includes(result.status) &&
        (result.actionId === null || uuid(result.actionId))
      );
    case "browser.getOperation": {
      if (
        result.sourceGrantId !== params.sourceGrantId ||
        result.invocationId !== params.invocationId ||
        !["unknown", "pending", "applied", "rejected", "cancelled"].includes(result.status) ||
        !["available", "not-authorized", "not-applicable", "not-retained"].includes(
          result.contentStatus,
        ) ||
        !(result.resultDigest === null || /^[a-f0-9]{64}$/.test(result.resultDigest || ""))
      )
        return false;
      if (["unknown", "pending", "cancelled"].includes(result.status))
        return (
          result.receipt === null &&
          result.resultDigest === null &&
          ["not-applicable", "not-retained"].includes(result.contentStatus)
        );
      // 终态和读取内容是两层授权；权限收窄仍允许获知原终态，但不能返回旧正文。
      if (result.contentStatus !== "available") return result.receipt === null;
      if (!/^[a-f0-9]{64}$/.test(result.resultDigest || "")) return false;
      const receipt = result.receipt;
      if (
        !object(receipt) ||
        ![
          "browser.getContext",
          "browser.readSelection",
          "browser.highlight",
          "browser.openSource",
          "browser.requestSidePanel",
        ].includes(receipt.method)
      )
        return false;
      // 恢复回执有自己的业务方法；选区原始输入未保存，因此仍校验大小/范围而不代造页面授权。
      if (receipt.ok === false) return result.status === "rejected" && error(receipt.error);
      if (receipt.ok !== true || result.status !== "applied") return false;
      const originalParams = receipt.method === "browser.readSelection" ? receipt.result?.page : {};
      return validateHostResult(receipt.method, receipt.result, originalParams || {});
    }
    case "browser.cancelOperation":
      return ["cancelled", "already-completed", "unknown"].includes(result.status);
    default:
      return false;
  }
}
function validateHostResponse(message, params) {
  return message.ok
    ? validateHostResult(message.method, message.result, params)
    : error(message.error);
}
module.exports = { validateHostParams, validateHostResponse };
