<script setup>
import { computed, ref, watch, nextTick, onMounted, onBeforeUnmount } from "vue";
import confetti from "canvas-confetti";
import Icon from "../components/Icon.vue";
import { GUIDE_STEPS, currentGuideStep, placeGuide, highlightBounds } from "./guide-steps.js";
import { createGuideIsolation } from "./guide-interaction.js";

const props = defineProps({
  state: Object,
  busy: Boolean,
  page: String,
  audio: Object,
  scope: String,
  capturePreview: Boolean,
});
const emit = defineEmits(["command", "navigate"]);
const canvas = ref(null),
  coach = ref(null),
  geometry = ref(null),
  portal = ref("body");
const guide = computed(() => props.state?.guide);
const step = computed(() => currentGuideStep(guide.value));
const progress = computed(() => guide.value?.cursor ?? guide.value?.completed?.length ?? 0);
const active = computed(() => Boolean(guide.value?.active && !guide.value?.finishedAt));
const invitation = computed(() => active.value && !guide.value.started);
const visible = computed(() => Boolean(step.value));
const canNext = computed(() =>
  Boolean(
    (progress.value < (guide.value?.completed?.length || 0) ||
      step.value?.read ||
      step.value?.optional ||
      (["learn", "practice"].includes(step.value?.id) &&
        !props.state?.profile.goal &&
        !props.state?.insights.manualWords)) &&
      (!step.value.visit ||
        (step.value.visit === "capture" && props.capturePreview) ||
        (step.value.visit === "trash" && props.scope === "trash")),
  ),
);
const hint = ref(""),
  dragging = ref(false);
const isolation = createGuideIsolation();
let observer, resizeObserver, frame, burst, lastAnchor, lastCelebrated;
let lastSignature = "",
  previousFocus,
  followingAudio = false,
  returnFocus = false;
let allowed = [],
  manualPosition = null,
  drag = null;

