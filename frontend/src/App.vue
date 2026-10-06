<script setup>
import DesktopShell from "./desktop/DesktopShell.vue";
import CaptureWindow from "./desktop/CaptureWindow.vue";
const popup = location.hash.startsWith("#capture-");
</script>
<template><CaptureWindow v-if="popup" /><DesktopShell v-else /></template>
