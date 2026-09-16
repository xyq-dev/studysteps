import { Injectable } from '@nestjs/common';
import { assertTestAuthAllowed } from '../common/config';
import { RuntimeConfig } from '../common/runtime-config';

const ALLOWED_DESTINATIONS = new Set(
  [
    '+8613800138000',
    '+8613800138001',
    '+8613800138002',
    '+8613800138003',
    '+8613800138004',
    '+8613800138300',
    '+8613800138301',
  ].concat(Array.from({ length: 80 }, (_, index) => `+8613800138${String(200 + index).padStart(3, '0')}`)),
);

@Injectable()
export class TestAuthDelivery {
  private readonly inbox = new Map<string, string>();

  constructor(private readonly runtime: RuntimeConfig) {}

  private get config() {
    return this.runtime.value;
  }

  deliver(destination: string, code: string): void {
    assertTestAuthAllowed(this.config);
    if (!ALLOWED_DESTINATIONS.has(destination)) {
      throw new Error(`test delivery refused unknown destination`);
    }
    this.inbox.set(destination, code);
  }

  read(destination: string, accessKey: string): string | null {
    assertTestAuthAllowed(this.config);
    if (!this.config.authTestInboxKey || accessKey !== this.config.authTestInboxKey) {
      return null;
    }
    if (!ALLOWED_DESTINATIONS.has(destination)) {
      return null;
    }
    return this.inbox.get(destination) ?? null;
  }
}

export const TEST_DESTINATIONS = ALLOWED_DESTINATIONS;
