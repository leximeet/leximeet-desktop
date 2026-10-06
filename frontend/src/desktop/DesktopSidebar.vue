<script setup>
import Icon from "../components/Icon.vue";
import lightLogo from "../assets/brand/logo-light.png";
import darkLogo from "../assets/brand/logo-dark.png";
defineProps({
  state: Object,
  page: String,
  scope: String,
  bookId: String,
  dark: Boolean,
  navigationGroups: Array,
});
const emit = defineEmits(["navigate", "create-book", "open-book", "remove-book", "trash"]);
</script>
<template>
  <aside class="d-sidebar" data-guide="sidebar">
    <img class="d-brand" :src="dark ? darkLogo : lightLogo" alt="词遇 LexiMeet" />
    <div class="d-sidebar-scroll">
      <nav aria-label="主导航">
        <div class="navigation-group" v-for="group in navigationGroups" :key="group.label">
          <p class="navigation-label">{{ group.label }}</p>
          <button
            v-for="item in group.items"
            :key="item[0]"
            class="nav-item"
            :aria-label="item[1]"
            :data-guide="'nav-' + item[0]"
            :aria-current="page === item[0] ? 'page' : undefined"
            :class="{
              active: page === item[0] && !(item[0] === 'library' && scope !== 'library'),
            }"
            @click="emit('navigate', item[0])"
          >
            <Icon :name="item[2]" /><span>{{ item[1] }}</span
            ><small v-if="item[0] === 'today'">{{ state?.queue.tasks.length || 0 }}</small>
          </button>
        </div>
      </nav>
      <div class="books-heading">
        <span>我的单词本</span
        ><button
          class="icon-button"
          aria-label="创建单词本"
          data-guide="book-create"
          @click="emit('create-book')"
        >
          <Icon name="plus" />
        </button>
      </div>
      <div class="d-book-list" v-if="state">
        <div
          class="book-nav-row"
          v-for="book in state.books.filter((item) => !item.role)"
          :key="book.id"
        >
          <button
            class="nav-item"
            :class="{
              active: scope === 'book' && bookId === book.id && page === 'library',
            }"
            @click="emit('open-book', book.id)"
          >
            <Icon name="bookmark" /><span>{{ book.name }}</span
            ><small>{{ book.count }}</small></button
          ><button
            class="icon-button"
            title="删除单词本"
            :aria-label="`删除 ${book.name}`"
            @click="emit('remove-book', book.id)"
          >
            <Icon name="trash" />
          </button>
        </div>
      </div>
    </div>
    <div class="d-sidebar-bottom">
      <button class="nav-item" data-guide="nav-trash" @click="emit('trash')">
        <Icon name="trash" /><span>回收站</span
        ><small>{{ state?.insights.trash || "" }}</small></button
      ><button
        class="nav-item"
        data-guide="nav-settings"
        :class="{ active: page === 'settings' }"
        @click="emit('navigate', 'settings')"
      >
        <Icon name="settings" /><span>设置</span>
      </button>
      <p><Icon name="device-desktop" />本机工作区</p>
    </div>
  </aside>
</template>
