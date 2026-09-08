import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { LedgerEntry } from './entities/ledger-entry.entity';
import { Wallet } from './entities/wallet.entity';
import { WalletService } from './wallet.service';

describe('WalletService race on balance', () => {
  let service: WalletService;
  let balance = 0;
  let ledgerOps = new Set<string>();
  let lockHeld = false;

  beforeEach(async () => {
    balance = 0;
    ledgerOps = new Set();
    lockHeld = false;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WalletService,
        { provide: getRepositoryToken(Wallet), useValue: {} },
        { provide: getRepositoryToken(LedgerEntry), useValue: {} },
        {
          provide: DataSource,
          useValue: {
            transaction: async (fn: (m: unknown) => Promise<unknown>) => {
              while (lockHeld) {
                await new Promise((r) => setTimeout(r, 5));
              }
              lockHeld = true;
              try {
                const manager = {
                  query: async (sql: string, params?: string[]) => {
                    if (sql.includes('ledger_entries')) {
                      const operationId = params?.[0];
                      if (!operationId) return [];
                      if (ledgerOps.has(operationId)) return [];
                      ledgerOps.add(operationId);
                      return [{ id: 'led_' + operationId }];
                    }
                    // wallet upsert
                    return [];
                  },
                  findOne: async (
                    entity: unknown,
                    opts: { where: { operationId?: string; userId?: string } },
                  ) => {
                    if (entity === LedgerEntry && opts.where.operationId) {
                      return ledgerOps.has(opts.where.operationId)
                        ? { operationId: opts.where.operationId }
                        : null;
                    }
                    if (entity === Wallet) {
                      return {
                        userId: opts.where.userId,
                        balance: balance.toFixed(2),
                      };
                    }
                    return null;
                  },
                  findOneOrFail: async () => ({
                    userId: 'usr',
                    balance: balance.toFixed(2),
                  }),
                  getRepository: () => ({
                    createQueryBuilder: () => ({
                      setLock: () => ({
                        where: () => ({
                          getOneOrFail: async () => ({
                            userId: 'usr',
                            balance: balance.toFixed(2),
                          }),
                        }),
                      }),
                    }),
                  }),
                  save: async (entity: Wallet) => {
                    if ('balance' in entity) {
                      balance = parseFloat(entity.balance);
                    }
                    return entity;
                  },
                };
                return await fn(manager);
              } finally {
                lockHeld = false;
              }
            },
          },
        },
      ],
    }).compile();

    service = module.get(WalletService);
  });

  it('concurrent credits for different ops accumulate safely', async () => {
    const results = await Promise.all([
      service.creditForOperation({
        userId: 'usr',
        amount: '100.00',
        currency: 'PEN',
        operationId: 'op_a',
      }),
      service.creditForOperation({
        userId: 'usr',
        amount: '50.00',
        currency: 'PEN',
        operationId: 'op_b',
      }),
      service.creditForOperation({
        userId: 'usr',
        amount: '25.00',
        currency: 'PEN',
        operationId: 'op_c',
      }),
    ]);

    expect(ledgerOps.size).toBe(3);
    expect(balance).toBe(175);
    expect(results.map((r) => r.alreadyApplied)).toEqual([false, false, false]);
  });

  it('same operation_id credited twice is idempotent', async () => {
    const first = await service.creditForOperation({
      userId: 'usr',
      amount: '100.00',
      currency: 'PEN',
      operationId: 'op_same',
    });
    const second = await service.creditForOperation({
      userId: 'usr',
      amount: '100.00',
      currency: 'PEN',
      operationId: 'op_same',
    });

    expect(first.alreadyApplied).toBe(false);
    expect(second.alreadyApplied).toBe(true);
    expect(balance).toBe(100);
    expect(ledgerOps.size).toBe(1);
  });
});
