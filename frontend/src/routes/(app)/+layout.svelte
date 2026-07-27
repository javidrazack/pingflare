<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import { goto } from '$app/navigation'
  import { page } from '$app/stores'
  import { theme, monitors } from '$lib/stores'
  import { t } from '$lib/i18n'
  import Icon from '$lib/components/Icon.svelte'

  const APP_VERSION = __APP_VERSION__
  const GITHUB_REPO = 'javidrazack/pingflare'

  function isNewer(remote: string, local: string): boolean {
    const parse = (v: string) => {
      const [main, pre] = v.split('-')
      const [major, minor, patch] = main.split('.').map(Number)
      let preNum = Infinity
      if (pre) {
        const m = pre.match(/(\d+)$/)
        preNum = m ? parseInt(m[1]) : 0
      }
      return [major, minor, patch, preNum] as const
    }
    const r = parse(remote)
    const l = parse(local)
    for (let i = 0; i < 4; i++) {
      if (r[i] > l[i]) return true
      if (r[i] < l[i]) return false
    }
    return false
  }

  let countdown = 10
  let countTicker: ReturnType<typeof setInterval>
  let updateAvailable = false
  let latestVersion = ''
  let menuOpen = false
  let sidebarCollapsed = false

  onMount(async () => {
    if (!localStorage.getItem('token')) goto('/login')
    countTicker = setInterval(() => {
      countdown = countdown <= 1 ? 10 : countdown - 1
    }, 1000)

    const cacheKey = 'pf_latest_version'
    const cached = sessionStorage.getItem(cacheKey)
    if (cached) {
      latestVersion = cached
      updateAvailable = isNewer(cached, APP_VERSION)
    } else {
      try {
        const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=1`, {
          headers: { Accept: 'application/vnd.github+json' },
        })
        if (res.ok) {
          const data = await res.json()
          if (Array.isArray(data) && data.length > 0) {
            latestVersion = (data[0].tag_name as string).replace(/^v/, '')
            sessionStorage.setItem(cacheKey, latestVersion)
            updateAvailable = isNewer(latestVersion, APP_VERSION)
          }
        }
      } catch {
        // Silently ignore
      }
    }
  })
  onDestroy(() => clearInterval(countTicker))

  function logout() {
    localStorage.removeItem('token')
    goto('/login')
  }

  $: nav = [
    { href: '/',          label: $t('nav.dashboard'),     icon: 'home'                 },
    { href: '/monitors',  label: $t('nav.monitors'),      icon: 'signal'               },
    { href: '/status',    label: $t('nav.statusPages'),   icon: 'globe'                },
    { href: '/incidents', label: $t('nav.incidents'),     icon: 'exclamation-triangle' },
    { href: '/settings',  label: $t('nav.notifications'), icon: 'bell'                 },
    { href: '/config',    label: $t('nav.config'),        icon: 'cog'                  },
  ]

  function isActive(href: string, pathname: string) {
    if (href === '/') return pathname === '/'
    return pathname.startsWith(href)
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') menuOpen = false
  }

  $: if ($page.url.pathname) menuOpen = false

  $: {
    if (typeof document !== 'undefined') {
      const anyDown    = $monitors.some(m => m.lastStatus === 'down')
      const anyPending = $monitors.length > 0 && $monitors.some(m => m.lastStatus === 'pending')
      const color = anyDown ? '#ef4444' : anyPending ? '#f97316' : '#22c55e'
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="14" fill="${color}"/></svg>`
      const dataUrl = `data:image/svg+xml,${encodeURIComponent(svg)}`
      let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
      if (!link) {
        link = document.createElement('link')
        link.rel = 'icon'
        link.type = 'image/svg+xml'
        document.head.appendChild(link)
      }
      link.href = dataUrl
    }
  }
</script>

<svelte:head>
  <meta name="robots" content="noindex, nofollow" />
</svelte:head>

<svelte:window on:keydown={handleKeydown} />

<a href="#main-content"
  class="bg-primary-solid fixed left-3 top-3 z-[100] -translate-y-20 rounded-lg px-4 py-2 text-sm font-semibold focus:translate-y-0">
  Skip to content
</a>

<div class="min-h-dvh lg:flex" style="background-color: rgb(var(--bg))">
  <aside
    class="hidden lg:fixed lg:inset-y-0 lg:left-0 lg:z-30 lg:flex lg:flex-col"
    class:w-20={sidebarCollapsed}
    class:w-64={!sidebarCollapsed}
    style="background-color: rgb(var(--bg-subtle)); border-right: 1px solid var(--border-color)"
    aria-label="Primary navigation">
    <div class="flex h-16 items-center gap-3 px-4" style="border-bottom: 1px solid var(--border-color)">
      <a href="/" aria-label="Pingflare home" class="flex min-w-0 items-center gap-3">
        <img src="/logo.png" alt="" class="h-8 w-8 shrink-0 object-contain" />
        {#if !sidebarCollapsed}
          <span class="truncate text-base font-semibold" style="color: rgb(var(--text))">Pingflare</span>
        {/if}
      </a>
    </div>

    <nav class="flex-1 space-y-1 overflow-y-auto p-3">
      {#each nav as item}
        {@const active = isActive(item.href, $page.url.pathname)}
        <a
          href={item.href}
          class="{active ? 'nav-link-active' : 'nav-link'} w-full"
          class:justify-center={sidebarCollapsed}
          aria-current={active ? 'page' : undefined}
          title={sidebarCollapsed ? item.label : undefined}>
          <Icon name={item.icon} size={19} />
          {#if !sidebarCollapsed}<span>{item.label}</span>{/if}
        </a>
      {/each}
    </nav>

    <div class="space-y-1 p-3" style="border-top: 1px solid var(--border-color)">
      <div class="flex items-center gap-1" class:flex-col={sidebarCollapsed}>
        <button type="button" class="btn-ghost icon-button"
          aria-label={$theme === 'dark' ? $t('theme.toLightMode') : $t('theme.toDarkMode')}
          on:click={() => theme.toggle()}>
          <Icon name={$theme === 'dark' ? 'sun' : 'moon'} size={19} />
        </button>
        <button type="button" class="btn-ghost icon-button" aria-label={$t('layout.signOut')} on:click={logout}>
          <Icon name="arrow-right-on-rect" size={19} />
        </button>
        <button type="button" class="btn-ghost icon-button ml-auto" class:ml-auto={!sidebarCollapsed}
          aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-expanded={!sidebarCollapsed}
          on:click={() => sidebarCollapsed = !sidebarCollapsed}>
          <Icon name={sidebarCollapsed ? 'arrows-pointing-out' : 'arrows-pointing-in'} size={18} />
        </button>
      </div>
      {#if !sidebarCollapsed}
        <div class="flex items-center justify-between px-2 pt-2 text-xs" style="color: rgb(var(--text-muted))">
          <span>v{APP_VERSION}</span>
          <span class="tabular-nums">Refresh {countdown}s</span>
        </div>
      {/if}
    </div>
  </aside>

  <div class="flex min-h-dvh min-w-0 flex-1 flex-col transition-[margin] duration-200 {sidebarCollapsed ? 'lg:ml-20' : 'lg:ml-64'}">
    <header class="sticky top-0 z-20 flex h-16 items-center gap-3 px-4 lg:hidden"
      style="background-color: rgb(var(--bg-subtle)); border-bottom: 1px solid var(--border-color)">
      <a href="/" aria-label="Pingflare home" class="flex min-w-0 items-center gap-2">
        <img src="/logo.png" alt="" class="h-8 w-8 object-contain" />
        <span class="truncate text-sm font-semibold" style="color: rgb(var(--text))">Pingflare</span>
      </a>
      <div class="ml-auto flex items-center gap-1">
        <button type="button" class="btn-outline icon-button"
          aria-label={$theme === 'dark' ? $t('theme.toLightMode') : $t('theme.toDarkMode')}
          on:click={() => theme.toggle()}>
          <Icon name={$theme === 'dark' ? 'sun' : 'moon'} size={19} />
        </button>
        <button type="button" class="btn-outline icon-button" aria-label="Open navigation"
          aria-expanded={menuOpen} aria-controls="mobile-navigation"
          on:click={() => menuOpen = true}>
          <Icon name="bars-3" size={20} />
        </button>
      </div>
    </header>

    {#if menuOpen}
      <button class="fixed inset-0 z-40 bg-black/50 lg:hidden" aria-label="Close navigation"
        on:click={() => menuOpen = false}></button>
      <aside id="mobile-navigation"
        class="fixed inset-y-0 right-0 z-50 flex w-[min(20rem,88vw)] flex-col p-4 shadow-2xl lg:hidden"
        style="background-color: rgb(var(--card))"
        aria-label="Mobile navigation">
        <div class="mb-4 flex items-center justify-between">
          <span class="text-sm font-semibold" style="color: rgb(var(--text))">Navigation</span>
          <button type="button" class="btn-ghost icon-button" aria-label="Close navigation"
            on:click={() => menuOpen = false}>
            <Icon name="x-mark" size={20} />
          </button>
        </div>
        <nav class="flex-1 space-y-1">
          {#each nav as item}
            {@const active = isActive(item.href, $page.url.pathname)}
            <a href={item.href} class="{active ? 'nav-link-active' : 'nav-link'} w-full"
              aria-current={active ? 'page' : undefined}>
              <Icon name={item.icon} size={19} />
              <span>{item.label}</span>
            </a>
          {/each}
        </nav>
        <button type="button" class="btn-outline w-full" on:click={logout}>
          <Icon name="arrow-right-on-rect" size={18} /> {$t('layout.signOut')}
        </button>
      </aside>
    {/if}

    <main id="main-content" tabindex="-1" class="min-w-0 flex-1 outline-none">
      <slot />
    </main>

    <footer class="px-4 py-3 text-xs" style="border-top: 1px solid var(--border-color); color: rgb(var(--text-muted))">
      <div class="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-2">
        {#if updateAvailable}
          <a href="https://github.com/{GITHUB_REPO}/releases/latest" target="_blank" rel="noopener noreferrer"
            class="flex items-center gap-1.5 rounded-full px-2 py-1 font-medium"
            style="color: var(--color-primary); background: var(--color-primary-soft)">
            <Icon name="exclamation-triangle" size={13} />
            {$t('footer.updateAvailable')} v{latestVersion}
          </a>
        {:else}
          <span>Pingflare v{APP_VERSION}</span>
        {/if}
        <a href="https://github.com/{GITHUB_REPO}" target="_blank" rel="noopener noreferrer"
          class="flex min-h-11 items-center gap-1.5 hover:text-[var(--color-primary)]">
          <Icon name="github" size={15} /> GitHub
        </a>
      </div>
    </footer>
  </div>
</div>
