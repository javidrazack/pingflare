<script lang="ts">
  import { createEventDispatcher, onMount } from 'svelte'
  import { api } from '$lib/api'
  import type { Monitor, MonitorPayload, NotificationChannel } from '$lib/api'
  import { t } from '$lib/i18n'

  export let monitor: Partial<Monitor> = {}
  export let mode: 'create' | 'edit' = 'create'

  const dispatch = createEventDispatcher<{ saved: Monitor; cancel: void }>()

  let tab: 'http' | 'heartbeat' | 'agent' | 'dns' | 'ping' =
    (monitor.type ?? 'http') as 'http' | 'heartbeat' | 'agent' | 'dns' | 'ping'

  let name            = monitor.name ?? ''
  let tagsInput       = (() => { try { return JSON.parse(monitor.tags ?? '[]').join(', ') } catch { return '' } })()
  let interval        = monitor.interval ?? 60
  let active          = monitor.active ?? true
  let reminderHours       = monitor.reminderIntervalHours ?? ''
  let toleranceFailures   = monitor.toleranceFailures ?? 1
  let url             = monitor.url ?? ''
  let method          = monitor.method ?? 'GET'
  let body            = monitor.body ?? ''
  let headersInput    = (() => { try { const h = JSON.parse(monitor.headers ?? '{}'); return Object.entries(h).map(([k,v]) => `${k}: ${v}`).join('\n') } catch { return '' } })()
  let expectedStatus  = monitor.expectedStatus ?? 200
  let followRedirects = monitor.followRedirects ?? true
  let timeout         = monitor.timeout ?? 30
  let ipVersion       = monitor.ipVersion ?? 'auto'
  let authType        = monitor.authType ?? 'none'
  let authUsername    = monitor.authUsername ?? ''
  let authPassword    = monitor.authPassword ?? ''
  let authToken       = monitor.authToken ?? ''
  let heartbeatInterval   = monitor.heartbeatInterval ?? 60
  let heartbeatGrace      = monitor.heartbeatGrace ?? 30
  let toleranceMissed     = monitor.toleranceMissed ?? 1
  let surgeLimit          = monitor.surgeProtectionLimit ?? ''
  let sslCheckEnabled     = monitor.sslCheckEnabled ?? false
  let cacheBooster        = monitor.cacheBooster ?? false
  let jsonPath            = monitor.jsonPath ?? ''
  let expectedValue       = monitor.expectedValue ?? ''
  let cpuThreshold        = monitor.cpuThreshold ?? ''
  let ramThreshold        = monitor.ramThreshold ?? ''
  let diskThreshold       = monitor.diskThreshold ?? ''
  let dnsHostname         = monitor.dnsHostname ?? ''
  let dnsRecordType       = monitor.dnsRecordType ?? 'A'
  let dnsResolverUrl      = monitor.dnsResolverUrl ?? ''
  let dnsExpectedIp       = monitor.dnsExpectedIp ?? ''

  let selectedChannelIds: string[] = []
  let allChannels: NotificationChannel[] = []
  let loadingChannels = true
  let channelLoadError = ''

  let saving = false
  let error = ''
  let step = 1

  $: steps = [
    { number: 1, label: $t('monitorForm.stepType') },
    { number: 2, label: $t('monitorForm.stepConfigure') },
    { number: 3, label: $t('monitorForm.stepAlerting') },
    { number: 4, label: $t('monitorForm.stepReview') },
  ]

  const METHODS = ['HEAD', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']

  async function loadChannels() {
    loadingChannels = true
    channelLoadError = ''
    try {
      allChannels = await api.notifications.list()
      if (mode === 'edit' && monitor.id) {
        selectedChannelIds = await api.monitors.channels(monitor.id)
      } else {
        selectedChannelIds = allChannels.filter(ch => ch.isDefault).map(ch => ch.id)
      }
    } catch {
      channelLoadError = $t('monitorForm.channelsLoadFailed')
    } finally {
      loadingChannels = false
    }
  }

  onMount(loadChannels)

  function parseHeaders(raw: string): Record<string, string> {
    const result: Record<string, string> = {}
    for (const line of raw.split('\n')) {
      const idx = line.indexOf(':')
      if (idx > 0) result[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
    }
    return result
  }

  async function save() {
    saving = true
    error = ''
    try {
      const tags = tagsInput.split(',').map((t: string) => t.trim()).filter(Boolean)
      const base = {
        name, type: tab, active, interval,
        tags,
        reminderIntervalHours: reminderHours ? Number(reminderHours) : null,
        toleranceFailures: Number(toleranceFailures),
        channelIds: selectedChannelIds,
      }
      const payload: MonitorPayload = tab === 'http' ? {
        ...base,
        url, method, body: body || null,
        headers: parseHeaders(headersInput),
        expectedStatus: Number(expectedStatus),
        followRedirects, timeout: Number(timeout),
        ipVersion, authType,
        authUsername: authType !== 'none' ? authUsername : null,
        authPassword: authType === 'basic' || authType === 'digest' ? authPassword : null,
        authToken:    authType === 'bearer' ? authToken : null,
        sslCheckEnabled,
        cacheBooster,
        jsonPath: jsonPath || null,
        expectedValue: expectedValue || null,
      } : tab === 'dns' ? {
        ...base,
        timeout: Number(timeout),
        dnsHostname,
        dnsRecordType,
        dnsResolverUrl,
        dnsExpectedIp: dnsExpectedIp || null,
      } : tab === 'ping' ? {
        ...base,
        url,
        timeout: Number(timeout),
      } : {
        ...base,
        heartbeatInterval: Number(heartbeatInterval),
        heartbeatGrace: Number(heartbeatGrace),
        toleranceMissed: Number(toleranceMissed),
        surgeProtectionLimit: surgeLimit ? Number(surgeLimit) : null,
        cpuThreshold: cpuThreshold ? Number(cpuThreshold) : null,
        ramThreshold: ramThreshold ? Number(ramThreshold) : null,
        diskThreshold: diskThreshold ? Number(diskThreshold) : null,
      }

      let result: Monitor
      if (mode === 'edit' && monitor.id) {
        result = await api.monitors.update(monitor.id, payload)
      } else {
        result = await api.monitors.create(payload)
      }
      dispatch('saved', result)
    } catch (e) {
      error = String(e)
    } finally {
      saving = false
    }
  }

  function toggleChannel(id: string) {
    selectedChannelIds = selectedChannelIds.includes(id)
      ? selectedChannelIds.filter(c => c !== id)
      : [...selectedChannelIds, id]
  }

  function nextStep() {
    error = ''
    if (step === 2) {
      if (!name.trim()) {
        error = $t('monitorForm.nameRequired')
        return
      }
      if ((tab === 'http' || tab === 'ping') && !url.trim()) {
        error = $t('monitorForm.urlRequired')
        return
      }
      if (tab === 'dns' && (!dnsResolverUrl.trim() || !dnsHostname.trim())) {
        error = $t('monitorForm.dnsRequired')
        return
      }
    }
    step = Math.min(4, step + 1)
  }
</script>

<form on:submit|preventDefault={save} class="space-y-6">
  {#if mode === 'create'}
  <ol class="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label={$t('monitorForm.setupProgress')}>
    {#each steps as item}
      <li aria-current={step === item.number ? 'step' : undefined}>
        <button
          type="button"
          class="min-h-11 w-full rounded-lg border p-2 text-left transition-colors {step === item.number ? 'border-primary bg-primary-soft' : step > item.number ? 'bg-[rgb(var(--bg-subtle))]' : ''}"
          disabled={item.number > step}
          on:click={() => step = item.number}
        >
          <span class="block text-[11px] font-semibold uppercase tracking-wide" style="color: rgb(var(--text-muted))">{$t('monitorForm.stepNumber', { number: item.number })}</span>
          <span class="block text-sm font-semibold">{item.label}</span>
        </button>
      </li>
    {/each}
  </ol>
  {/if}

  {#if mode === 'create' && step === 1}
  <section aria-labelledby="monitor-type-title" class="space-y-4">
    <div>
      <h2 id="monitor-type-title" class="text-lg font-semibold">{$t('monitorForm.typePrompt')}</h2>
      <p class="mt-1 text-sm" style="color: rgb(var(--text-muted))">{$t('monitorForm.typePromptDesc')}</p>
    </div>
  <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
    <button
      type="button"
      class="monitor-type-option min-h-24 rounded-xl border p-4 text-left text-sm font-medium"
      class:monitor-type-option-active={tab === 'http'}
      on:click={() => { tab = 'http' }}
    ><span class="block text-base font-semibold">{$t('monitorForm.httpCheck')}</span><span class="mt-1 block text-xs opacity-80">{$t('monitorForm.httpDesc')}</span></button>
    <button
      type="button"
      class="monitor-type-option min-h-24 rounded-xl border p-4 text-left text-sm font-medium"
      class:monitor-type-option-active={tab === 'heartbeat'}
      on:click={() => { tab = 'heartbeat' }}
    ><span class="block text-base font-semibold">{$t('monitorForm.heartbeat')}</span><span class="mt-1 block text-xs opacity-80">{$t('monitorForm.heartbeatDesc')}</span></button>
    <button
      type="button"
      class="monitor-type-option min-h-24 rounded-xl border p-4 text-left text-sm font-medium"
      class:monitor-type-option-active={tab === 'agent'}
      on:click={() => { tab = 'agent' }}
    ><span class="block text-base font-semibold">{$t('monitorForm.agent')}</span><span class="mt-1 block text-xs opacity-80">{$t('monitorForm.agentDesc')}</span></button>
    <button
      type="button"
      class="monitor-type-option min-h-24 rounded-xl border p-4 text-left text-sm font-medium"
      class:monitor-type-option-active={tab === 'dns'}
      on:click={() => { tab = 'dns' }}
    ><span class="block text-base font-semibold">{$t('monitorForm.dns')}</span><span class="mt-1 block text-xs opacity-80">{$t('monitorForm.dnsDesc')}</span></button>
    <button
      type="button"
      class="monitor-type-option min-h-24 rounded-xl border p-4 text-left text-sm font-medium"
      class:monitor-type-option-active={tab === 'ping'}
      on:click={() => { tab = 'ping' }}
    ><span class="block text-base font-semibold">{$t('monitorForm.ping')}</span><span class="mt-1 block text-xs opacity-80">{$t('monitorForm.pingDesc')}</span></button>
  </div>
  </section>
  {/if}

  {#if mode === 'edit' || step === 2}
  <div class="grid grid-cols-2 gap-4">
    <div class="col-span-2">
      <label for="m-name" class="label">{$t('monitorForm.name')}</label>
      <input id="m-name" class="input" bind:value={name} required placeholder="My API" />
    </div>
    <div>
      <label for="m-tags" class="label">{$t('monitorForm.tags')}</label>
      <input id="m-tags" class="input" bind:value={tagsInput} placeholder="prod, api" />
    </div>
    <div>
      <label for="m-interval" class="label">{$t('monitorForm.interval')}</label>
      <input id="m-interval" class="input" type="number" bind:value={interval} min="60" required />
    </div>
  </div>

  {#if tab === 'http'}
  <div class="space-y-4">
    <h3 class="text-sm font-semibold text-[rgb(var(--text-muted))] uppercase tracking-wide">{$t('monitorForm.sectionRequest')}</h3>
    <div class="flex gap-2">
      <div class="w-36">
        <label for="m-method" class="label">{$t('monitorForm.method')}</label>
        <select id="m-method" class="input" bind:value={method}>
          {#each METHODS as m}<option>{m}</option>{/each}
        </select>
      </div>
      <div class="flex-1">
        <label for="m-url" class="label">{$t('monitorForm.url')}</label>
        <input id="m-url" class="input font-mono text-xs" bind:value={url} required placeholder="https://example.com/api" />
      </div>
    </div>

    <div class="grid grid-cols-3 gap-4">
      <div>
        <label for="m-status" class="label">{$t('monitorForm.expectedStatus')}</label>
        <input id="m-status" class="input" type="number" bind:value={expectedStatus} />
      </div>
      <div>
        <label for="m-timeout" class="label">{$t('monitorForm.timeout')}</label>
        <input id="m-timeout" class="input" type="number" bind:value={timeout} min="1" max="60" />
      </div>
      <div>
        <label for="m-ip" class="label">{$t('monitorForm.ipVersion')}</label>
        <select id="m-ip" class="input" bind:value={ipVersion}>
          <option value="auto">{$t('monitorForm.ipAuto')}</option>
          <option value="ipv4">IPv4</option>
          <option value="ipv6">IPv6</option>
        </select>
      </div>
    </div>

    <div class="flex flex-wrap gap-x-6 gap-y-2">
      <div class="flex min-h-11 items-center gap-2">
        <input type="checkbox" id="follow" bind:checked={followRedirects} class="accent-primary" />
        <label for="follow" class="text-sm">{$t('monitorForm.followRedirects')}</label>
      </div>
      <div class="flex min-h-11 items-center gap-2">
        <input type="checkbox" id="ssl-check" bind:checked={sslCheckEnabled} class="accent-primary" />
        <label for="ssl-check" class="text-sm">{$t('monitorForm.sslCheck')}</label>
      </div>
      <div class="flex min-h-11 items-center gap-2">
        <input type="checkbox" id="cache-booster" bind:checked={cacheBooster} class="accent-primary" />
        <label for="cache-booster" class="text-sm">{$t('monitorForm.cacheBuster')}</label>
      </div>
    </div>

    <div>
      <label for="m-auth" class="label">{$t('monitorForm.authentication')}</label>
      <select id="m-auth" class="input w-auto" bind:value={authType}>
        <option value="none">{$t('monitorForm.authNone')}</option>
        <option value="basic">{$t('monitorForm.authBasic')}</option>
        <option value="digest">{$t('monitorForm.authDigest')}</option>
        <option value="bearer">{$t('monitorForm.authBearer')}</option>
      </select>
    </div>
    {#if authType === 'basic' || authType === 'digest'}
    <div class="grid grid-cols-2 gap-4">
      <div>
        <label for="m-auth-user" class="label">{$t('monitorForm.authUsername')}</label>
        <input id="m-auth-user" class="input" bind:value={authUsername} />
      </div>
      <div>
        <label for="m-auth-pass" class="label">{$t('monitorForm.authPassword')}</label>
        <input id="m-auth-pass" class="input" type="password" bind:value={authPassword} />
      </div>
    </div>
    {/if}
    {#if authType === 'bearer'}
    <div>
      <label for="m-auth-token" class="label">{$t('monitorForm.bearerToken')}</label>
      <input id="m-auth-token" class="input font-mono text-xs" type="password" bind:value={authToken} />
    </div>
    {/if}

    <div>
      <label for="m-headers" class="label">{$t('monitorForm.headers')}</label>
      <textarea id="m-headers" class="input font-mono text-xs h-20 resize-none" bind:value={headersInput} placeholder="X-API-Key: mykey&#10;Accept: application/json"></textarea>
    </div>

    {#if ['POST', 'PUT', 'PATCH'].includes(method)}
    <div>
      <label for="m-body" class="label">{$t('monitorForm.requestBody')}</label>
      <textarea id="m-body" class="input font-mono text-xs h-20 resize-none" bind:value={body} placeholder='&#123;"key": "value"&#125;'></textarea>
    </div>
    {/if}

    <div class="grid grid-cols-2 gap-4">
      <div>
        <label for="m-json-path" class="label">{$t('monitorForm.jsonPath')}</label>
        <input id="m-json-path" class="input font-mono text-xs" bind:value={jsonPath} placeholder="$.data.status" />
      </div>
      <div>
        <label for="m-expected-value" class="label">{$t('monitorForm.expectedValue')}</label>
        <input id="m-expected-value" class="input font-mono text-xs" bind:value={expectedValue} placeholder="ok" disabled={!jsonPath} />
      </div>
    </div>
  </div>
  {/if}

  {#if tab === 'ping'}
  <div class="space-y-4">
    <h3 class="text-sm font-semibold text-[rgb(var(--text-muted))] uppercase tracking-wide">{$t('monitorForm.sectionPing')}</h3>
    <div>
      <label for="ping-url" class="label">{$t('monitorForm.pingUrl')}</label>
      <input id="ping-url" class="input font-mono text-xs" bind:value={url} required placeholder="https://example.com" />
    </div>
    <div>
      <label for="ping-timeout" class="label">{$t('monitorForm.timeout')}</label>
      <input id="ping-timeout" class="input" type="number" bind:value={timeout} min="1" max="60" />
    </div>
  </div>
  {/if}

  {#if tab === 'heartbeat' || tab === 'agent'}
  <div class="space-y-4">
    <h3 class="text-sm font-semibold text-[rgb(var(--text-muted))] uppercase tracking-wide">{$t('monitorForm.sectionHeartbeat')}</h3>
    <div class="grid grid-cols-2 gap-4">
      <div>
        <label for="hb-interval" class="label">{$t('monitorForm.expectedEvery')}</label>
        <input id="hb-interval" class="input" type="number" bind:value={heartbeatInterval} min="60" />
      </div>
      <div>
        <label for="hb-grace" class="label">{$t('monitorForm.gracePeriod')}</label>
        <input id="hb-grace" class="input" type="number" bind:value={heartbeatGrace} min="0" />
      </div>
      <div>
        <label for="hb-tolerance" class="label">{$t('monitorForm.tolerateMissed')}</label>
        <input id="hb-tolerance" class="input" type="number" bind:value={toleranceMissed} min="1" />
      </div>
      <div>
        <label for="hb-surge" class="label">{$t('monitorForm.surgeProtection')}</label>
        <input id="hb-surge" class="input" type="number" bind:value={surgeLimit} min="1" placeholder={$t('monitorForm.disabled')} />
      </div>
    </div>
  </div>
  {/if}

  {#if tab === 'agent'}
  <div class="space-y-4 mt-6">
    <h3 class="text-sm font-semibold text-[rgb(var(--text-muted))] uppercase tracking-wide">{$t('monitorForm.infrastructureThresholds')}</h3>
    <div class="grid grid-cols-3 gap-4">
      <div>
        <label for="cpu-thresh" class="label">{$t('monitorForm.cpuMax')}</label>
        <input id="cpu-thresh" class="input" type="number" bind:value={cpuThreshold} min="1" max="100" placeholder={$t('monitorForm.thresholdExample')} />
      </div>
      <div>
        <label for="ram-thresh" class="label">{$t('monitorForm.ramMax')}</label>
        <input id="ram-thresh" class="input" type="number" bind:value={ramThreshold} min="1" max="100" placeholder={$t('monitorForm.thresholdExample')} />
      </div>
      <div>
        <label for="disk-thresh" class="label">{$t('monitorForm.diskMax')}</label>
        <input id="disk-thresh" class="input" type="number" bind:value={diskThreshold} min="1" max="100" placeholder={$t('monitorForm.thresholdExample')} />
      </div>
    </div>
  </div>
  {/if}

  {#if tab === 'dns'}
  <div class="space-y-4">
    <h3 class="text-sm font-semibold text-[rgb(var(--text-muted))] uppercase tracking-wide">{$t('monitorForm.sectionDns')}</h3>
    <div>
      <label for="dns-resolver" class="label">{$t('monitorForm.dnsResolverUrl')}</label>
      <input id="dns-resolver" class="input font-mono text-xs" bind:value={dnsResolverUrl} required
        placeholder="https://freedns.controld.com/p0" />
    </div>
    <div class="grid grid-cols-2 gap-4">
      <div>
        <label for="dns-hostname" class="label">{$t('monitorForm.dnsHostname')}</label>
        <input id="dns-hostname" class="input font-mono text-xs" bind:value={dnsHostname} required
          placeholder="example.com" />
      </div>
      <div>
        <label for="dns-record" class="label">{$t('monitorForm.dnsRecordType')}</label>
        <select id="dns-record" class="input" bind:value={dnsRecordType}>
          {#each ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS'] as rt}
            <option value={rt}>{rt}</option>
          {/each}
        </select>
      </div>
    </div>
    <div>
      <label for="dns-expected" class="label">{$t('monitorForm.dnsExpectedIp')}</label>
      <input id="dns-expected" class="input font-mono text-xs" bind:value={dnsExpectedIp}
        placeholder={$t('monitorForm.dnsExpectedIpPlaceholder')} />
      <p class="text-xs mt-1" style="color: rgb(var(--text-muted))">{$t('monitorForm.dnsExpectedIpHint')}</p>
    </div>
    <div>
      <label for="dns-timeout" class="label">{$t('monitorForm.timeout')}</label>
      <input id="dns-timeout" class="input" type="number" bind:value={timeout} min="1" max="60" />
    </div>
  </div>
  {/if}
  {/if}

  {#if mode === 'edit' || step === 3}
  <div class="space-y-4">
    <h3 class="text-sm font-semibold text-[rgb(var(--text-muted))] uppercase tracking-wide">{$t('monitorForm.sectionAlerts')}</h3>
    <div class="grid grid-cols-2 gap-4">
      <div>
        <label for="m-tolerance" class="label">{$t('monitorForm.tolerateFailures')}</label>
        <input id="m-tolerance" class="input" type="number" bind:value={toleranceFailures} min="1" />
      </div>
      <div>
        <label for="m-reminder" class="label">{$t('monitorForm.reminder')}</label>
        <input id="m-reminder" class="input" type="number" bind:value={reminderHours} min="1" placeholder={$t('monitorForm.disabled')} />
      </div>
    </div>
  </div>

  <div class="space-y-3">
    <h3 class="text-sm font-semibold text-[rgb(var(--text-muted))] uppercase tracking-wide">{$t('monitorForm.sectionNotifications')}</h3>
    {#if loadingChannels}
      <p class="text-sm" role="status" aria-live="polite" style="color: rgb(var(--text-muted))">
        {$t('monitorForm.loadingChannels')}
      </p>
    {:else if channelLoadError}
      <div class="alert items-center text-sm" role="alert"
        style="background: rgb(var(--warning-bg)); color: var(--warning-fg)">
        <span class="min-w-0 flex-1">{channelLoadError}</span>
        <button type="button" class="btn-outline shrink-0 text-inherit" on:click={loadChannels}>
          {$t('monitorForm.retryChannels')}
        </button>
      </div>
    {:else if allChannels.length === 0}
      <p class="text-sm" style="color: rgb(var(--text-muted))">
        {$t('monitorForm.noChannels')} <a href="/settings" class="underline" style="color: var(--color-primary)">{$t('monitorForm.addOne')}</a>.
      </p>
    {:else}
      <div class="grid grid-cols-2 gap-2">
        {#each allChannels as ch}
          <label class="flex min-h-11 items-center gap-2 cursor-pointer text-sm p-2 hover:bg-[rgb(var(--bg-subtle))]">
            <input type="checkbox"
              checked={selectedChannelIds.includes(ch.id)}
              on:change={() => toggleChannel(ch.id)}
              class="accent-primary"
            />
            {ch.name}
          </label>
        {/each}
      </div>
    {/if}
  </div>
  {/if}

  {#if mode === 'create' && step === 4}
    <section aria-labelledby="monitor-review-title" class="space-y-4">
      <div>
        <h2 id="monitor-review-title" class="text-lg font-semibold">{$t('monitorForm.reviewTitle')}</h2>
        <p class="mt-1 text-sm" style="color: rgb(var(--text-muted))">{$t('monitorForm.reviewDesc')}</p>
      </div>
      <dl class="card divide-y p-0" style="border-color: var(--border-color)">
        <div class="grid grid-cols-3 gap-4 p-4">
          <dt class="text-sm" style="color: rgb(var(--text-muted))">{$t('monitorForm.reviewMonitor')}</dt>
          <dd class="col-span-2 text-sm font-semibold">{name}</dd>
        </div>
        <div class="grid grid-cols-3 gap-4 p-4">
          <dt class="text-sm" style="color: rgb(var(--text-muted))">{$t('monitorForm.reviewType')}</dt>
          <dd class="col-span-2 text-sm font-semibold uppercase">{tab}</dd>
        </div>
        <div class="grid grid-cols-3 gap-4 p-4">
          <dt class="text-sm" style="color: rgb(var(--text-muted))">{$t('monitorForm.reviewTarget')}</dt>
          <dd class="col-span-2 break-all font-mono text-sm">{tab === 'dns' ? dnsHostname : tab === 'heartbeat' || tab === 'agent' ? $t('monitorForm.reviewHeartbeatTarget', { seconds: heartbeatInterval }) : url}</dd>
        </div>
        <div class="grid grid-cols-3 gap-4 p-4">
          <dt class="text-sm" style="color: rgb(var(--text-muted))">{$t('monitorForm.reviewScheduleLabel')}</dt>
          <dd class="col-span-2 text-sm">{$t('monitorForm.reviewSchedule', { interval, failures: toleranceFailures, unit: toleranceFailures === 1 ? $t('monitorForm.check') : $t('monitorForm.checks') })}</dd>
        </div>
        <div class="grid grid-cols-3 gap-4 p-4">
          <dt class="text-sm" style="color: rgb(var(--text-muted))">{$t('monitorForm.reviewNotifications')}</dt>
          <dd class="col-span-2 text-sm">{selectedChannelIds.length ? $t('monitorForm.channelCount', { count: selectedChannelIds.length, unit: selectedChannelIds.length === 1 ? $t('monitorForm.channel') : $t('monitorForm.channels') }) : $t('monitorForm.noChannelSelected')}</dd>
        </div>
      </dl>
    </section>
  {/if}

  {#if error}
    <p class="alert alert-danger text-sm" role="alert">{error}</p>
  {/if}

  <div class="flex gap-2 pt-1">
    {#if mode === 'edit'}
      <button type="submit" class="btn-primary" disabled={saving}>
        {saving ? $t('monitorForm.saving') : $t('monitorForm.saveChanges')}
      </button>
    {:else}
      {#if step > 1}
        <button type="button" class="btn-outline" on:click={() => step -= 1}>{$t('monitorForm.back')}</button>
      {/if}
      {#if step < 4}
        <button type="button" class="btn-primary" on:click={nextStep}>{$t('monitorForm.continue')}</button>
      {:else}
        <button type="submit" class="btn-primary" disabled={saving}>
          {saving ? $t('monitorForm.saving') : $t('monitorForm.createMonitor')}
        </button>
      {/if}
    {/if}
    <button type="button" class="btn-outline ml-auto" on:click={() => dispatch('cancel')}>{$t('monitorForm.cancel')}</button>
  </div>
</form>

<style>
  .monitor-type-option {
    display: block;
    width: 100%;
    background: rgb(var(--card));
    color: rgb(var(--text));
    transition: background-color 180ms ease, border-color 180ms ease, color 180ms ease;
  }

  .monitor-type-option:hover {
    background: rgb(var(--bg-subtle));
    border-color: color-mix(in srgb, var(--color-primary) 38%, var(--border-color));
  }

  .monitor-type-option-active,
  .monitor-type-option-active:hover {
    background: var(--color-primary-solid);
    border-color: var(--color-primary-solid);
    color: white;
  }
</style>
