<script lang="ts">
  export let label = 'Loading…'
</script>

<div
  class="loader-scrim fixed inset-0 z-40 flex items-center justify-center"
  style="top: 3.5rem; background-color: rgb(var(--bg) / 0.8); backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px);"
  role="status"
  aria-live="polite"
  aria-busy="true"
>
  <div
    class="flex items-center gap-3 px-5 py-3 rounded"
    style="background-color: rgb(var(--card)); border: 1px solid var(--border-color); box-shadow: 0 8px 32px rgb(0 0 0 / 0.12);"
  >
    <svg
      class="h-4 w-4 animate-spin shrink-0"
      style="color: var(--color-primary)"
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
    >
      <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
      <path
        class="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
      />
    </svg>
    <span class="text-sm font-medium" style="color: rgb(var(--text))">{label}</span>
  </div>
</div>

<style>
  .loader-scrim {
    animation: loader-enter 150ms ease both;
  }

  @keyframes loader-enter {
    from { opacity: 0; }
    to { opacity: 1; }
  }
</style>
