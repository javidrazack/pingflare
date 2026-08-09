<script lang="ts">
  import { api, ApiError } from '$lib/api'
  import { token } from '$lib/stores'
  import { t, locale, localeOptions } from '$lib/i18n'
  import { goto } from '$app/navigation'
  import { onMount } from 'svelte'
  import Icon from '$lib/components/Icon.svelte'
  import HeaderPattern from '$lib/components/HeaderPattern.svelte'

  let username = ''
  let password = ''
  let error = ''
  let loading = false

  onMount(() => {
    if (localStorage.getItem('token')) goto('/')
  })

  async function login() {
    loading = true
    error = ''
    try {
      const res = await api.auth.login(username, password)
      token.set(res.token)
      goto('/')
    } catch (e) {
      error = e instanceof ApiError && e.code === 'INVALID_CREDENTIALS'
        ? $t('login.invalidCreds')
        : e instanceof Error ? e.message : String(e)
    } finally {
      loading = false
    }
  }
</script>

<svelte:head><title>{$t('login.signIn')} - Pingflare</title></svelte:head>

<div class="login-shell min-h-screen flex items-center justify-center relative overflow-hidden">

  <HeaderPattern />

  <div class="absolute inset-0 pointer-events-none"
    style="background: radial-gradient(ellipse 80% 50% at 50% -10%, color-mix(in srgb, var(--color-primary) 10%, transparent), transparent)"></div>

  <div class="relative w-full max-w-sm px-4">

    <div class="mb-8 text-center">
      <img
        src="/logo-64.webp"
        srcset="/logo-64.webp 1x, /logo-128.webp 2x"
        alt="Pingflare"
        width="64"
        height="64"
        class="login-logo h-16 mx-auto mb-3" />
      <h1 class="text-2xl font-bold tracking-tight" style="color: rgb(var(--text))">Pingflare</h1>
      <p class="mt-1 text-sm font-medium" style="color: var(--color-primary)">{$t('login.signIn')}</p>
    </div>

    <div class="login-panel rounded-xl p-6 space-y-4"
      style="background-color: rgb(var(--card)); border: 1px solid var(--border-color)">

      <form on:submit|preventDefault={login} class="space-y-4">
        <div>
          <label for="username" class="label">{$t('login.username')}</label>
          <input id="username" class="input" bind:value={username}
            autocomplete="username" required placeholder="admin" />
        </div>
        <div>
          <label for="password" class="label">{$t('login.password')}</label>
          <input id="password" class="input" type="password" bind:value={password}
            autocomplete="current-password" required placeholder="••••••••" />
        </div>

        {#if error}
          <div class="state-reveal flex items-center gap-2 rounded-lg border px-3 py-2 text-sm" role="alert"
            style="background: rgb(var(--danger-bg)); color: var(--danger-fg); border-color: color-mix(in srgb, var(--danger-fg) 24%, transparent)">
            <Icon name="exclamation-triangle" size={14} />
            {error}
          </div>
        {/if}

        <button type="submit" class="btn-primary w-full justify-center mt-1" disabled={loading}>
          {#if loading}
            <Icon name="arrow-path" size={14} cls="animate-spin" />
            {$t('login.signingIn')}
          {:else}
            {$t('login.signIn')}
          {/if}
        </button>
      </form>
    </div>

    <div class="mt-4 flex justify-center">
      <select
        class="input py-1 px-2 text-xs cursor-pointer w-auto"
        value={$locale}
        on:change={(e) => locale.set(e.currentTarget.value)}
        aria-label={$t('login.language')}
      >
        {#each localeOptions as opt}
          <option value={opt.code}>{opt.name}</option>
        {/each}
      </select>
    </div>

  </div>
</div>
