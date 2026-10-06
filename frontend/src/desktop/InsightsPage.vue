<script setup>
defineProps({ state: Object });
</script>
<template>
  <section class="d-page insights-page">
    <header class="page-heading">
      <div>
        <h1>学习洞察</h1>
        <p>每一份进步，都来自你自己的记录。</p>
      </div>
    </header>
    <div class="d-stat-grid" data-guide="insights-stats">
      <article
        v-for="(label, key) in {
          learned: '已学词条',
          encounters: '真实遇见',
          practice: '练习记录',
          manualWords: '手动收藏',
        }"
        :key="key"
      >
        <span>{{ label }}</span
        ><strong>{{ state.insights[key] }}</strong>
      </article>
    </div>
    <p class="muted" v-if="state.insights.practiceAnswers">
      独立答题正确率
      {{ Math.round((state.insights.practiceCorrect / state.insights.practiceAnswers) * 100) }}%
    </p>
    <h2>最近 30 个学习日</h2>
    <table class="word-table">
      <thead>
        <tr>
          <th>日期</th>
          <th>完成词数</th>
          <th>初学完成</th>
          <th>复习完成</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="day in state.insights.days" :key="day.day">
          <td>{{ day.day }}</td>
          <td>{{ day.completed }}</td>
          <td>{{ day.newFeedback }}</td>
          <td>{{ day.reviewFeedback }}</td>
        </tr>
      </tbody>
    </table>
    <div v-if="!state.insights.days.length" class="empty">
      <p>首次完成一个词的初学或有效复习后，这里就会开始积累。</p>
    </div>
  </section>
</template>
