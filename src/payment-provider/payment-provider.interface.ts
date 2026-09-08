export type ProviderChargeRequest = {
  idempotencyKey: string;
  amount: number;
  currency: string;
  paymentMethod: string;
  userId: string;
};

export type ProviderChargeResult =
  | {
      outcome: 'succeeded';
      providerPaymentId: string;
    }
  | {
      outcome: 'failed';
      providerPaymentId: string;
      reason: string;
    }
  | {
      outcome: 'timeout';
      providerPaymentId: string | null;
      reason: string;
    };

export type ProviderPaymentStatus =
  | { found: false }
  | {
      found: true;
      providerPaymentId: string;
      status: 'succeeded' | 'failed' | 'pending';
    };

export interface PaymentProvider {
  charge(request: ProviderChargeRequest): Promise<ProviderChargeResult>;
  getPaymentByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<ProviderPaymentStatus>;
}

export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');
