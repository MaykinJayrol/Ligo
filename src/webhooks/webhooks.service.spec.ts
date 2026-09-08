import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { CashInService } from '../cash-in/cash-in.service';
import { Operation } from '../cash-in/entities/operation.entity';
import { OperationStatus } from '../cash-in/state-machine/operation.state-machine';
import { WebhookEvent } from './entities/webhook-event.entity';
import { WebhookReplayService } from './webhook-replay.service';
import { WebhooksService } from './webhooks.service';

describe('WebhooksService', () => {
  let service: WebhooksService;
  let events: Map<string, WebhookEvent>;
  let cashIn: {
    findByProviderPaymentId: jest.Mock;
    findByIdempotencyKey: jest.Mock;
  };
  let replay: { applyEventToOperation: jest.Mock };

  beforeEach(async () => {
    events = new Map();
    cashIn = {
      findByProviderPaymentId: jest.fn(),
      findByIdempotencyKey: jest.fn(),
    };
    replay = {
      applyEventToOperation: jest.fn().mockResolvedValue({
        operation: { id: 'op_1', status: OperationStatus.COMPLETED },
        outcome: 'applied',
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhooksService,
        {
          provide: getRepositoryToken(WebhookEvent),
          useValue: {
            create: (data: Partial<WebhookEvent>) =>
              ({ id: data.providerEventId, ...data }) as WebhookEvent,
            save: async (event: WebhookEvent) => {
              if (events.has(event.providerEventId)) {
                throw Object.assign(new Error('dup'), { code: '23505' });
              }
              events.set(event.providerEventId, event);
              return event;
            },
            findOneOrFail: async ({
              where,
            }: {
              where: { providerEventId: string };
            }) => events.get(where.providerEventId)!,
            update: async (id: string, patch: Partial<WebhookEvent>) => {
              const current = [...events.values()].find((e) => e.id === id);
              if (current) Object.assign(current, patch);
            },
          },
        },
        { provide: CashInService, useValue: cashIn },
        { provide: WebhookReplayService, useValue: replay },
      ],
    }).compile();

    service = module.get(WebhooksService);
  });

  const baseDto = {
    event_id: 'evt_1',
    event_type: 'payment.succeeded' as const,
    provider_payment_id: 'pay_1',
    idempotency_key: '11111111-1111-4111-8111-111111111111',
    amount: 100,
    currency: 'PEN',
  };

  it('duplicity: second identical webhook is ignored as duplicate', async () => {
    cashIn.findByProviderPaymentId.mockResolvedValue({
      id: 'op_1',
      status: OperationStatus.PENDING_PAYMENT,
      providerPaymentId: null,
    });

    const first = await service.handlePaymentWebhook(baseDto);
    const second = await service.handlePaymentWebhook(baseDto);

    expect(first.status).toBe('applied');
    expect(second.status).toBe('duplicate');
    expect(replay.applyEventToOperation).toHaveBeenCalledTimes(1);
  });

  it('out-of-order: succeeded before created is applied via replay', async () => {
    cashIn.findByProviderPaymentId.mockResolvedValue(null);
    cashIn.findByIdempotencyKey.mockResolvedValue({
      id: 'op_1',
      status: OperationStatus.CREATED,
      providerPaymentId: null,
    });

    const result = await service.handlePaymentWebhook(baseDto);
    expect(result.status).toBe('applied');
    expect(replay.applyEventToOperation).toHaveBeenCalled();
  });

  it('webhook before API response: buffers when operation not found yet', async () => {
    cashIn.findByProviderPaymentId.mockResolvedValue(null);
    cashIn.findByIdempotencyKey.mockResolvedValue(null);

    const result = await service.handlePaymentWebhook(baseDto);
    expect(result.status).toBe('buffered');
    expect(result.reason).toContain('buffered');
    expect(replay.applyEventToOperation).not.toHaveBeenCalled();
  });
});
