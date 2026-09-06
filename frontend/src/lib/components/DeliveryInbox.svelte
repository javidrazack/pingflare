<script lang="ts">
  import { onMount } from 'svelte'
  import { api, type DeliveryInbox } from '$lib/api'
  import { t, locale } from '$lib/i18n'
  let data: DeliveryInbox | null = null
  let loading = false
  let error = false
  let notice = ''
  let retrying = ''
  function time(value: number) { return new Date(value * 1000).toLocaleString($locale) }
  async function load() {
    loading = true
    error = false
    try { data = await api.operations.deliveries() }
    catch { error = true }
    finally { loading = false }
  }
  async function retry(id: string) {
    retrying = id
    notice = ''
    try {
      await api.operations.retry(id)
      notice = $t('delivery.queued')
      await load()
    } catch { error = true }
    finally { retrying = '' }
  }
  onMount(load)
</script>

<section id="delivery-inbox" class="card space-y-4" aria-labelledby="delivery-title" aria-busy={loading}>
  <div class="flex flex-wrap items-center justify-between gap-3">
    <h2 id="delivery-title" class="text-lg font-semibold">{$t('delivery.heading')}</h2>
    <button type="button" class="btn-outline" on:click={load} disabled={loading}>{$t('ops.refresh')}</button>
  </div>
  <p class="text-sm" style="color: rgb(var(--text-muted))">{$t('delivery.note')}</p>
  {#if error}<p role="alert" style="color: var(--danger-fg)">{$t('ops.loadFailed')}</p>{/if}
  {#if notice}<p role="status">{notice}</p>{/if}
  {#if data}
    <h3 class="font-semibold">{$t('delivery.pending')}</h3>
    <ul class="divide-y">
      {#each data.pending as row (row.id)}
        <li class="flex flex-wrap items-start justify-between gap-3 py-3">
          <div class="min-w-0 flex-1 space-y-1">
            <p class="break-words font-medium">{row.monitorName} · {$t(`delivery.event.${row.eventType}` as Parameters<typeof $t>[0])}</p>
            <p class="break-words text-sm" style="color: rgb(var(--text-muted))">{row.channels ?? $t('delivery.noChannel')}</p>
            <p class="text-sm">{row.failed ? $t('delivery.failed') : $t('delivery.waiting')}</p>
            <p class="text-xs" style="color: rgb(var(--text-muted))">{$t('delivery.since', { time: time(row.createdAt) })} · {$t('delivery.next', { time: time(row.nextAttemptAt) })}</p>
          </div>
          <button type="button" class="btn-outline" on:click={() => retry(row.id)} disabled={Boolean(retrying) || loading || (row.claimUntil ?? 0) > Date.now() / 1000}>{$t('delivery.retry')}</button>
        </li>
      {:else}<li class="py-3 text-sm">{$t('delivery.empty')}</li>{/each}
    </ul>
    {#if data.hasMore}<p class="text-sm">{$t('delivery.more')}</p>{/if}
    <h3 class="font-semibold">{$t('delivery.receipts')}</h3>
    <ul class="divide-y">
      {#each data.receipts as row (row.id)}
        <li class="flex flex-wrap justify-between gap-2 py-3 text-sm">
          <span class="min-w-0 break-words">{row.monitorName} · {row.channelName} · {$t(`delivery.event.${row.eventType}` as Parameters<typeof $t>[0])}</span>
          <time datetime={new Date(row.deliveredAt * 1000).toISOString()} style="color: rgb(var(--text-muted))">{time(row.deliveredAt)}</time>
        </li>
      {:else}<li class="py-3 text-sm">{$t('delivery.noReceipts')}</li>{/each}
    </ul>
  {:else if loading}<p role="status">{$t('ops.loading')}</p>{/if}
</section>