function target(name) {
  return [...document.querySelectorAll('[data-guide="' + name + '"]')].find((node) => {
    const box = node.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && getComputedStyle(node).visibility !== "hidden";
  });
}
// 本步可以有多个真实操作；输入框与保存按钮都圈出，其他操作保持锁定。
function targets() {
  hint.value = "";
  if (!step.value) return [];
  const id = step.value.id;
  if (props.page !== step.value.page) return [target("nav-" + step.value.page)].filter(Boolean);
  if (id === "learn") {
    const list = target("practice-row");
    if (!list) hint.value = "词库目前是空的。先认识练习方式，记录单词后随时来练。";
    return [
      (list && target("practice-signals")) || target("practice-empty") || target("nav-practice"),
      ...(list ? [target("practice-reveal"), target("practice-mask")] : []),
    ].filter(Boolean);
  }
  if (["goal", "plan"].includes(id))
    return [
      target(step.value.anchor) || target("planning-entry"),
      target("planning-actions"),
    ].filter(Boolean);
  if (id === "practice")
    return [target("practice-input") || target("practice-empty")].filter(Boolean);
  if (id === "trash") {
    const visited = props.scope === "trash";
    if (visited) hint.value = "移到这里的资料可以恢复。这一步只参观。";
    return [target(visited ? "trash-view" : "nav-trash")].filter(Boolean);
  }

  return [
    target(step.value.anchor) ||
      (id === "goal" && target("plan-save")) ||
      target("word-list") ||
      target("nav-" + step.value.page),
  ].filter(Boolean);
}
function isAllowed(node) {
  return (
    node instanceof Element &&
    (coach.value?.contains(node) || allowed.some((root) => root.contains(node)))
  );
}
function lock() {
  if (!active.value) {
    isolation.clear();
    allowed = [];
    return;
  }
  isolation.sync(
    document.body,
    [coach.value?.closest(".guide-overlay") || coach.value, canvas.value, ...allowed].filter(
      Boolean,
    ),
  );
  if (!isAllowed(document.activeElement)) coach.value?.focus({ preventScroll: true });
}
function clearDock() {
  const main = document.querySelector(".d-main");
  main?.style.removeProperty("margin-bottom");
  main?.removeAttribute("data-guide-docked");
}
// 空间不足时把批注放在内容区下方；高亮只圈当前滚动区域内真正可见的部分。
function visibleRect(node) {
  const rect = node.getBoundingClientRect();
  // 规划的滚动区与页脚紧邻；高亮内缩到内容区，避免两圈沿弹窗边缘重叠。
  if (node.matches(".planning-body"))
    return {
      left: rect.left + 16,
      right: rect.right - 16,
      top: rect.top + 10,
      bottom: rect.bottom - 10,
      width: rect.width - 32,
      height: Math.max(0, rect.height - 20),
    };
  const main = node.closest(".d-main[data-guide-docked]");
  if (!main) return rect;
  const bounds = main.getBoundingClientRect();
  const top = Math.max(rect.top, bounds.top + 8);
  const bottom = Math.min(rect.bottom, bounds.bottom - 8);
  return {
    left: rect.left,
    right: rect.right,
    top,
    bottom,
    width: rect.width,
    height: Math.max(0, bottom - top),
  };
}
function rectangles(nodes) {
  return nodes
    .map(visibleRect)
    .filter((box) => box.width && box.height && box.bottom > 54 && box.top < innerHeight - 28);
}
function readingAreas() {
  const selectors =
    step.value?.id === "practice"
      ? ".practice-headword, .practice-question, .practice-instruction, .practice-stage h2, .practice-feedback"
      : step.value?.id === "learn"
        ? ".practice-list-table thead, .practice-list-table tbody tr:first-child, .practice-page .empty"
        : step.value?.id === "audio"
          ? ".d-word-card > header, [data-card-module=meaning]"
          : step.value?.id === "trash" && props.scope === "trash"
            ? ".d-word-list .empty"
            : "";
  return selectors ? rectangles([...document.querySelectorAll(selectors)]) : [];
}
function measure(reveal = false) {
  // 原生 dialog 在顶层；教学也进入其宿主，避免“看得见却点不到”的双层焦点锁。
  const host = document.querySelector("dialog[open] [data-guide-host]");
  if (portal.value !== (host || "body")) {
    portal.value = host || "body";
    nextTick(() => measure(true));
    return;
  }
  if (!visible.value || !coach.value) {
    geometry.value = null;
    allowed = [];
    lock();
    return;
  }
  if (reveal) clearDock();
  const highlighted = targets();
  // 参观内容仍高亮，但不会因为高亮而开放输入、删除或设置操作。
  allowed = step.value.read && canNext.value && !step.value.interactive ? [] : highlighted;
  // 保存或提示读取失败时，重试仍属于当前练习。只开放本步的恢复入口，
  // 不把整页按钮放开，也不把错误提示画成另一个教学高亮框。
  const recovery =
    ["learn", "practice"].includes(step.value.id) && props.page === step.value.page
      ? target("practice-recovery")
      : null;
  if (recovery) allowed = [...allowed, recovery];
  document.querySelector(".desktop-shell")?.classList.toggle("guide-active", visible.value);
  const node = highlighted[0];
  lock();
  // 新题输入完成挂载后，隔离器已知道它是合法焦点。只从批注容器交还焦点，
  // 不打断用户正在操作的教学按钮；无需再次点击透明输入框才能开始打字。
  if (step.value.id === "practice" && document.activeElement === coach.value)
    node?.querySelector("input:not(:disabled):not([readonly])")?.focus({ preventScroll: true });
  if (!node) {
    geometry.value = null;
    return;
  }
  let box = visibleRect(node);
  const raw = node.getBoundingClientRect();
  const scrollBounds = node.closest(".d-main")?.getBoundingClientRect();
  const scrollTop = scrollBounds ? scrollBounds.top + 12 : 64;
  const scrollBottom = scrollBounds ? scrollBounds.bottom - 12 : innerHeight - 36;
  // 可完整放入视区的目标不能只露半个表单；高亮裁剪不能掩盖真实控件已滚出视区。
  const hiddenControl =
    raw.height <= scrollBottom - scrollTop && (raw.top < scrollTop || raw.bottom > scrollBottom);
  if (!dragging.value && (reveal || hiddenControl))
    node.scrollIntoView({
      block: "center",
      inline: "nearest",
      behavior: "instant",
    });
  // 本步只操作首行；居中滚动后还原列表顶部，避免粘滞表头压住高亮边缘。
  if (step.value.id === "learn") {
    const list = node.closest(".practice-list-scroll");
    if (list) list.scrollTop = 0;
  }
  box = visibleRect(node);
  const card = coach.value.getBoundingClientRect();
  const viewport = { width: innerWidth, height: innerHeight };
  const size = { width: card.width || 340, height: card.height || 176 };
  const hostRect = host?.getBoundingClientRect();
  const options = () => ({
    position: hostRect
      ? {
          x: hostRect.left + (hostRect.width - size.width) / 2,
          y: hostRect.top + Math.max(12, (hostRect.height - size.height) / 2),
        }
      : manualPosition,
    obstacles: [
      ...rectangles(highlighted.slice(1)),
      ...readingAreas(),
      ...rectangles(recovery ? [recovery] : []),
    ],
    // 学习阶段的整体用于卡片避让，文字区单独用于连线绕行。
    connectorObstacles:
      step.value.id === "learn"
        ? rectangles([...document.querySelectorAll(".study-stage h2, .study-meaning")])
        : readingAreas(),
  });
  let placed = placeGuide(box, viewport, size, options());
  const overlap = [box, ...options().obstacles].some(
    (area) =>
      placed.x < area.right + 8 &&
      placed.x + placed.width > area.left - 8 &&
      placed.y < area.bottom + 8 &&
      placed.y + placed.height > area.top - 8,
  );

  // 没有足够空位时，给批注划出下方区域；页面仍可滚动，不缩短练习列表制造大白块。
  if (reveal && overlap) {
    const scroller = node.closest(".d-main");
    if (scroller) {
      scroller.style.marginBottom = `${Math.ceil(size.height) + 36}px`;
      scroller.setAttribute("data-guide-docked", "true");
      node.scrollIntoView({
        block: node.offsetHeight > scroller.clientHeight ? "start" : "center",
        inline: "nearest",
        behavior: "instant",
      });
      box = visibleRect(node);
      placed = placeGuide(box, viewport, size, options());
    }
  }
  const clipped = (rect) => highlightBounds(rect, viewport);
  geometry.value = {
    viewport,
    anchor: clipped(box),
    targets: rectangles(highlighted).map(clipped),
    ...placed,
  };
  lastAnchor = node;
}
function schedule() {
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(() => measure(targets()[0] !== lastAnchor));
}
async function locate() {
  await nextTick();
  measure(true);
}
function skip() {
  returnFocus = Boolean(coach.value?.contains(document.activeElement));
  if (!props.busy) emit("command", { action: "guidePause" });
}
function begin() {
  if (!props.busy) emit("command", { action: "guideStart" });
}
function next() {
  if (!props.busy && canNext.value) emit("command", { action: "guideNext", step: step.value.id });
}
// 只允许本步真实操作或教学卡片，讲解通过明确的下一步确认，不伪造业务保存。
function guardPointer(event) {
  if (!active.value || isAllowed(event.target)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}

function guardKeyboard(event) {
  if (!active.value) return;
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopImmediatePropagation();
    skip();
    return;
  }
  const shortcut =
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    (/^[1-7,]$/.test(event.key) || event.key.toLowerCase() === "k");
  if (shortcut || (event.key !== "Tab" && !isAllowed(event.target))) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
}
function guardFocus(event) {
  if (active.value && !isAllowed(event.target)) coach.value?.focus({ preventScroll: true });
}
function startDrag(event) {
  if (event.button !== 0 || event.target.closest("button")) return;
  event.preventDefault();
  drag = {
    id: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    x: geometry.value?.x || 220,
    y: geometry.value?.y || 64,
  };
  dragging.value = true;
  event.currentTarget.setPointerCapture(event.pointerId);
}
function moveDrag(event) {
  if (!drag || drag.id !== event.pointerId) return;
  manualPosition = {
    x: drag.x + event.clientX - drag.startX,
    y: drag.y + event.clientY - drag.startY,
  };
  measure();
}
function endDrag(event) {
  if (!drag || drag.id !== event.pointerId) return;
  event.currentTarget.releasePointerCapture(event.pointerId);
  drag = null;
  dragging.value = false;
}
function moveWithKeyboard(event) {
  const movement = {
    ArrowLeft: [-20, 0],
    ArrowRight: [20, 0],
    ArrowUp: [0, -20],
    ArrowDown: [0, 20],
  }[event.key];
  if (!movement || !geometry.value) return;
  event.preventDefault();
  event.stopPropagation();
  manualPosition = {
    x: geometry.value.x + movement[0],
    y: geometry.value.y + movement[1],
  };
  measure();
}

