export default () => ({
  port: parseInt(process.env.PORT ?? '3000', 10),
  database: {
    host: process.env.DB_HOST ?? 'localhost',
    port: parseInt(process.env.DB_PORT ?? '5432', 10),
    username: process.env.DB_USER ?? 'cashin',
    password: process.env.DB_PASSWORD ?? 'cashin',
    name: process.env.DB_NAME ?? 'cashin',
  },
  provider: {
    mode: (process.env.PROVIDER_MODE ?? 'success') as
      | 'success'
      | 'fail'
      | 'timeout',
    timeoutMs: parseInt(process.env.PROVIDER_TIMEOUT_MS ?? '50', 10),
    latencyMs: parseInt(process.env.PROVIDER_LATENCY_MS ?? '20', 10),
  },
  resilience: {
    dbRetryAttempts: parseInt(process.env.DB_RETRY_ATTEMPTS ?? '3', 10),
    dbRetryBaseMs: parseInt(process.env.DB_RETRY_BASE_MS ?? '50', 10),
    followerWaitMs: parseInt(process.env.FOLLOWER_WAIT_MS ?? '1500', 10),
    staleOperationMs: parseInt(process.env.STALE_OPERATION_MS ?? '3000', 10),
  },
});
