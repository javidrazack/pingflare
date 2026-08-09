<div class="header-pattern absolute inset-0 pointer-events-none" aria-hidden="true"></div>

<style>
  .header-pattern {
    overflow: hidden;
    background-image:
      radial-gradient(circle at 82% 22%, color-mix(in srgb, var(--color-primary) 11%, transparent), transparent 18rem),
      repeating-linear-gradient(315deg, rgb(var(--text) / 0.025) 0, rgb(var(--text) / 0.025) 1px, transparent 0, transparent 50%);
    background-size: auto, 10px 10px;
  }

  .header-pattern::after {
    position: absolute;
    inset: 0 auto 0 -18%;
    width: 18%;
    background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--color-primary) 14%, transparent), transparent);
    content: '';
    opacity: 0;
    animation: signal-scan 900ms cubic-bezier(0.16, 1, 0.3, 1) 100ms both;
  }

  @keyframes signal-scan {
    0% { left: -18%; opacity: 0; }
    18% { opacity: 0.8; }
    100% { left: 100%; opacity: 0; }
  }
</style>
