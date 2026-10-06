<script setup>
import Icon from "../components/Icon.vue";
defineProps({ state: Object, busy: Boolean, run: Function });
const emit = defineEmits(["navigate", "start", "capture"]);
</script>
<template>
  <section class="d-page today-page">
    <header class="page-heading">
      <div>
        <h1>今日学习</h1>
        <p>在语境里遇见，在记忆里重逢。</p>
      </div>
      <time>{{ state.today }}</time>
    </header>
    <section class="today-hero">
      <div>
        <p class="eyebrow">
          {{ state.profile.planEnabled ? "今天的安排" : "按自己的节奏" }}
        </p>
        <h2>
          {{ state.queue.tasks.length ? "从今天遇见的词开始" : "把每次遇见，留成记忆" }}
        </h2>
        <p>
          {{
            state.profile.planEnabled
              ? "在练习中心完成今日任务，熟悉度随练习积累。"
              : "记录单词、随时练习，也可以选择一个学习目标。"
          }}
        </p>
        <div class="row">
          <button
            class="button primary"
            data-guide="study-start"
            :disabled="busy"
            @click="emit('start')"
          >
            {{ state.queue.tasks.length ? "开始今日学习" : "去练习中心" }}</button
          ><button class="button" data-guide="today-target" @click="emit('navigate', 'plan')">
            {{ state.profile.planEnabled ? "管理计划" : "目标与计划" }}
          </button>
        </div>
      </div>
      <div class="hero-number">
        <strong>{{ state.queue.tasks.length }}</strong
        ><span>当前待学</span>
      </div>
    </section>
    <div class="d-stat-grid">
      <article>
        <span>新遇见</span><strong>{{ state.queue.encounters.length }}</strong
        ><small>已采集的语境</small>
      </article>
      <article>
        <span>目标新学</span><strong>{{ state.queue.planned.length }}</strong
        ><small>{{
          state.profile.planEnabled ? "剩余额度 " + state.queue.newRemaining : "计划未启用"
        }}</small>
      </article>
      <article>
        <span>到期复习</span><strong>{{ state.queue.reviews.length }}</strong
        ><small>根据练习安排</small>
      </article>
      <article>
        <span>今日已完成</span><strong>{{ state.queue.newDone + state.queue.reviewDone }}</strong
        ><small>新学 {{ state.queue.newDone }} · 复习 {{ state.queue.reviewDone }}</small>
      </article>
    </div>
    <div class="section-heading" v-if="state.queue.tasks.length">
      <h2>今日单词</h2>
      <button class="text-button" @click="emit('start')">
        去练习<Icon name="arrow-right" />
      </button>
    </div>
    <div class="task-list" v-if="state.queue.tasks.length">
      <div v-for="task in state.queue.tasks.slice(0, 12)" :key="task.id">
        <strong>{{ task.word }}</strong
        ><span>{{
          { encounter: "新遇见", plan: "目标新学", review: "到期复习" }[task.source]
        }}</span
        ><small>{{ task.meaning }}</small>
      </div>
    </div>
    <div v-else class="today-starts">
      <button @click="emit('capture')">
        <Icon name="plus" />
        <div>
          <h3>记录一次遇见</h3>
          <p>留住读到的单词和句子。</p>
        </div>
        <Icon name="arrow-right" />
      </button>
      <button @click="emit('navigate', 'plan')">
        <Icon name="target" />
        <div>
          <h3>选择学习目标</h3>
          <p>从雅思、考试或学科词库开始。</p>
        </div>
        <Icon name="arrow-right" />
      </button>
    </div>
  </section>
</template>
