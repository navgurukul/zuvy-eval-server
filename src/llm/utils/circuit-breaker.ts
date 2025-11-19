import { Logger } from '@nestjs/common';

interface CircuitBreakerOptions {
  failureThreshold: number;
  resetTimeout: number;
  monitorWindow: number;
}

enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failures: number[] = [];
  private openedAt: number = 0;
  private readonly logger: Logger;

  constructor(
    private readonly name: string,
    private readonly options: CircuitBreakerOptions
  ) {
    this.logger = new Logger(`CircuitBreaker:${name}`);
  }

  isOpen(): boolean {
    if (this.state === CircuitState.OPEN) {
      if (Date.now() - this.openedAt > this.options.resetTimeout) {
        this.logger.log('Circuit entering HALF_OPEN state');
        this.state = CircuitState.HALF_OPEN;
        return false;
      }
      return true;
    }
    return false;
  }

  recordSuccess(): void {
    if (this.state === CircuitState.HALF_OPEN) {
      this.logger.log('Circuit recovered, closing');
      this.reset();
    }
  }

  recordFailure(): void {
    const now = Date.now();
    this.failures.push(now);

    this.failures = this.failures.filter(
      time => now - time < this.options.monitorWindow
    );

    if (this.failures.length >= this.options.failureThreshold) {
      this.open();
    }
  }

  private open(): void {
    this.state = CircuitState.OPEN;
    this.openedAt = Date.now();
    this.logger.warn(
      `Circuit OPENED after ${this.failures.length} failures`
    );
  }

  private reset(): void {
    this.state = CircuitState.CLOSED;
    this.failures = [];
    this.openedAt = 0;
  }
}