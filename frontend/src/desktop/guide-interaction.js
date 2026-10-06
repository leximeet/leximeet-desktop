/**
 * 教学期间只开放卡片和本步真实操作。用原生 inert 同时约束鼠标与键盘，
 * 不修改业务按钮的 disabled，不丢失既有表单状态；结束后还原原值。
 */
export function createGuideIsolation() {
  const previous = new Map();
  function restore(node) {
    node.inert = previous.get(node);
    previous.delete(node);
  }
  return {
    sync(root, allowed) {
      const blocked = new Set();
      function visit(node) {
        if (allowed.some((target) => target === node || target.contains(node))) return;
        if (!allowed.some((target) => node.contains(target))) {
          // 只隔离交互节点，题干与说明仍可由辅助技术阅读。
          if (
            node.matches(
              'button, input, textarea, select, a[href], [tabindex], [contenteditable="true"]',
            )
          ) {
            blocked.add(node);
            return;
          }
        }
        for (const child of node.children) visit(child);
      }
      for (const child of root?.children || []) visit(child);
      for (const node of previous.keys()) if (!blocked.has(node)) restore(node);
      for (const node of blocked) {
        if (!previous.has(node)) previous.set(node, node.inert);
        node.inert = true;
      }
    },
    clear() {
      for (const node of [...previous.keys()]) restore(node);
    },
  };
}
