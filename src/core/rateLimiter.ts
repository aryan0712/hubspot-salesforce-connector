/**
 * Small dependency-free token scheduler. Each connector owns one so tenants cannot make a
 * burst that violates a CRM's per-app limits. Distributed deployments can replace this
 * with a PostgreSQL advisory-lock or Redis implementation behind the same method.
 */
export class RateLimiter {
  private nextAvailableAt = 0;

  constructor(private readonly requestsPerSecond: number) {}

  async acquire(): Promise<void> {
    const interval = 1000 / this.requestsPerSecond;
    const now = Date.now();
    const at = Math.max(now, this.nextAvailableAt);
    this.nextAvailableAt = at + interval;
    const wait = at - now;
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  }
}
