<script setup>
defineProps({ name: { type: String, required: true } });
const icons = import.meta.glob("../assets/icons/*.svg", {
  eager: true,
  query: "?url",
  import: "default",
});
</script>

<template>
  <img class="icon" :src="icons[`../assets/icons/${name}.svg`]" alt="" aria-hidden="true" />
</template>
