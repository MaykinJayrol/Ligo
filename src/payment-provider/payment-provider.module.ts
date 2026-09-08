import { Module } from '@nestjs/common';
import { PAYMENT_PROVIDER } from './payment-provider.interface';
import { MockPaymentProviderService } from './mock-payment-provider.service';

@Module({
  providers: [
    MockPaymentProviderService,
    { provide: PAYMENT_PROVIDER, useExisting: MockPaymentProviderService },
  ],
  exports: [PAYMENT_PROVIDER, MockPaymentProviderService],
})
export class PaymentProviderModule {}
