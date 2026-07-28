const CHECK_SCHEMA = 'check.v1';
const API_SCHEMA = 'api.v1';
const DEFAULT_API_SAMPLE_RATE = 0.05;

export interface AnalyticsEngineEnv {
  CHECK_ANALYTICS?: AnalyticsEngineDataset;
  API_ANALYTICS?: AnalyticsEngineDataset;
  API_ANALYTICS_SAMPLE_RATE?: string | number;
  PINGFLARE_INSTANCE_ID?: string;
}

export interface AgentMetrics {
  cpu?: number;
  ram?: number;
  disk?: number;
  unhealthyContainers?: number;
}

export interface CheckObservationMetric {
  monitorId: string;
  instance?: string;
  monitorType: string;
  status: string;
  source: string;
  resultCode?: string | number | null;
  colo?: string | null;
  country?: string | null;
  sslStatus?: string | null;
  responseTimeMs?: number | null;
  timestamp?: number;
  agentMetrics?: AgentMetrics | null;
}

export interface ApiRequestMetric {
  instance?: string;
  operation: string;
  method: string;
  statusCode: number;
  durationMs?: number | null;
  resultCode?: string | number | null;
  timestamp?: number;
  error?: boolean;
}

interface PersistedCheckObservation {
  monitor: {
    id: string;
    type: string;
  };
  status: string;
  responseTimeMs?: number | null;
  checkedAt: number;
  source: string;
  resultCode?: string | number | null;
  sslStatus?: string | null;
  colo?: string | null;
  countryCode?: string | null;
  agentMetrics?: AgentMetrics | null;
}

function dimension(value: unknown, maximumLength: number, fallback = ''): string {
  if (value === null || value === undefined) {
    return fallback;
  }

  return String(value)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .slice(0, maximumLength);
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, value)
    : undefined;
}

function timestamp(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : Date.now();
}

export function parseApiAnalyticsSampleRate(value: unknown): number {
  if (value === undefined || value === null || value === '') {
    return DEFAULT_API_SAMPLE_RATE;
  }

  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_API_SAMPLE_RATE;
  }

  return Math.min(1, Math.max(0, parsed));
}

/**
 * Writes one monitor observation without delaying the request or scheduling
 * background work. Analytics Engine's writeDataPoint API is synchronous.
 */
export function recordCheckObservation(
  env: object,
  metric: CheckObservationMetric,
): void {
  try {
    const dataset = (env as AnalyticsEngineEnv).CHECK_ANALYTICS;
    const monitorId = dimension(metric.monitorId, 64);
    if (!dataset || !monitorId) {
      return;
    }

    const responseTime = finiteNonNegative(metric.responseTimeMs);
    const doubles = [
      responseTime ?? 0,
      responseTime === undefined ? 0 : 1,
      metric.status === 'up' ? 1 : 0,
      metric.status === 'down' ? 1 : 0,
      timestamp(metric.timestamp),
      finiteNonNegative(metric.agentMetrics?.cpu) ?? 0,
      finiteNonNegative(metric.agentMetrics?.ram) ?? 0,
      finiteNonNegative(metric.agentMetrics?.disk) ?? 0,
      finiteNonNegative(metric.agentMetrics?.unhealthyContainers) ?? 0,
    ];

    dataset.writeDataPoint({
      indexes: [monitorId],
      blobs: [
        CHECK_SCHEMA,
        dimension(metric.instance, 64, 'default'),
        monitorId,
        dimension(metric.monitorType, 32),
        dimension(metric.status, 16),
        dimension(metric.source, 16),
        dimension(metric.resultCode, 32),
        dimension(metric.colo, 8),
        dimension(metric.country, 8),
        dimension(metric.sslStatus, 16),
      ],
      doubles,
    });
  } catch {
    // Analytics is best-effort and must never affect monitor execution.
  }
}

/**
 * Adapts the application's persisted observation shape without copying its
 * diagnostic message, URL, IP address, or other monitor configuration.
 */
export function recordCheckAnalytics(
  env: object,
  observation: PersistedCheckObservation,
): void {
  const analyticsEnv = env as AnalyticsEngineEnv;
  recordCheckObservation(env, {
    monitorId: observation.monitor.id,
    instance: analyticsEnv.PINGFLARE_INSTANCE_ID,
    monitorType: observation.monitor.type,
    status: observation.status,
    source: observation.source,
    resultCode: observation.resultCode,
    colo: observation.colo,
    country: observation.countryCode,
    sslStatus: observation.sslStatus,
    responseTimeMs: observation.responseTimeMs,
    timestamp: observation.checkedAt,
    agentMetrics: observation.agentMetrics,
  });
}

/**
 * Samples successful API requests while always retaining error observations.
 * The caller supplies a stable operation name; raw URLs and request metadata
 * are intentionally not accepted or persisted.
 */
export function recordApiRequest(
  env: object,
  metric: ApiRequestMetric,
): void {
  try {
    const analyticsEnv = env as AnalyticsEngineEnv;
    const dataset = analyticsEnv.API_ANALYTICS;
    if (!dataset) {
      return;
    }

    const statusCode = Number.isFinite(metric.statusCode)
      ? Math.min(999, Math.max(0, Math.trunc(metric.statusCode)))
      : 0;
    const isError = metric.error === true || statusCode >= 400;
    const sampleRate = parseApiAnalyticsSampleRate(
      analyticsEnv.API_ANALYTICS_SAMPLE_RATE,
    );

    if (!isError && Math.random() >= sampleRate) {
      return;
    }

    const duration = finiteNonNegative(metric.durationMs);
    dataset.writeDataPoint({
      blobs: [
        API_SCHEMA,
        dimension(metric.instance, 64, 'default'),
        dimension(metric.operation, 64),
        dimension(metric.method, 12).toUpperCase(),
        dimension(metric.resultCode, 32),
      ],
      doubles: [
        duration ?? 0,
        duration === undefined ? 0 : 1,
        statusCode,
        isError ? 1 : 0,
        timestamp(metric.timestamp),
      ],
    });
  } catch {
    // Analytics is best-effort and must never affect API responses.
  }
}
