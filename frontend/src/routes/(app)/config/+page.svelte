<script lang="ts">
  import { onMount } from 'svelte'
  import { api } from '$lib/api'
  import type { BackupData } from '$lib/api'
  import { t, locale, localeOptions } from '$lib/i18n'
  import Icon from '$lib/components/Icon.svelte'
  import PageLoader from '$lib/components/PageLoader.svelte'
  import HeaderPattern from '$lib/components/HeaderPattern.svelte'

  let loading = true
  let saving = false
  let saved = false
  let error = ''

  let retentionDays = 90

  // Backup & Restore
  let exporting = false
  let importing = false
  let restoreSuccess = false
  let restoreError = ''
  let fileInput: HTMLInputElement

  onMount(async () => {
    try {
      const s = await api.settings.get()
      retentionDays = parseInt(s['retention_days'] ?? '90', 10)
    } catch (e) {
      error = String(e)
    } finally {
      loading = false
    }
  })

  async function save() {
    saving = true; error = ''
    try {
      await api.settings.update({ retention_days: String(retentionDays) })
      saved = true
      setTimeout(() => saved = false, 2500)
    } catch (e) {
      error = String(e)
    } finally {
      saving = false
    }
  }

  function setLocale(e: Event) {
    const value = (e.target as HTMLSelectElement).value
    locale.set(value)
    api.settings.update({ locale: value }).catch(() => {})
  }

  async function exportBackup() {
    exporting = true
    try {
      const data = await api.backup.export()
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `pingflare-backup-${new Date().toISOString().slice(0, 10)}.json`
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      error = String(e)
    } finally {
      exporting = false
    }
  }

  function triggerImport() {
    fileInput.click()
  }

  async function handleImportFile(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0]
    if (!file) return

    if (!confirm($t('config.restoreConfirm'))) {
      ;(e.target as HTMLInputElement).value = ''
      return
    }

    importing = true
    restoreError = ''
    restoreSuccess = false
    try {
      const text = await file.text()
      const data: BackupData = JSON.parse(text)
      await api.backup.restore(data)
      restoreSuccess = true
      setTimeout(() => restoreSuccess = false, 3000)
    } catch (e) {
      restoreError = String(e)
    } finally {
      importing = false
      ;(fileInput as HTMLInputElement).value = ''
    }
  }
</script>

<svelte:head><title>{$t('config.heading')} - Pingflare</title></svelte:head>

