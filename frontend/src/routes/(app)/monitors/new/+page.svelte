<script lang="ts">
  import { goto } from '$app/navigation'
  import { t } from '$lib/i18n'
  import MonitorForm from '$lib/components/MonitorForm.svelte'
  import HeaderPattern from '$lib/components/HeaderPattern.svelte'
  import type { Monitor } from '$lib/api'

  function onSaved(e: CustomEvent<Monitor>) {
    goto(`/monitors/${e.detail.id}`)
  }
</script>

<svelte:head><title>{$t('newMonitor.heading')} - Pingflare</title></svelte:head>

<div style="background-color: rgb(var(--bg))">

  <div class="relative overflow-hidden" style="border-bottom: 1px solid var(--border-color)">
    <HeaderPattern />
    <div class="relative px-4 py-6 md:px-8 md:py-8 max-w-5xl mx-auto">
      <a href="/monitors" class="mb-4 inline-flex min-h-11 items-center gap-1 text-xs transition-colors hover:text-[var(--color-primary)]"
        style="color: rgb(var(--text-muted))">{$t('newMonitor.back')}</a>
      <h1 class="text-3xl font-semibold tracking-tight" style="color: rgb(var(--text))">{$t('newMonitor.heading')}</h1>
      <p class="mt-1 text-sm" style="color: rgb(var(--text-muted))">{$t('newMonitor.subtitle')}</p>
    </div>
  </div>

  <div class="px-4 py-5 md:px-8 md:py-8 max-w-5xl mx-auto">
    <div class="card">
      <MonitorForm mode="create" on:saved={onSaved} on:cancel={() => goto('/monitors')} />
    </div>
  </div>

</div>
