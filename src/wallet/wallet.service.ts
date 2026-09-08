import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { Wallet } from './entities/wallet.entity';
import { LedgerEntry } from './entities/ledger-entry.entity';

@Injectable()
export class WalletService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(Wallet)
    private readonly wallets: Repository<Wallet>,
    @InjectRepository(LedgerEntry)
    private readonly ledger: Repository<LedgerEntry>,
  ) {}

  /**
   * Upsert seguro bajo concurrencia (evita abortar la tx con 23505).
   */
  async ensureWalletLocked(
    userId: string,
    currency: string,
    manager: EntityManager,
  ): Promise<Wallet> {
    await manager.query(
      `
      INSERT INTO wallets (user_id, balance, currency, version, created_at, updated_at)
      VALUES ($1, '0.00', $2, 1, NOW(), NOW())
      ON CONFLICT (user_id) DO NOTHING
      `,
      [userId, currency],
    );

    return manager
      .getRepository(Wallet)
      .createQueryBuilder('w')
      .setLock('pessimistic_write')
      .where('w.user_id = :userId', { userId })
      .getOneOrFail();
  }

  /**
   * Acredita saldo de forma atómica e idempotente.
   * Usa ON CONFLICT para no abortar la transacción Postgres en carreras.
   */
  async creditForOperation(params: {
    userId: string;
    amount: string;
    currency: string;
    operationId: string;
    manager?: EntityManager;
  }): Promise<{ newBalance: string; alreadyApplied: boolean }> {
    const run = async (manager: EntityManager) => {
      const existing = await manager.findOne(LedgerEntry, {
        where: { operationId: params.operationId },
      });
      if (existing) {
        const wallet = await manager.findOneOrFail(Wallet, {
          where: { userId: params.userId },
        });
        return { newBalance: wallet.balance, alreadyApplied: true };
      }

      const wallet = await this.ensureWalletLocked(
        params.userId,
        params.currency,
        manager,
      );

      const inserted: Array<{ id: string }> = await manager.query(
        `
        INSERT INTO ledger_entries (id, operation_id, user_id, amount, currency, type, created_at)
        VALUES (gen_random_uuid(), $1, $2, $3, $4, 'CREDIT', NOW())
        ON CONFLICT (operation_id) DO NOTHING
        RETURNING id
        `,
        [params.operationId, params.userId, params.amount, params.currency],
      );

      if (!inserted.length) {
        const w = await manager.findOneOrFail(Wallet, {
          where: { userId: params.userId },
        });
        return { newBalance: w.balance, alreadyApplied: true };
      }

      const current = parseFloat(wallet.balance);
      const delta = parseFloat(params.amount);
      const newBalance = (current + delta).toFixed(2);
      wallet.balance = newBalance;
      await manager.save(wallet);

      return { newBalance, alreadyApplied: false };
    };

    if (params.manager) {
      return run(params.manager);
    }
    return this.dataSource.transaction(run);
  }

  async getBalance(userId: string): Promise<string> {
    const wallet = await this.wallets.findOne({ where: { userId } });
    return wallet?.balance ?? '0.00';
  }
}
