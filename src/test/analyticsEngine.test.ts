import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseApiAnalyticsSampleRate,
  recordApiRequest,
  recordCheckAnalytics,
  recordCheckObservation,
  type AnalyticsEngineEnv,
} from '../services/analytics-engine';

function dataset(
  writeDataPoint: (event?: AnalyticsEngineDataPoint) => void = vi.fn(),
): AnalyticsEngineDataset {
  return { writeDataPoint };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('recordCheckObservation', () => {
  it('writes a fixed, queryable point indexed by monitor UUID', () => {
    const writeDataPoint = vi.fn();
    const env: AnalyticsEngineEnv = {
      CHECK_ANALYTICS: dataset(writeDataPoint),
    };

    recordCheckObservation(env, {
      monitorId: '8fb74af8-7a4e-44a4-8cda-9161aab80f36',
      instance: 'primary',
      monitorType: 'http',
      status: 'up',
      source: 'worker',
      resultCode: 200,
      colo: 'bom',
      country: 'in',
      sslStatus: 'valid',
      responseTimeMs: 123.5,
      timestamp: 1_700_000_000_000,
      agentMetrics: { cpu: 12, ram: 34, disk: 56 },
    });

    expect(writeDataPoint).toHaveBeenCalledOnce();
    expect(writeDataPoint).toHaveBeenCalledWith({
      indexes: ['8fb74af8-7a4e-44a4-8cda-9161aab80f36'],
      blobs: [
        'check.v1',
        'primary',
        '8fb74af8-7a4e-44a4-8cda-9161aab80f36',
        'http',
        'up',
        'worker',
        '200',
        'bom',
        'in',
        'valid',
      ],
      doubles: [123.5, 1, 1, 0, 1_700_000_000_000, 12, 34, 56, 0],
    });
  });

  it('adapts persisted observations without copying sensitive fields', () => {
    const writeDataPoint = vi.fn();
    const env: AnalyticsEngineEnv = {
      CHECK_ANALYTICS: dataset(writeDataPoint),
    };
    const observation = {
      monitor: {
        id: 'monitor-1',
        type: 'tcp',
        url: 'https://secret.example/path?token=top-secret',
        authToken: 'credential',
      },
      status: 'down',
      responseTimeMs: null,
      checkedAt: 42,
      source: 'agent',
      message: 'raw failure message',
      ip: '203.0.113.7',
      secret: 'credential',
    };

    recordCheckAnalytics(env, observation);

    const point = writeDataPoint.mock.calls[0]?.[0];
    expect(point?.doubles).toEqual([0, 0, 0, 1, 42, 0, 0, 0, 0]);
    const serialized = JSON.stringify(point);
    expect(serialized).not.toContain('secret.example');
    expect(serialized).not.toContain('raw failure message');
    expect(serialized).not.toContain('203.0.113.7');
    expect(serialized).not.toContain('credential');
  });

  it('is a no-op without a binding and swallows synchronous write failures', () => {
    expect(() =>
      recordCheckObservation(
        {},
        {
          monitorId: 'monitor-1',
          monitorType: 'http',
          status: 'up',
          source: 'worker',
        },
      ),
    ).not.toThrow();

    const failing = dataset(() => {
      throw new Error('analytics unavailable');
    });
    expect(() =>
      recordCheckObservation(
        { CHECK_ANALYTICS: failing },
        {
          monitorId: 'monitor-1',
          monitorType: 'http',
          status: 'up',
          source: 'worker',
        },
      ),
    ).not.toThrow();
  });
});

describe('recordApiRequest', () => {
  it('samples successful requests using the configured rate', () => {
    const writeDataPoint = vi.fn();
    const env: AnalyticsEngineEnv = {
      API_ANALYTICS: dataset(writeDataPoint),
      API_ANALYTICS_SAMPLE_RATE: '0.25',
    };
    vi.spyOn(Math, 'random').mockReturnValue(0.25);

    recordApiRequest(env, {
      operation: 'monitors.list',
      method: 'get',
      statusCode: 200,
      durationMs: 15,
      timestamp: 99,
    });

    expect(writeDataPoint).not.toHaveBeenCalled();
  });

  it('stores the inverse application sampling rate on retained successes', () => {
    const writeDataPoint = vi.fn();
    const env: AnalyticsEngineEnv = {
      API_ANALYTICS: dataset(writeDataPoint),
      API_ANALYTICS_SAMPLE_RATE: '0.25',
    };
    vi.spyOn(Math, 'random').mockReturnValue(0.249);

    recordApiRequest(env, {
      instance: 'primary',
      operation: 'monitors.list',
      method: 'get',
      statusCode: 200,
      durationMs: 15,
      timestamp: 99,
    });

    expect(writeDataPoint).toHaveBeenCalledWith({
      blobs: ['api.v2', 'primary', 'monitors.list', 'GET', ''],
      doubles: [15, 1, 200, 0, 99, 4],
    });
  });

  it('always writes errors even when successful-request sampling is disabled', () => {
    const writeDataPoint = vi.fn();
    const env: AnalyticsEngineEnv = {
      API_ANALYTICS: dataset(writeDataPoint),
      API_ANALYTICS_SAMPLE_RATE: 0,
    };
    const random = vi.spyOn(Math, 'random');

    recordApiRequest(env, {
      instance: 'primary',
      operation: 'monitors.create',
      method: 'post',
      statusCode: 500,
      durationMs: 22,
      resultCode: 'db_error',
      timestamp: 100,
    });

    expect(random).not.toHaveBeenCalled();
    expect(writeDataPoint).toHaveBeenCalledWith({
      blobs: ['api.v2', 'primary', 'monitors.create', 'POST', 'db_error'],
      doubles: [22, 1, 500, 1, 100, 1],
    });
  });

  it('writes sampled successes without retaining URL, message, IP, or secrets', () => {
    const writeDataPoint = vi.fn();
    const env: AnalyticsEngineEnv = {
      API_ANALYTICS: dataset(writeDataPoint),
      API_ANALYTICS_SAMPLE_RATE: 1,
    };
    const metric = {
      operation: 'status.read',
      method: 'get',
      statusCode: 200,
      timestamp: 101,
      url: 'https://secret.example/status?token=top-secret',
      message: 'raw response',
      ip: '203.0.113.8',
      secret: 'credential',
    };

    recordApiRequest(env, metric);

    expect(writeDataPoint).toHaveBeenCalledOnce();
    const serialized = JSON.stringify(writeDataPoint.mock.calls[0]?.[0]);
    expect(serialized).not.toContain('secret.example');
    expect(serialized).not.toContain('raw response');
    expect(serialized).not.toContain('203.0.113.8');
    expect(serialized).not.toContain('credential');
  });

  it('swallows synchronous API Analytics Engine failures', () => {
    const failing = dataset(() => {
      throw new Error('analytics unavailable');
    });

    expect(() =>
      recordApiRequest(
        {
          API_ANALYTICS: failing,
          API_ANALYTICS_SAMPLE_RATE: 1,
        },
        {
          operation: 'health',
          method: 'get',
          statusCode: 200,
        },
      ),
    ).not.toThrow();
  });
});

describe('parseApiAnalyticsSampleRate', () => {
  it('defaults invalid values and clamps numeric values', () => {
    expect(parseApiAnalyticsSampleRate(undefined)).toBe(0.05);
    expect(parseApiAnalyticsSampleRate('invalid')).toBe(0.05);
    expect(parseApiAnalyticsSampleRate(-1)).toBe(0);
    expect(parseApiAnalyticsSampleRate('2')).toBe(1);
  });
});
