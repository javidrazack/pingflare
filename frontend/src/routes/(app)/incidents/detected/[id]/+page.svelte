<script lang="ts">
  import { onMount } from 'svelte'
  import { page } from '$app/stores'
  import { api, ApiError, type DetectedIncidentDetail } from '$lib/api'
  import { t, locale } from '$lib/i18n'
  import { formatDuration } from '$lib/utils'
  import HeaderPattern from '$lib/components/HeaderPattern.svelte'
  import StatusBadge from '$lib/components/StatusBadge.svelte'
  import Icon from '$lib/components/Icon.svelte'

  let data: DetectedIncidentDetail | null = null
  let loading = true
  let error: 'missing' | 'failed' | '' = ''
  let eventId = ''
  let sequence = 0
  async function load(id: string) {
    const request = ++sequence
    loading = true
    error = ''
    try {
      const result = await api.incidents.detectedDetail(id)
      if (request === sequence) data = result
    } catch (e) {
      if (request === sequence) error = e instanceof ApiError && e.status === 404 ? 'missing' : 'failed'
    } finally { if (request === sequence) loading = false }
  }
  onMount(() => {
    const unsubscribe = page.subscribe(value => {
      if (value.params.id && value.params.id !== eventId) {
        eventId = value.params.id
        data = null
        void load(eventId)
      }
    })
    return () => { sequence++; unsubscribe() }
  })
  function time(value: number) {
    return new Date(value * 1000).toLocaleString($locale, { dateStyle: 'medium', timeStyle: 'medium' })
  }
  function date(value: number) { return new Date(value * 1000).toLocaleDateString($locale, { dateStyle: 'medium' }) }
  function clock(value: number) { return new Date(value * 1000).toLocaleTimeString($locale, { timeStyle: 'medium' }) }
  function message(value: string | null) {
    if (!value?.trim()) return $t('event.noMessage')
    return value.startsWith('notify.') ? $t(value as Parameters<typeof $t>[0]) : value
  }
  $: failure = data?.evidence.find(item => item.status === 'down')
  $: timeline = data ? [...data.evidence,
    ...(data.recovery && !data.evidence.some(item => item.id === data?.recovery?.id) ? [data.recovery] : [])] : []
</script>

<svelte:head><title>{data ? `${data.monitorName} · ` : ''}{$t('event.heading')} - Pingflare</title></svelte:head>

