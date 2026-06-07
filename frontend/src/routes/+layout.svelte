<script lang="ts">
  import '../app.css'
  import { onMount } from 'svelte'
  import { theme } from '$lib/stores'
  import { locale } from '$lib/i18n'
  import { navigating } from '$app/stores'

  onMount(() => {
    document.documentElement.classList.toggle('dark', $theme === 'dark')
  })

  $: if (typeof document !== 'undefined') {
    document.documentElement.lang = $locale
  }
</script>

{#if $navigating}
  <div class="fixed top-0 left-0 right-0 h-[3px] z-[100] overflow-hidden" style="background-color: color-mix(in srgb, var(--color-primary) 20%, transparent);">
    <div class="h-full bg-primary relative animate-progress"></div>
  </div>
{/if}

<slot />
