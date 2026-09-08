import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CashInModule } from '../cash-in/cash-in.module';
import { Operation } from '../cash-in/entities/operation.entity';
import { WebhookEvent } from './entities/webhook-event.entity';
import { WebhookReplayService } from './webhook-replay.service';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';

/**
 * Bounded context: ingesta at-least-once de webhooks + replay hacia operaciones.
 * forwardRef con CashInModule: replay necesita complete/transition; cash-in necesita replay al claim.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([WebhookEvent, Operation]),
    forwardRef(() => CashInModule),
  ],
  controllers: [WebhooksController],
  providers: [WebhooksService, WebhookReplayService],
  exports: [WebhookReplayService],
})
export class WebhooksModule {}