// 一个业务步骤成功后自动定位下一处。发音播放期间等待自然结束，避免半句被切断。
watch(
  () => [guide.value?.active, guide.value?.started, progress.value, guide.value?.finishedAt],
  async () => {
    const signature = [guide.value?.active, guide.value?.started, progress.value].join(":");
    if (signature === lastSignature) return;
    lastSignature = signature;
    manualPosition = null;
    clearDock();
    drag = null;
    dragging.value = false;
    if (!active.value) {
      geometry.value = null;
      isolation.clear();
      document.querySelector(".desktop-shell")?.classList.remove("guide-active");
      allowed = [];
      await nextTick();
      // 若等待 Core 回执期间用户已点到别处，不把新的输入焦点抢回教学入口。
      if (returnFocus && document.activeElement === document.body) {
        (previousFocus?.isConnected &&
        previousFocus.matches("button, input, select, textarea, [tabindex]")
          ? previousFocus
          : target("guide-help")
        )?.focus();
      }
      returnFocus = false;
      return;
    }
    if (invitation.value) {
      geometry.value = null;
      allowed = [];
      await nextTick();
      lock();
      coach.value?.querySelector(".guide-enter")?.focus({ preventScroll: true });
      return;
    }
    if (!coach.value?.contains(document.activeElement)) previousFocus = document.activeElement;
    if (guide.value.started && step.value?.page !== props.page) {
      if (step.value.id === "practice" && props.audio?.state === "playing") followingAudio = true;
      else emit("navigate", step.value.page);
    }
    await nextTick();
    await locate();
  },
  { immediate: true, flush: "post" },
);
watch(
  () => props.audio?.state,
  (value) => {
    if (followingAudio && value !== "playing") {
      followingAudio = false;
      if (step.value?.id === "practice") emit("navigate", step.value.page);
    }
  },
);
watch(
  () => [props.page, props.scope],
  async () => {
    // 业务保存的返回页可能晚于教学进度回执；继续推进到下一项。
    if (visible.value && guide.value.started && step.value.page !== props.page && !followingAudio) {
      emit("navigate", step.value.page);
    }
    await nextTick();
    await locate();
  },
);
watch(
  () => guide.value?.advancedAt,
  (value) => {
    if (lastCelebrated === undefined) {
      lastCelebrated = value || "";
      return;
    }
    if (!value) {
      lastCelebrated = "";
      return;
    }
    if (lastCelebrated === value || !canvas.value) return;
    lastCelebrated = value;
    burst ||= confetti.create(canvas.value, {
      resize: true,
      disableForReducedMotion: true,
    });
    const options = {
      particleCount: 45,
      spread: 360,
      startVelocity: 24,
      ticks: 65,
      gravity: 0.7,
      colors: ["#1b806b", "#65c2b5", "#e8b15b"],
      disableForReducedMotion: true,
    };
    burst({ ...options, origin: { x: 0.3, y: 0.38 } });
    burst({ ...options, origin: { x: 0.7, y: 0.38 } });
  },
  { immediate: true, flush: "post" },
);

