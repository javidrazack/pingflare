<script lang="ts">
  import { onMount } from 'svelte'
  import { page } from '$app/stores'
  import { goto } from '$app/navigation'
  import { api } from '$lib/api'
  import { t } from '$lib/i18n'
  import MonitorForm from '$lib/components/MonitorForm.svelte'
  import PageLoader from '$lib/components/PageLoader.svelte'
  import HeaderPattern from '$lib/components/HeaderPattern.svelte'
  import type { Monitor } from '$lib/api'

  $: id = $page.params.id as string
  let monitor: Monitor | null = null
  let loading = true
  let error = ''

  async function loadMonitor() {
    loading = true
    error = ''
    try {
      monitor = await api.monitors.get(id)
    } catch {
      error = $t('editMonitor.loadFailed')
    } finally {
      loading = false
    }
  }

  onMount(loadMonitor)

  function onSaved(e: CustomEvent<Monitor>) {
    goto(`/monitors/${e.detail.id}`)
  }
</script>

<svelte:head><title>{$t('editMonitor.heading')} - Pingflare</title></svelte:head>

<div style="background-color: rgb(var(--bg))">

  <div class="relative overflow-hidden" style="border-bottom: 1px solid var(--border-color)">
    <HeaderPattern />
    <div class="relative px-4 py-6 md:px-8 md:py-8 max-w-5xl mx-auto">
      <a href="/monitors/{id}" class="mb-4 inline-flex min-h-11 items-center gap-1 text-xs transition-colors hover:text-[var(--color-primary)]"
        style="color: rgb(var(--text-muted))">{$t('editMonitor.back')}</a>
      <h1 class="text-3xl font-semibold tracking-tight" style="color: rgb(var(--text))">
        {#if monitor}{$t('editMonitor.editNamed', { name: monitor.name })}{:else}{$t('editMonitor.heading')}{/if}
      </h1>
    </div>
  </div>

  <div class="px-4 py-5 md:px-8 md:py-8 max-w-5xl mx-auto">
    {#if loading}
      <PageLoader />
    {:else if error}
      <section class="card py-10 text-center" role="alert">
        <h2 class="text-lg font-semibold" style="color: rgb(var(--text))">{$t('editMonitor.loadFailedTitle')}</h2>
        <p class="mx-auto mt-1 max-w-md text-sm" style="color: rgb(var(--text-muted))">{error}</p>
        <div class="mt-5 flex flex-wrap justify-center gap-2">
          <button type="button" class="btn-primary" on:click={loadMonitor}>{$t('editMonitor.retry')}</button>
          <a href="/monitors" class="btn-outline">{$t('editMonitor.back')}</a>
        </div>
      </section>
    {:else if monitor}
      <div class="card">
        <MonitorForm {monitor} mode="edit" on:saved={onSaved} on:cancel={() => goto(`/monitors/${id}`)} />
      </div>
    {/if}
  </div>

</div>
