<script lang="ts">
  import type { Monitor } from '$lib/api'

  export let name = ''
  export let description = ''
  export let logoUrl = ''
  export let brandColor = '#B45309'
  export let theme: 'light' | 'dark' | 'system' = 'system'
  export let showResponseTime = true
  export let showUptime = true
  export let historyDays: 7 | 30 | 60 | 90 = 90
  export let seoTitle = ''
  export let seoDescription = ''
  export let monitors: Monitor[] = []

  $: previewMonitors = monitors.slice(0, 3)
  $: previewDark = theme === 'dark'
</script>

<div class="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(320px,.9fr)]">
  <div class="space-y-5">
    <div>
      <h3 class="text-sm font-semibold">Brand and appearance</h3>
      <p class="mt-1 text-xs" style="color: rgb(var(--text-muted))">Customize the public experience without custom CSS.</p>
    </div>

    <div class="grid gap-4 sm:grid-cols-2">
      <div class="sm:col-span-2">
        <label class="label" for="sp-logo">Logo URL</label>
        <input id="sp-logo" class="input" type="url" bind:value={logoUrl} placeholder="https://example.com/logo.svg" />
      </div>
      <div>
        <label class="label" for="sp-brand-color">Brand color</label>
        <div class="flex gap-2">
          <input id="sp-brand-color" class="h-11 w-14 cursor-pointer rounded-lg border border-[rgb(var(--border))] bg-transparent p-1" type="color" bind:value={brandColor} />
          <input class="input font-mono uppercase" bind:value={brandColor} pattern="#[0-9a-fA-F]{6}" aria-label="Brand color hex value" />
        </div>
      </div>
      <div>
        <label class="label" for="sp-theme">Theme</label>
        <select id="sp-theme" class="input" bind:value={theme}>
          <option value="system">Match visitor device</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </div>
      <div>
        <label class="label" for="sp-history">History shown</label>
        <select id="sp-history" class="input" bind:value={historyDays}>
          <option value={7}>7 days</option>
          <option value={30}>30 days</option>
          <option value={60}>60 days</option>
          <option value={90}>90 days</option>
        </select>
      </div>
      <div class="space-y-2 pt-6">
        <label class="flex cursor-pointer items-center gap-2 text-sm">
          <input type="checkbox" bind:checked={showUptime} class="accent-primary" />
          Show uptime history
        </label>
        <label class="flex cursor-pointer items-center gap-2 text-sm">
          <input type="checkbox" bind:checked={showResponseTime} class="accent-primary" />
          Show response time
        </label>
      </div>
      <div class="sm:col-span-2">
        <label class="label" for="sp-seo-title">Search title</label>
        <input id="sp-seo-title" class="input" bind:value={seoTitle} maxlength="70" placeholder={name ? `${name} status` : 'Service status'} />
      </div>
      <div class="sm:col-span-2">
        <label class="label" for="sp-seo-description">Search description</label>
        <textarea id="sp-seo-description" class="input min-h-20 resize-y" bind:value={seoDescription} maxlength="160" placeholder="Live uptime and incident updates for our services."></textarea>
      </div>
    </div>
  </div>

  <div>
    <p class="label mb-2">Live preview</p>
    <div
      class="overflow-hidden rounded-2xl border shadow-sm"
      style="--preview-brand: {brandColor}; background: {previewDark ? '#111827' : '#f8fafc'}; color: {previewDark ? '#f8fafc' : '#172033'}; border-color: {previewDark ? '#334155' : '#e2e8f0'}"
    >
      <div class="h-1.5" style="background: var(--preview-brand)"></div>
      <div class="p-5">
        <div class="flex items-center gap-3">
          {#if logoUrl}
            <img src={logoUrl} alt="" class="h-9 w-9 rounded-lg object-contain" />
          {:else}
            <div class="flex h-9 w-9 items-center justify-center rounded-lg text-sm font-bold text-white" style="background: var(--preview-brand)">P</div>
          {/if}
          <div>
            <p class="font-semibold">{name || 'Your status page'}</p>
            <p class="text-xs opacity-65">{description || 'Live service availability and incident updates'}</p>
          </div>
        </div>

        <div class="my-5 rounded-xl border p-3" style="border-color: {previewDark ? '#334155' : '#e2e8f0'}; background: {previewDark ? '#172033' : '#fff'}">
          <div class="flex items-center gap-2 text-sm font-semibold text-emerald-600">
            <span class="h-2 w-2 rounded-full bg-emerald-500"></span>
            All systems operational
          </div>
        </div>

        <div class="space-y-2">
          {#each previewMonitors.length ? previewMonitors : [{ name: 'Public API', lastStatus: 'up' }, { name: 'Dashboard', lastStatus: 'up' }] as monitor}
            <div class="rounded-xl border p-3" style="border-color: {previewDark ? '#334155' : '#e2e8f0'}; background: {previewDark ? '#172033' : '#fff'}">
              <div class="flex items-center justify-between gap-3">
                <span class="text-sm font-medium">{monitor.name}</span>
                <span class="text-xs font-semibold {monitor.lastStatus === 'down' ? 'text-red-500' : 'text-emerald-600'}">{monitor.lastStatus === 'down' ? 'Major outage' : 'Operational'}</span>
              </div>
              {#if showUptime}
                <div class="mt-3 grid grid-cols-12 gap-0.5" aria-hidden="true">
                  {#each Array(12) as _}<span class="h-5 rounded-sm bg-emerald-500"></span>{/each}
                </div>
                <div class="mt-1 flex justify-between text-[10px] opacity-55"><span>{historyDays} days ago</span><span>99.99% uptime</span><span>Today</span></div>
              {/if}
              {#if showResponseTime}
                <p class="mt-2 text-[11px] opacity-60">Average response · 184 ms</p>
              {/if}
            </div>
          {/each}
        </div>
      </div>
    </div>
  </div>
</div>