{#if loading}
  <PageLoader />
{/if}

<div style="background-color: rgb(var(--bg))">

  <div class="relative overflow-hidden" style="border-bottom: 1px solid var(--border-color)">
    <HeaderPattern />
    <div class="relative px-4 py-6 md:px-8 md:py-8 max-w-5xl mx-auto">
      <h1 class="text-2xl md:text-3xl font-semibold tracking-tight" style="color: rgb(var(--text))">{$t('config.heading')}</h1>
      <p class="mt-1 text-sm" style="color: rgb(var(--text-muted))">
        {$t('config.subtitle')}
      </p>
    </div>
  </div>

  <div class="px-4 py-5 md:px-8 md:py-8 max-w-5xl mx-auto space-y-4">

    {#if error}
      <div class="flex items-center gap-2 px-4 py-3 rounded text-sm" role="alert"
        style="background: rgb(var(--danger-bg)); color: var(--danger-fg); border: 1px solid color-mix(in srgb, var(--danger-fg) 30%, transparent)">
        <Icon name="exclamation-triangle" size={14} />{error}
      </div>
    {/if}

    <div class="card space-y-5">
      <div>
        <h2 class="text-sm font-semibold" style="color: rgb(var(--text))">{$t('config.language')}</h2>
        <p class="text-xs mt-0.5" style="color: rgb(var(--text-muted))">{$t('config.languageDesc')}</p>
      </div>
      <div class="flex items-center gap-3">
        <select class="input w-auto text-sm" aria-label={$t('config.language')} value={$locale} on:change={setLocale}>
          {#each localeOptions as { code, name }}
            <option value={code}>{name}</option>
          {/each}
        </select>
      </div>
    </div>

    <div class="card space-y-5">
      <div>
        <h2 class="text-sm font-semibold" style="color: rgb(var(--text))">{$t('config.backup')}</h2>
        <p class="text-xs mt-0.5" style="color: rgb(var(--text-muted))">{$t('config.backupDesc')}</p>
      </div>

      <div class="flex flex-col sm:flex-row gap-3">
        <button class="btn-outline text-sm"
          style="border-color: color-mix(in srgb, var(--color-primary) 45%, var(--border-color)); color: var(--color-primary);"
          disabled={exporting} on:click={exportBackup}>
          {exporting ? $t('config.exporting') : $t('config.exportBackup')}
        </button>

        <button class="btn-outline text-sm"
          style="border-color: color-mix(in srgb, var(--danger-fg) 40%, var(--border-color)); color: var(--danger-fg);"
          disabled={importing} on:click={triggerImport}>
          {importing ? $t('config.importing') : $t('config.importBackup')}
        </button>

        <input bind:this={fileInput} type="file" accept=".json" class="hidden" on:change={handleImportFile} />
      </div>

      <div class="flex items-start gap-2 px-3 py-2.5 rounded text-xs"
        style="background: rgb(var(--warning-bg)); color: var(--warning-fg); border: 1px solid color-mix(in srgb, var(--warning-fg) 25%, transparent)">
        <Icon name="exclamation-triangle" size={13} cls="mt-px shrink-0" />
        <span>{$t('config.restoreWarning')}</span>
      </div>

      {#if restoreSuccess}
        <div class="flex items-center gap-2 px-3 py-2.5 rounded text-xs" role="status" aria-live="polite"
          style="background: rgb(var(--success-bg)); color: var(--success-fg); border: 1px solid color-mix(in srgb, var(--success-fg) 25%, transparent)">
          <Icon name="check-circle" size={13} /> {$t('config.restoreSuccess')}
        </div>
      {/if}

      {#if restoreError}
        <div class="flex items-center gap-2 px-3 py-2.5 rounded text-xs" role="alert"
          style="background: rgb(var(--danger-bg)); color: var(--danger-fg); border: 1px solid color-mix(in srgb, var(--danger-fg) 30%, transparent)">
          <Icon name="exclamation-triangle" size={13} /> {restoreError}
        </div>
      {/if}
    </div>

    <div class="card space-y-5">
      <div>
        <h2 class="text-sm font-semibold" style="color: rgb(var(--text))">{$t('config.dataRetention')}</h2>
        <p class="text-xs mt-0.5" style="color: rgb(var(--text-muted))">
          {$t('config.dataRetentionDesc')}
        </p>
      </div>

      <div class="flex flex-col sm:flex-row sm:items-end gap-4">
        <div class="flex-1 space-y-1.5">
          <label class="text-xs font-medium" style="color: rgb(var(--text-muted))" for="retention">{$t('config.keepLogsFor')}</label>
          <div class="flex items-center gap-3">
            <input id="retention" type="number" min="1" max="365"
              class="input w-28 tabular-nums" bind:value={retentionDays} />
            <span class="text-sm" style="color: rgb(var(--text-muted))">{$t('config.days')}</span>
          </div>
          <p class="text-xs" style="color: rgb(var(--text-muted))">{$t('config.allowedRange')}</p>
        </div>
        <div class="shrink-0">
          <button class="btn-primary" disabled={saving} on:click={save}>
            {#if saving}
              <Icon name="arrow-path" size={14} cls="animate-spin" /> {$t('config.saving')}
            {:else if saved}
              <Icon name="check-circle" size={14} /> {$t('config.saved')}
            {:else}
              {$t('config.save')}
            {/if}
          </button>
        </div>
      </div>
    </div>

  </div>
</div>