onMounted(() => {
  observer = new MutationObserver((records) => {
    // 批注自身的位置变化不能再次触发布局测量，否则会形成无限重排。
    if (
      records.some((record) => !record.target.closest?.(".guide-overlay, .guide-final-fireworks"))
    )
      schedule();
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-guide-state", "disabled", "open"],
  });
  resizeObserver = new ResizeObserver(schedule);
  if (coach.value) resizeObserver.observe(coach.value);
  addEventListener("resize", locate);
  document.addEventListener("scroll", schedule, true);
  document.addEventListener("input", schedule);
  document.addEventListener("keydown", guardKeyboard, true);
  document.addEventListener("focusin", guardFocus, true);
  for (const type of ["pointerdown", "click", "dblclick", "contextmenu"])
    document.addEventListener(type, guardPointer, true);
  locate();
});
watch(coach, (node) => {
  if (node) resizeObserver?.observe(node);
});
onBeforeUnmount(() => {
  cancelAnimationFrame(frame);
  observer?.disconnect();
  resizeObserver?.disconnect();
  burst?.reset();
  clearDock();
  removeEventListener("resize", locate);
  document.removeEventListener("scroll", schedule, true);
  document.removeEventListener("input", schedule);
  document.removeEventListener("keydown", guardKeyboard, true);
  document.removeEventListener("focusin", guardFocus, true);
  for (const type of ["pointerdown", "click", "dblclick", "contextmenu"])
    document.removeEventListener(type, guardPointer, true);
  isolation.clear();
});
</script>

