import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PaymentProviderModule } from '../payment-provider/payment-provider.module';
import { WalletModule } from '../wallet/wallet.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { CashInController } from './cash-in.controller';
import { CashInService } from './cash-in.service';
import { Operation } from './entities/operation.entity';

/**
 * Bounded context: orquestación del cash-in (claim, charge/reconcile, complete).
 * Depende de Wallet (saldo), PaymentProvider (PSP) y Webhooks (replay buffered).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Operation]),
    WalletModule,
    PaymentProviderModule,
    forwardRef(() => WebhooksModule),
  ],
  controllers: [CashInController],
  providers: [CashInService],
  exports: [CashInService, TypeOrmModule],
})
export class CashInModule {}
