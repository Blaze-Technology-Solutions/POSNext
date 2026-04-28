<template>
  <div
    v-if="runtimeConfig.isDesktop && available && !dismissed"
    class="fixed top-0 inset-x-0 z-50 bg-blue-600 text-white px-4 py-2 shadow-lg flex items-center justify-between gap-3"
    role="status"
  >
    <div class="text-sm">
      <strong class="font-semibold">{{ __('Update available') }}</strong>
      <span class="ml-2 opacity-90">
        {{ __('Version') }} {{ available.version }}
        <span v-if="available.notes" class="opacity-75">— {{ available.notes }}</span>
      </span>
    </div>
    <div class="flex items-center gap-2">
      <button
        type="button"
        class="text-xs px-2 py-1 rounded bg-white/10 hover:bg-white/20 disabled:opacity-50"
        :disabled="downloading"
        @click="dismissed = true"
      >
        {{ __('Later') }}
      </button>
      <button
        type="button"
        class="text-xs px-3 py-1 rounded bg-white text-blue-700 font-medium hover:bg-blue-50 disabled:opacity-50"
        :disabled="downloading"
        @click="installAndRelaunch"
      >
        {{ downloading ? __('Installing…') : __('Install & restart') }}
      </button>
    </div>
  </div>
</template>

<script setup>
import { ref } from "vue"
import { useDesktopUpdate } from "@/composables/useDesktopUpdate"
import { runtimeConfig } from "@/utils/runtimeConfig"

const { available, downloading, installAndRelaunch } = useDesktopUpdate()
const dismissed = ref(false)
</script>
