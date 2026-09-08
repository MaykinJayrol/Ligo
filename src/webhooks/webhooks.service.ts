import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import { CashInService } from '../cash-in/cash-in.service';
import { Operation } from '../cash-in/entities/operation.entity';
import { PaymentWebhookDto } from './dto/payment-webhook.dto';
import { WebhookEvent } from './entities/webhook-event.entity';
import { WebhookReplayService } from './webhook-replay.service';

@Injectable()
export class WebhooksService {
  constructor(
    @InjectRepository(WebhookEvent)
    private readonly webhookEvents: Repository<WebhookEvent>,
    @Inject(forwardRef(() => CashInService))
    private readonly cashInService: CashInService,
    private readonly replay: WebhookReplayService,
  ) {}

  async handlePaymentWebhook(dto: PaymentWebhookDto): Promise<{
    status: 'applied' | 'ignored' | 'duplicate' | 'buffered';
    reason?: string;
    operation_id?: string;
  }> {
    const recorded = await this.recordEvent(dto);
    if (recorded.duplicate) {
      return { status: 'duplicate', reason: 'event_already_processed' };
    }

    const operation = await this.resolveOperation(dto);
    if (!operation) {
      // Webhook antes que el API: queda buffered para replay al claim
      await this.webhookEvents.update(recorded.event.id, {
        status: 'buffered',
        ignoreReason: 'operation_not_found_yet_buffered',
      });
      return {
        status: 'buffered',
        reason: 'operation_not_found_buffered_by_event_id',
      };
    }

    const result = await this.replay.applyEventToOperation(
      operation,
      recorded.event,
      dto,
    );

    return {
      status: result.outcome,
      operation_id: result.operation.id,
      reason: result.outcome === 'ignored' ? 'state_machine_noop' : undefined,
    };
  }

  private async recordEvent(
    dto: PaymentWebhookDto,
  ): Promise<{ duplicate: boolean; event: WebhookEvent }> {
    try {
      const event = await this.webhookEvents.save(
        this.webhookEvents.create({
          providerEventId: dto.event_id,
          providerPaymentId: dto.provider_payment_id,
          idempotencyKey: dto.idempotency_key ?? null,
          eventType: dto.event_type,
          payload: dto as unknown as Record<string, unknown>,
          status: 'received',
          ignoreReason: null,
        }),
      );
      return { duplicate: false, event };
    } catch (error) {
      if (isUniqueViolation(error)) {
        const event = await this.webhookEvents.findOneOrFail({
          where: { providerEventId: dto.event_id },
        });
        return { duplicate: true, event };
      }
      throw error;
    }
  }

  private async resolveOperation(
    dto: PaymentWebhookDto,
  ): Promise<Operation | null> {
    const byProvider = await this.cashInService.findByProviderPaymentId(
      dto.provider_payment_id,
    );
    if (byProvider) return byProvider;

    if (dto.idempotency_key) {
      return this.cashInService.findByIdempotencyKey(dto.idempotency_key);
    }
    return null;
  }
}

function isUniqueViolation(error: unknown): boolean {
  if (error instanceof QueryFailedError) {
    const driver = error.driverError as { code?: string };
    return driver?.code === '23505';
  }
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: string }).code === '23505'
  );
}