<div class="relative overflow-hidden" style="border-bottom: 1px solid var(--border-color)">
  <HeaderPattern />
  <div class="relative mx-auto max-w-5xl px-4 py-6 md:px-8 md:py-8">
    <a class="btn-outline" href="/incidents"><Icon name="arrow-left" size={16} />{$t('event.back')}</a>
    <div class="mt-4 flex flex-wrap items-start justify-between gap-4">
      <div class="min-w-0 basis-full sm:basis-0 sm:flex-1">
        <div class="flex flex-wrap items-center gap-3">
          <h1 class="event-name text-2xl font-semibold tracking-tight md:text-3xl">{data?.monitorName ?? $t('event.heading')}</h1>
          {#if data}<span class="badge {data.resolvedAt !== null ? 'badge-up' : 'badge-down'}">{data.resolvedAt !== null ? $t('incidents.recovered') : $t('incidents.ongoing')}</span>{/if}
        </div>
        {#if data}<p class="mt-2 text-sm muted">{$t('event.heading')} · {time(data.startedAt)}</p>{/if}
      </div>
      {#if data}
        <div class="flex flex-wrap gap-2">
          <button class="btn-outline" disabled={loading} on:click={() => load(eventId)}>
            <Icon name="arrow-path" size={16} />{loading ? $t('event.refreshing') : $t('ops.refresh')}
          </button>
          <a class="btn-outline" href="/monitors/{encodeURIComponent(data.monitorId)}">{$t('event.monitor')}</a>
        </div>
      {/if}
    </div>
  </div>
</div>
<div class="mx-auto max-w-5xl px-4 py-6 md:px-8 md:py-8" aria-busy={loading}>
  {#if loading && !data}
    <div class="loading-state" role="status"><Icon name="clock" size={22} /><p>{$t('event.loading')}</p></div>
  {:else}
    {#if error}
      <div class="error-state mb-6" role="alert">
        <Icon name="exclamation-triangle" size={20} />
        <div class="min-w-0 flex-1"><p>{error === 'missing' ? $t('event.missing') : $t('event.failed')}</p>
          {#if data}<p class="mt-1 text-sm">{$t('event.previousSnapshot')}</p>{/if}
        </div>
        {#if error === 'failed'}<button class="btn-outline" disabled={loading} on:click={() => load(eventId)}>{$t('ops.refresh')}</button>{/if}
      </div>
    {/if}
    {#if data}
      <div class="event-overview">
        <div class="event-story">
          <section aria-labelledby="event-what" class="story-section">
            <div class="story-icon" style="color: var(--danger-fg); background: rgb(var(--danger-bg))"><Icon name="exclamation-triangle" size={20} /></div>
            <div class="min-w-0">
              <h2 id="event-what" class="text-base font-semibold">{$t('event.what')}</h2>
              <p class="mt-2 whitespace-pre-wrap break-words text-base leading-relaxed">{failure ? message(failure.message) : $t('event.noEvidence')}</p>
              <p class="mt-3 text-sm muted">{$t('event.observationNote')}</p>
            </div>
          </section>
          {#if data.resolvedAt !== null}
            <section aria-labelledby="event-recovery" class="story-section recovery-section">
              <div class="story-icon" style="color: var(--success-fg); background: rgb(var(--success-bg))"><Icon name="check-circle" size={20} /></div>
              <div class="min-w-0"><h2 id="event-recovery" class="text-base font-semibold">{$t('event.recovery')}</h2>
                <p class="mt-2 whitespace-pre-wrap break-words leading-relaxed">{data.recovery ? message(data.recovery.message) : $t('event.noRecoveryEvidence')}</p>
              </div>
            </section>
          {:else}
            <section class="story-section recovery-section" aria-labelledby="event-waiting">
              <div class="story-icon muted"><Icon name="clock" size={20} /></div>
              <div><h2 id="event-waiting" class="text-base font-semibold">{$t('event.awaitingRecovery')}</h2><p class="mt-2 text-sm muted">{$t('event.refreshHint')}</p></div>
            </section>
          {/if}
        </div>
        <aside class="event-timing" aria-label={$t('event.timing')}>
          <h2 class="mb-5 text-base font-semibold">{$t('event.timing')}</h2>
          <dl class="space-y-5">
            <div><dt class="text-sm muted">{$t('event.started')}</dt><dd class="mt-1 text-sm tabular-nums"><time datetime={new Date(data.startedAt * 1000).toISOString()}><span class="block">{date(data.startedAt)}</span><span class="mt-0.5 block muted">{clock(data.startedAt)}</span></time></dd></div>
            <div><dt class="text-sm muted">{$t('event.recoveredAt')}</dt><dd class="mt-1 text-sm tabular-nums">{#if data.resolvedAt !== null}<time datetime={new Date(data.resolvedAt * 1000).toISOString()}><span class="block">{date(data.resolvedAt)}</span><span class="mt-0.5 block muted">{clock(data.resolvedAt)}</span></time>{:else}{$t('event.notRecovered')}{/if}</dd></div>
            <div><dt class="text-sm muted">{data.resolvedAt !== null ? $t('event.duration') : $t('event.elapsed')}</dt><dd class="mt-1 font-medium tabular-nums">{formatDuration(data.durationSeconds ?? Math.max(0, (data.resolvedAt ?? data.observedAt) - data.startedAt))}</dd></div>
          </dl>
        </aside>
      </div>
      <details class="evidence-disclosure mt-6">
        <summary class="evidence-summary">
          <span><span class="block font-semibold">{$t('event.evidence')}</span><span class="mt-1 block text-sm font-normal muted">{$t('event.expandEvidence', { count: timeline.length })}</span></span>
        </summary>
        <div class="evidence-content">
          <p class="max-w-prose text-sm muted">{$t('event.retentionNote')}</p>
          {#if timeline.length}
            <ol class="mt-4">
              {#each timeline as item (item.id)}
                <li class="evidence-row">
                  <div class="flex flex-wrap items-center gap-3 text-sm">
                    <StatusBadge status={item.status} />
                    <time class="tabular-nums muted" datetime={new Date(item.checkedAt * 1000).toISOString()}>{time(item.checkedAt)}</time>
                    {#if item.responseTimeMs !== null}<span class="muted">{item.responseTimeMs} ms</span>{/if}
                  </div>
                  <p class="mt-2 max-w-prose whitespace-pre-wrap break-words text-sm leading-relaxed">{message(item.message)}</p>
                </li>
              {/each}
            </ol>
          {:else}<p class="mt-4 text-sm">{$t('event.noEvidence')}</p>{/if}
          {#if data.hasMore}<p class="mt-3 text-sm muted">{$t('event.more')}</p>{/if}
        </div>
      </details>
      <p class="mt-5 text-xs muted" role="status">{$t('event.asOf', { time: time(data.observedAt) })}</p>
    {/if}
  {/if}
</div>

<style>
  .event-name { min-width: 0; overflow-wrap: anywhere; }
  .story-section p, .evidence-row p { overflow-wrap: anywhere; }
  .muted { color: rgb(var(--text-muted)); }
  .event-overview { display: grid; grid-template-columns: minmax(0, 1fr) 15rem; border: 1px solid var(--border-color); border-radius: .75rem; background: rgb(var(--card)); overflow: hidden; }
  .event-story { padding: 1.5rem; }
  .story-section { display: flex; align-items: flex-start; gap: .875rem; }
  .story-icon { display: flex; align-items: center; justify-content: center; flex: 0 0 2.25rem; height: 2.25rem; border-radius: .5rem; }
  .recovery-section { margin-top: 1.5rem; padding-top: 1.5rem; border-top: 1px solid var(--border-color); }
  .event-timing { padding: 1.5rem; border-left: 1px solid var(--border-color); background: rgb(var(--bg-subtle)); }
  .evidence-disclosure { border: 1px solid var(--border-color); border-radius: .75rem; background: rgb(var(--card)); }
  .evidence-summary { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: 1.25rem 1.5rem; cursor: pointer; list-style: none; border-radius: .75rem; }
  .evidence-summary::-webkit-details-marker { display: none; }
  .evidence-summary::after { content: ''; flex: 0 0 .5rem; width: .5rem; height: .5rem; border-right: 1.5px solid currentColor; border-bottom: 1.5px solid currentColor; transform: rotate(45deg); transition: transform 160ms ease; margin-right: .125rem; }
  .evidence-disclosure[open] > summary::after { transform: rotate(225deg); }
  .evidence-summary:focus-visible { outline-offset: -4px; }
  @media (prefers-reduced-motion: reduce) { .evidence-summary::after { transition: none; } }
  .evidence-summary:hover { color: var(--color-primary); }
  .evidence-content { padding: 0 1.5rem 1.5rem; }
  .evidence-row { padding: 1rem 0; border-bottom: 1px solid var(--border-color); }
  .evidence-row:last-child { border-bottom: 0; padding-bottom: 0; }
  .loading-state { display: flex; align-items: center; gap: .75rem; padding: 2rem 0; color: rgb(var(--text-muted)); }
  .error-state { display: flex; flex-wrap: wrap; align-items: center; gap: .75rem; padding: 1rem; border-radius: .75rem; background: rgb(var(--danger-bg)); color: var(--danger-fg); }
  @media (max-width: 767px) {
    .event-overview { grid-template-columns: minmax(0, 1fr); }
    .event-timing { border-left: 0; border-top: 1px solid var(--border-color); }
    .event-timing dl { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1.25rem; }
    .event-timing dl > div { margin-top: 0; }
    .event-story, .event-timing { padding: 1.25rem; }
    .evidence-content { padding: 0 1.25rem 1.25rem; }
  }
</style>
