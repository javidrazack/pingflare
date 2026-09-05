/** Process-local fallback for Docker. Bound memory without evicting live limits. */
export function createLocalRateLimiter(limit: number, maxKeys = 10_000): RateLimit {
  const attempts = new Map<string, { count: number; resetAt: number }>()
  let nextSweep = 0
  return {
    async limit({ key }) {
      const now = Date.now()
      if (now >= nextSweep) {
        for (const [name, entry] of attempts) if (entry.resetAt <= now) attempts.delete(name)
        nextSweep = now + 60_000
      }
      const current = attempts.get(key)
      if (!current || now >= current.resetAt) {
        if (!current && attempts.size >= maxKeys) return { success: false }
        attempts.set(key, { count: 1, resetAt: now + 60_000 })
        return { success: true }
      }
      current.count += 1
      return { success: current.count <= limit }
    },
  }
}
