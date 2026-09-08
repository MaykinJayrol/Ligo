import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { CashInService } from '../cash-in/cash-in.service';
import { Operation } from '../cash-in/entities/operation.entity';
import {
  OperationStatus,
  canTransition,
  statusRank,
} from '../cash-in/state-machine/operation.state-machine';
import { PaymentWebhookDto } from './dto/payment-webhook.dto';
import { WebhookEvent } from './entities/webhook-event.entity';

/**
 * Aplica eventos buffered/received a una operación ya existente.
 * Cubre: webhook antes que respuesta API, reinicio, y out-of-order.
 */
@Injectable()
export class WebhookReplayService {
  constructor(
    @InjectRepository(WebhookEvent)
    private readonly webhookEvents: Repository<WebhookEvent>,
    @InjectRepository(Operation)
    private readonly operations: Repository<Operation>,
    @Inject(forwardRef(() => CashInService))
    private readonly cashInService: CashInService,
  ) {}

  async applyBufferedForOperation(operation: Operation): Promise<Operation> {
    const events = await this.webhookEvents.find({
      where: [
        {
          idempotencyKey: operation.idempotencyKey,
          status: In(['buffered', 'received'] as const),
        },
        ...(operation.providerPaymentId
          ? [
              {
                providerPaymentId: operation.providerPaymentId,
                status: In(['buffered', 'received'] as const),
              },
            ]
          : []),
      ],
      order: { createdAt: 'ASC' },
    });

    // Deduplicate by id if both clauses matched
    const unique = new Map(events.map((e) => [e.id, e]));
    let current = operation;

    for (const event of unique.values()) {
      const dto = event.payload as unknown as PaymentWebhookDto;
      const result = await this.applyEventToOperation(current, event, dto);
      current = result.operation;
    }

    return this.operations.findOneOrFail({ where: { id: operation.id } });
  }

  async applyEventToOperation(
    operation: Operation,
    event: WebhookEvent,
    dto: PaymentWebhookDto,
  ): Promise<{ operation: Operation; outcome: 'applied' | 'ignored' }> {
    const target = mapEventToStatus(dto.event_type);
    if (!target) {
      await this.mark(event.id, 'ignored', 'unknown_event_type');
      return { operation, outcome: 'ignored' };
    }

    if (
      operation.status === OperationStatus.COMPLETED ||
      operation.status === OperationStatus.FAILED
    ) {
      await this.mark(event.id, 'ignored', 'already_terminal');
      return { operation, outcome: 'ignored' };
    }

    if (
      target === OperationStatus.PENDING_PAYMENT &&
      statusRank(operation.status) > statusRank(OperationStatus.PENDING_PAYMENT)
    ) {
      await this.mark(event.id, 'ignored', 'out_of_order_stale_created');
      return { operation, outcome: 'ignored' };
    }

    if (target === OperationStatus.FAILED) {
      if (canTransition(operation.status, OperationStatus.FAILED)) {
        operation = await this.cashInService.transition(
          operation,
          OperationStatus.FAILED,
          {
            providerPaymentId: dto.provider_payment_id,
            failureReason: 'webhook_payment_failed',
          },
        );
      }
      await this.mark(event.id, 'applied');
      return { operation, outcome: 'applied' };
    }

    if (
      target === OperationStatus.PAYMENT_CONFIRMED ||
      target === OperationStatus.COMPLETED
    ) {
      if (!operation.providerPaymentId) {
        await this.operations.update(operation.id, {
          providerPaymentId: dto.provider_payment_id,
        });
        operation = {
          ...operation,
          providerPaymentId: dto.provider_payment_id,
        };
      }
      await this.cashInService.completeAfterProviderSuccess(
        operation,
        dto.provider_payment_id,
      );
      await this.mark(event.id, 'applied');
      const fresh = await this.operations.findOneOrFail({
        where: { id: operation.id },
      });
      return { operation: fresh, outcome: 'applied' };
    }

    if (target === OperationStatus.PENDING_PAYMENT) {
      if (canTransition(operation.status, OperationStatus.PENDING_PAYMENT)) {
        operation = await this.cashInService.transition(
          operation,
          OperationStatus.PENDING_PAYMENT,
          { providerPaymentId: dto.provider_payment_id },
        );
        await this.mark(event.id, 'applied');
        return { operation, outcome: 'applied' };
      }
      await this.mark(event.id, 'ignored', 'out_of_order_or_noop');
      return { operation, outcome: 'ignored' };
    }

    await this.mark(event.id, 'ignored', 'unhandled');
    return { operation, outcome: 'ignored' };
  }

  private async mark(
    id: string,
    status: 'applied' | 'ignored',
    reason?: string,
  ): Promise<void> {
    await this.webhookEvents.update(id, {
      status,
      ignoreReason: reason ?? null,
    });
  }
}

export function mapEventToStatus(eventType: string): OperationStatus | null {
  switch (eventType) {
    case 'payment.created':
      return OperationStatus.PENDING_PAYMENT;
    case 'payment.succeeded':
      return OperationStatus.COMPLETED;
    case 'payment.failed':
      return OperationStatus.FAILED;
    default:
      return null;
  }
}