<template>
  <Teleport :to="portal">
    <canvas ref="canvas" class="guide-final-fireworks" aria-hidden="true" />
    <div v-if="invitation" class="guide-invitation">
      <section
        ref="coach"
        class="guide-invitation-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="guide-invitation-title"
        tabindex="-1"
      >
        <Icon name="book-2" />
        <h2 id="guide-invitation-title">欢迎使用词遇</h2>
        <p>花几分钟认识词库、练习和采集。目标与计划都可以暂不设置。</p>
        <div class="row">
          <button class="button primary guide-enter" :disabled="busy" @click="begin">
            进入教学
          </button>
          <button class="button" :disabled="busy" @click="skip"> 跳过教学 </button>
        </div>
        <small>在设置的「使用教学」中可以重新进入。</small>
      </section>
    </div>
    <div v-if="visible" class="guide-overlay" data-testid="guide-overlay">
      <template v-if="geometry">
        <svg
          class="guide-shade"
          aria-hidden="true"
          :viewBox="'0 0 ' + geometry.viewport.width + ' ' + geometry.viewport.height"
        >
          <defs>
            <mask id="guide-focus-mask">
              <rect width="100%" height="100%" fill="white" />
              <rect
                v-for="(box, index) in geometry.targets"
                :key="index"
                :x="box.left"
                :y="box.top"
                :width="box.width"
                :height="box.height"
                rx="8"
                fill="black"
              />
            </mask>
          </defs>
          <rect width="100%" height="100%" mask="url(#guide-focus-mask)" />
        </svg>
        <div
          v-for="(box, index) in geometry.targets"
          :key="index"
          class="guide-target"
          aria-hidden="true"
          :style="{
            left: box.left + 'px',
            top: box.top + 'px',
            width: box.width + 'px',
            height: box.height + 'px',
          }"
        />
        <!-- 连线是定位真实控件的交互几何，不是静态插画或模拟图标。 -->
        <svg
          class="guide-connector"
          aria-hidden="true"
          :viewBox="'0 0 ' + geometry.viewport.width + ' ' + geometry.viewport.height"
        >
          <defs>
            <marker
              id="guide-arrow"
              markerWidth="8"
              markerHeight="8"
              refX="6"
              refY="4"
              orient="auto"
            >
              <path d="M 0 0 L 7 4 L 0 8" fill="none" stroke="currentColor" stroke-width="1.6" />
            </marker>
          </defs>
          <path :d="geometry.path" marker-end="url(#guide-arrow)" />
        </svg>
      </template>
      <section
        ref="coach"
        class="guide-coach"
        :class="{ dragging }"
        tabindex="-1"
        role="dialog"
        aria-modal="false"
        aria-label="首次使用引导"
        :style="geometry ? { left: geometry.x + 'px', top: geometry.y + 'px' } : {}"
      >
        <div
          class="guide-coach-heading"
          @pointerdown="startDrag"
          @pointermove="moveDrag"
          @pointerup="endDrag"
          @pointercancel="endDrag"
        >
          <div
            class="guide-drag-handle"
            role="button"
            tabindex="0"
            aria-label="移动教学卡片"
            title="拖动移动 · 方向键微调"
            @keydown="moveWithKeyboard"
          >
            <Icon name="arrows-maximize" />
            <span class="guide-step-count"
              >使用教学 · {{ progress + 1 }} / {{ GUIDE_STEPS.length }}</span
            >
          </div>
          <button
            class="icon-button"
            aria-label="暂停引导"
            title="跳过教学 · Esc"
            :disabled="busy"
            @click="skip"
          >
            <Icon name="x" />
          </button>
        </div>
        <h2 aria-live="polite">{{ step.title }}</h2>
        <p>{{ hint || step.text }}</p>
        <div class="guide-step-action">
          <button
            v-if="progress > 0"
            class="text-button"
            :disabled="busy"
            @click="emit('command', { action: 'guidePrevious' })"
          >
            上一步
          </button>
          <button v-if="canNext" class="button primary small" :disabled="busy" @click="next">
            {{
              step.optional
                ? "暂不设置"
                : progress + 1 === GUIDE_STEPS.length
                  ? "完成教学"
                  : "下一步"
            }}
          </button>
        </div>
        <div class="guide-dots" aria-hidden="true">
          <i
            v-for="n in GUIDE_STEPS.length"
            :key="n"
            :class="{ done: n <= progress, current: n === progress + 1 }"
          />
        </div>
        <div class="guide-coach-actions">
          <button class="text-button" :disabled="busy" @click="skip"> 跳过教学 </button>
          <small>在设置的「使用教学」中可以重新进入。</small>
        </div>
      </section>
    </div>
  </Teleport>
</template>
