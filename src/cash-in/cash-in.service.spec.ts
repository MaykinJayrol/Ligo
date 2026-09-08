import { ConflictException, UnprocessableEntityException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { hashCashInRequest } from '../common/utils/request-hash';
import { PAYMENT_PROVIDER } from '../payment-provider/payment-provider.interface';
import { WalletService } from '../wallet/wallet.service';
import { WebhookReplayService } from '../webhooks/webhook-replay.service';
import { CashInService } from './cash-in.service';
import { Operation } from './entities/operation.entity';
import { OperationStatus } from './state-machine/operation.state-machine';

describe('CashInService', () => {
  let service: CashInService;
  let provider: {
    charge: jest.Mock;
    getPaymentByIdempotencyKey: jest.Mock;
  };
  let walletService: {
    creditForOperation: jest.Mock;
    getBalance: jest.Mock;
  };
  let store: Map<string, Operation>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let operations: any;
  let replay: { applyBufferedForOperation: jest.Mock };

  const dto = {
    user_id: 'usr_abc123',
    amount: 100,
    currency: 'PEN',
    payment_method: 'card_xyz',
  };

  const idemKey = '11111111-1111-4111-8111-111111111111';

  beforeEach(async () => {
    store = new Map();

    operations = {
      create: (data: Partial<Operation>) => ({ ...data }) as Operation,
      save: async (op: Operation) => {
        const existing = [...store.values()].find(
          (o) => o.idempotencyKey === op.idempotencyKey && o.id !== op.id,
        );
        if (existing && !store.has(op.id)) {
          throw Object.assign(new Error('duplicate'), { code: '23505' });
        }
        const saved = {
          ...op,
          version: (op.version ?? 0) + 1,
          updatedAt: new Date(),
        };
        store.set(op.id, saved);
        return saved;
      },
      findOne: async ({ where }: { where: Record<string, string> }) => {
        if (where.idempotencyKey) {
          return (
            [...store.values()].find(
              (o) => o.idempotencyKey === where.idempotencyKey,
            ) ?? null
          );
        }
        if (where.id) return store.get(where.id) ?? null;
        if (where.providerPaymentId) {
          return (
            [...store.values()].find(
              (o) => o.providerPaymentId === where.providerPaymentId,
            ) ?? null
          );
        }
        return null;
      },
      findOneOrFail: async ({ where }: { where: { id: string } }) => {
        const found = store.get(where.id);
        if (!found) throw new Error('not found');
        return found;
      },
      update: async (id: string, patch: Partial<Operation>) => {
        const current = store.get(id);
        if (current) store.set(id, { ...current, ...patch, updatedAt: new Date() });
        return { affected: 1, raw: [], generatedMaps: [] };
      },
      createQueryBuilder: () => {
        const state: {
          id?: string;
          statuses?: string[];
          cutoff?: Date;
        } = {};
        const qb = {
          update: () => qb,
          set: () => qb,
          where: (_sql: string, params: { id: string }) => {
            state.id = params.id;
            return qb;
          },
          andWhere: (_sql: string, params: Record<string, unknown>) => {
            if (params.statuses) state.statuses = params.statuses as string[];
            if (params.cutoff) state.cutoff = params.cutoff as Date;
            return qb;
          },
          execute: async () => {
            const op = state.id ? store.get(state.id) : undefined;
            if (!op) return { affected: 0 };
            if (state.statuses && !state.statuses.includes(op.status)) {
              return { affected: 0 };
            }
            if (state.cutoff && op.updatedAt && op.updatedAt >= state.cutoff) {
              return { affected: 0 };
            }
            op.status = OperationStatus.CREATED;
            op.failureReason = 'resumed_after_stale_owner';
            op.updatedAt = new Date();
            store.set(op.id, op);
            return { affected: 1 };
          },
        };
        return qb;
      },
    };

    provider = {
      charge: jest.fn(),
      getPaymentByIdempotencyKey: jest.fn().mockResolvedValue({ found: false }),
    };

    walletService = {
      creditForOperation: jest.fn().mockResolvedValue({
        newBalance: '350.00',
        alreadyApplied: false,
      }),
      getBalance: jest.fn().mockResolvedValue('350.00'),
    };

    replay = {
      applyBufferedForOperation: jest.fn(async (op: Operation) => op),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CashInService,
        { provide: getRepositoryToken(Operation), useValue: operations },
        { provide: PAYMENT_PROVIDER, useValue: provider },
        { provide: WalletService, useValue: walletService },
        { provide: WebhookReplayService, useValue: replay },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => {
              if (key === 'resilience.dbRetryAttempts') return 2;
              if (key === 'resilience.dbRetryBaseMs') return 1;
              if (key === 'resilience.followerWaitMs') return 80;
              if (key === 'resilience.staleOperationMs') return 10;
              return undefined;
            },
          },
        },
        {
          provide: DataSource,
          useValue: {
            transaction: async (fn: (m: unknown) => Promise<unknown>) => {
              const manager = {
                getRepository: () => ({
                  createQueryBuilder: () => ({
                    setLock: () => ({
                      where: () => ({
                        getOneOrFail: async () => [...store.values()][0],
                      }),
                    }),
                  }),
                  save: async (op: Operation) => {
                    store.set(op.id, op);
                    return op;
                  },
                }),
              };
              return fn(manager);
            },
          },
        },
      ],
    }).compile();

    service = module.get(CashInService);
  });

  it('success: completes cash-in and returns new balance', async () => {
    provider.charge.mockResolvedValue({
      outcome: 'succeeded',
      providerPaymentId: 'pay_abc',
    });

    const result = await service.cashIn(dto, idemKey, 'corr-1');

    expect(result.status).toBe(OperationStatus.COMPLETED);
    expect(result.amount).toBe(100);
    expect(result.new_balance).toBe(350);
    expect(result.operation_id).toMatch(/^op_/);
    expect(provider.charge).toHaveBeenCalledTimes(1);
  });

  it('idempotency: same key returns same completed response without re-charging', async () => {
    provider.charge.mockResolvedValue({
      outcome: 'succeeded',
      providerPaymentId: 'pay_abc',
    });

    const first = await service.cashIn(dto, idemKey, 'corr-1');
    const second = await service.cashIn(dto, idemKey, 'corr-2');

    expect(second).toEqual(first);
    expect(provider.charge).toHaveBeenCalledTimes(1);
  });

  it('multi-pod: 5 concurrent same key → single charge', async () => {
    provider.charge.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 30));
      return { outcome: 'succeeded', providerPaymentId: 'pay_multi' };
    });

    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        service.cashIn(dto, idemKey, `corr-${i}`),
      ),
    );

    const ids = new Set(results.map((r) => r.operation_id));
    expect(ids.size).toBe(1);
    expect(provider.charge).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r.status === OperationStatus.COMPLETED)).toBe(
      true,
    );
  });

  it('idempotency conflict: same key different body → 409', async () => {
    provider.charge.mockResolvedValue({
      outcome: 'succeeded',
      providerPaymentId: 'pay_abc',
    });
    await service.cashIn(dto, idemKey, 'corr-1');

    await expect(
      service.cashIn({ ...dto, amount: 200 }, idemKey, 'corr-2'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('provider failure: marks failed and does not credit on retry', async () => {
    provider.charge.mockResolvedValue({
      outcome: 'failed',
      providerPaymentId: 'pay_fail',
      reason: 'provider_declined',
    });

    await expect(service.cashIn(dto, idemKey, 'corr-1')).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );

    await expect(service.cashIn(dto, idemKey, 'corr-2')).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    expect(provider.charge).toHaveBeenCalledTimes(1);
    expect(walletService.creditForOperation).not.toHaveBeenCalled();
  });

  it('provider timeout: does not charge again on client retry; reconciles instead', async () => {
    provider.charge.mockResolvedValue({
      outcome: 'timeout',
      providerPaymentId: 'pay_to',
      reason: 'provider_timeout_after_charge',
    });
    provider.getPaymentByIdempotencyKey
      .mockResolvedValueOnce({ found: false })
      .mockResolvedValue({
        found: true,
        providerPaymentId: 'pay_to',
        status: 'succeeded',
      });

    const first = await service.cashIn(dto, idemKey, 'corr-1');
    expect(first.status).toBe(OperationStatus.PROVIDER_UNKNOWN);

    const second = await service.cashIn(dto, idemKey, 'corr-2');
    expect(second.status).toBe(OperationStatus.COMPLETED);
    expect(provider.charge).toHaveBeenCalledTimes(1);
  });

  it('webhook before API: buffered succeeded completes without charging', async () => {
    replay.applyBufferedForOperation.mockImplementation(async (op: Operation) => {
      const completed: Operation = {
        ...op,
        status: OperationStatus.COMPLETED,
        providerPaymentId: 'pay_early',
        responseSnapshot: {
          operation_id: op.id,
          status: OperationStatus.COMPLETED,
          amount: 100,
          new_balance: 100,
        },
      };
      store.set(op.id, completed);
      return completed;
    });

    const result = await service.cashIn(dto, idemKey, 'corr-1');
    expect(result.status).toBe(OperationStatus.COMPLETED);
    expect(provider.charge).not.toHaveBeenCalled();
  });

  it('service restart: stale follower resumes with same provider key', async () => {
    // Seed a stale in-flight operation as if another pod died
    const stale: Operation = {
      id: 'op_stale00001',
      idempotencyKey: idemKey,
      userId: dto.user_id,
      amount: '100.00',
      currency: 'PEN',
      paymentMethod: 'card_xyz',
      status: OperationStatus.PENDING_PAYMENT,
      requestHash: hashCashInRequest(dto),
      providerPaymentId: null,
      correlationId: 'old',
      failureReason: null,
      responseSnapshot: null,
      version: 1,
      createdAt: new Date(Date.now() - 60_000),
      updatedAt: new Date(Date.now() - 60_000),
    };
    store.set(stale.id, stale);

    provider.charge.mockResolvedValue({
      outcome: 'succeeded',
      providerPaymentId: 'pay_resume',
    });

    const result = await service.cashIn(dto, idemKey, 'corr-resume');
    expect(result.status).toBe(OperationStatus.COMPLETED);
    expect(provider.charge).toHaveBeenCalledTimes(1);
    expect(provider.charge.mock.calls[0][0].idempotencyKey).toBe(idemKey);
  });
});
