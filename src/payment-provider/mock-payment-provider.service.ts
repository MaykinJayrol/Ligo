import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  PaymentProvider,
  ProviderChargeRequest,
  ProviderChargeResult,
  ProviderPaymentStatus,
} from './payment-provider.interface';

type StoredPayment = {
  providerPaymentId: string;
  idempotencyKey: string;
  status: 'succeeded' | 'failed' | 'pending';
  amount: number;
  currency: string;
};

/**
 * Mock del proveedor externo (NO es nuestra capa de idempotencia).
 *
 * El Map vive en el proceso del mock solo para simular que el PSP
 * también es idempotente por key. La idempotencia de NEGOCIO del
 * cash-in vive exclusivamente en PostgreSQL (UNIQUE idempotency_key).
 */
@Injectable()
export class MockPaymentProviderService implements PaymentProvider {
  /** Estado simulado del lado del proveedor externo — no compartir entre pods reales. */
  private readonly byIdempotency = new Map<string, StoredPayment>();

  constructor(private readonly config: ConfigService) {}

  async charge(request: ProviderChargeRequest): Promise<ProviderChargeResult> {
    const existing = this.byIdempotency.get(request.idempotencyKey);
    if (existing) {
      // El proveedor también es idempotente por key — clave para no doble cobro.
      if (existing.status === 'succeeded') {
        return {
          outcome: 'succeeded',
          providerPaymentId: existing.providerPaymentId,
        };
      }
      if (existing.status === 'failed') {
        return {
          outcome: 'failed',
          providerPaymentId: existing.providerPaymentId,
          reason: 'provider_previous_failure',
        };
      }
    }

    const mode = this.resolveMode(request.paymentMethod);
    const latency = this.config.get<number>('provider.latencyMs') ?? 20;
    await sleep(latency);

    const providerPaymentId = `pay_${request.idempotencyKey.replace(/-/g, '').slice(0, 12)}`;

    if (mode === 'timeout') {
      // Simula: el cobro SÍ ocurrió en el proveedor, pero la respuesta se pierde.
      this.byIdempotency.set(request.idempotencyKey, {
        providerPaymentId,
        idempotencyKey: request.idempotencyKey,
        status: 'succeeded',
        amount: request.amount,
        currency: request.currency,
      });
      return {
        outcome: 'timeout',
        providerPaymentId,
        reason: 'provider_timeout_after_charge',
      };
    }

    if (mode === 'fail') {
      this.byIdempotency.set(request.idempotencyKey, {
        providerPaymentId,
        idempotencyKey: request.idempotencyKey,
        status: 'failed',
        amount: request.amount,
        currency: request.currency,
      });
      return {
        outcome: 'failed',
        providerPaymentId,
        reason: 'provider_declined',
      };
    }

    this.byIdempotency.set(request.idempotencyKey, {
      providerPaymentId,
      idempotencyKey: request.idempotencyKey,
      status: 'succeeded',
      amount: request.amount,
      currency: request.currency,
    });

    return { outcome: 'succeeded', providerPaymentId };
  }

  async getPaymentByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<ProviderPaymentStatus> {
    const existing = this.byIdempotency.get(idempotencyKey);
    if (!existing) return { found: false };
    return {
      found: true,
      providerPaymentId: existing.providerPaymentId,
      status: existing.status,
    };
  }

  /** Test helper: seed provider state (simula cobro ya hecho). */
  seedPayment(payment: StoredPayment): void {
    this.byIdempotency.set(payment.idempotencyKey, payment);
  }

  clear(): void {
    this.byIdempotency.clear();
  }

  private resolveMode(paymentMethod: string): 'success' | 'fail' | 'timeout' {
    if (paymentMethod.endsWith('_fail')) return 'fail';
    if (paymentMethod.endsWith('_timeout')) return 'timeout';
    return (this.config.get<string>('provider.mode') as
      | 'success'
      | 'fail'
      | 'timeout') ?? 'success';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
