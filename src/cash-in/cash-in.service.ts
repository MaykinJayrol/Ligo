import {
  ConflictException,
  Inject,
  Injectable,
  UnprocessableEntityException,
  forwardRef,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { hashCashInRequest } from '../common/utils/request-hash';
import { withTransientRetry } from '../common/utils/transient-retry';
import {
  PAYMENT_PROVIDER,
  PaymentProvider,
} from '../payment-provider/payment-provider.interface';
import { WalletService } from '../wallet/wallet.service';
import { WebhookReplayService } from '../webhooks/webhook-replay.service';
import { CashInDto, CashInResponseDto } from './dto/cash-in.dto';
import { Operation } from './entities/operation.entity';
import {
  OperationStatus,
  TERMINAL_STATUSES,
  assertTransition,
  canTransition,
} from './state-machine/operation.state-machine';

@Injectable()
export class CashInService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    @InjectRepository(Operation)
    private readonly operations: Repository<Operation>,
    @Inject(PAYMENT_PROVIDER)
    private readonly provider: PaymentProvider,
    private readonly walletService: WalletService,
    @Inject(forwardRef(() => WebhookReplayService))
    private readonly webhookReplay: WebhookReplayService,
  ) {}

  async cashIn(
    dto: CashInDto,
    idempotencyKey: string,
    correlationId: string,
  ): Promise<CashInResponseDto> {
    const requestHash = hashCashInRequest(dto);
    const claimed = await this.claimOrLoad(
      dto,
      idempotencyKey,
      requestHash,
      correlationId,
    );

    // Webhook pudo llegar antes: aplica buffered antes de decidir cobrar
    let operation = await this.webhookReplay.applyBufferedForOperation(
      claimed.operation,
    );

    if (
      operation.status === OperationStatus.COMPLETED &&
      operation.responseSnapshot
    ) {
      return operation.responseSnapshot as unknown as CashInResponseDto;
    }

    if (operation.status === OperationStatus.FAILED) {
      throw new UnprocessableEntityException({
        ...(operation.responseSnapshot ?? {
          operation_id: operation.id,
          status: operation.status,
          amount: parseFloat(operation.amount),
        }),
        reason: operation.failureReason ?? 'payment_failed',
      });
    }

    if (claimed.existing) {
      return this.handleExistingFollower(operation);
    }

    return this.processNewOperation(operation);
  }

  /**
   * Claim atómico multi-pod: INSERT con UNIQUE(idempotency_key).
   * Solo un pod gana; el resto recibe 23505 y carga la fila existente.
   */
  private async claimOrLoad(
    dto: CashInDto,
    idempotencyKey: string,
    requestHash: string,
    correlationId: string,
  ): Promise<{ existing: boolean; operation: Operation }> {
    const operationId = `op_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const attempts = this.config.get<number>('resilience.dbRetryAttempts') ?? 3;
    const baseMs = this.config.get<number>('resilience.dbRetryBaseMs') ?? 50;

    return withTransientRetry(
      async () => {
        try {
          const operation = this.operations.create({
            id: operationId,
            idempotencyKey,
            userId: dto.user_id,
            amount: Number(dto.amount).toFixed(2),
            currency: dto.currency,
            paymentMethod: dto.payment_method,
            status: OperationStatus.CREATED,
            requestHash,
            providerPaymentId: null,
            correlationId,
            failureReason: null,
            responseSnapshot: null,
          });
          const saved = await this.operations.save(operation);
          return { existing: false, operation: saved };
        } catch (error) {
          if (isUniqueViolation(error)) {
            const existing = await this.operations.findOne({
              where: { idempotencyKey },
            });
            if (!existing) {
              throw error;
            }
            if (existing.requestHash !== requestHash) {
              throw new ConflictException({
                message:
                  'Idempotency-Key reused with a different request payload',
                idempotency_key: idempotencyKey,
              });
            }
            return { existing: true, operation: existing };
          }
          throw error;
        }
      },
      { attempts, baseMs, label: 'claim_operation' },
    );
  }

  /**
   * Pods perdedores NUNCA cobran de nuevo.
   * Esperan progreso del owner, reconcilian, o retoman si el owner murió (stale).
   */
  private async handleExistingFollower(
    operation: Operation,
  ): Promise<CashInResponseDto> {
    if (
      operation.status === OperationStatus.COMPLETED &&
      operation.responseSnapshot
    ) {
      return operation.responseSnapshot as unknown as CashInResponseDto;
    }

    if (operation.status === OperationStatus.FAILED) {
      throw new UnprocessableEntityException({
        ...(operation.responseSnapshot ?? {
          operation_id: operation.id,
          status: operation.status,
          amount: parseFloat(operation.amount),
        }),
        reason: operation.failureReason ?? 'payment_failed',
      });
    }

    const waited = await this.waitUntilSettled(operation.id);
    return this.reconcileWithoutCharging(waited);
  }

  /**
   * Pregunta central: timeout / in-flight → reconciliar, no re-cobrar.
   * Solo resume charge si la operación quedó stale tras reinicio del owner.
   */
  private async reconcileWithoutCharging(
    operation: Operation,
  ): Promise<CashInResponseDto> {
    let current = await this.operations.findOneOrFail({
      where: { id: operation.id },
    });

    if (
      current.status === OperationStatus.COMPLETED &&
      current.responseSnapshot
    ) {
      return current.responseSnapshot as unknown as CashInResponseDto;
    }

    if (current.status === OperationStatus.FAILED) {
      throw new UnprocessableEntityException({
        ...(current.responseSnapshot ?? {
          operation_id: current.id,
          status: current.status,
          amount: parseFloat(current.amount),
        }),
        reason: current.failureReason ?? 'payment_failed',
      });
    }

    const remote = await this.provider.getPaymentByIdempotencyKey(
      current.idempotencyKey,
    );

    if (remote.found && remote.status === 'succeeded') {
      return this.completeAfterProviderSuccess(
        current,
        remote.providerPaymentId,
      );
    }

    if (remote.found && remote.status === 'failed') {
      await this.transition(current, OperationStatus.FAILED, {
        failureReason: 'provider_reconciled_failed',
        providerPaymentId: remote.providerPaymentId,
      });
      throw new UnprocessableEntityException({
        operation_id: current.id,
        status: OperationStatus.FAILED,
        reason: 'provider_reconciled_failed',
      });
    }

    // Reinicio del servicio: owner murió en CREATED/PENDING sin cobro remoto
    if (
      (current.status === OperationStatus.CREATED ||
        current.status === OperationStatus.PENDING_PAYMENT) &&
      (await this.tryResumeIfStale(current))
    ) {
      current = await this.operations.findOneOrFail({
        where: { id: current.id },
      });
      return this.processNewOperation(current);
    }

    return {
      operation_id: current.id,
      status: current.status,
      amount: parseFloat(current.amount),
      new_balance: parseFloat(
        await this.walletService.getBalance(current.userId),
      ),
    };
  }

  private async processNewOperation(
    operation: Operation,
  ): Promise<CashInResponseDto> {
    // Si un webhook buffered ya confirmó, no cobrar otra vez
    if (
      operation.status === OperationStatus.COMPLETED &&
      operation.responseSnapshot
    ) {
      return operation.responseSnapshot as unknown as CashInResponseDto;
    }
    if (
      operation.status === OperationStatus.PAYMENT_CONFIRMED ||
      operation.status === OperationStatus.PROVIDER_UNKNOWN
    ) {
      const remote = await this.provider.getPaymentByIdempotencyKey(
        operation.idempotencyKey,
      );
      if (remote.found && remote.status === 'succeeded') {
        return this.completeAfterProviderSuccess(
          operation,
          remote.providerPaymentId,
        );
      }
    }

    if (operation.status === OperationStatus.CREATED) {
      await this.transition(operation, OperationStatus.PENDING_PAYMENT);
    }

    const chargeResult = await this.provider.charge({
      idempotencyKey: operation.idempotencyKey,
      amount: parseFloat(operation.amount),
      currency: operation.currency,
      paymentMethod: operation.paymentMethod,
      userId: operation.userId,
    });

    if (chargeResult.outcome === 'timeout') {
      await this.transition(operation, OperationStatus.PROVIDER_UNKNOWN, {
        providerPaymentId: chargeResult.providerPaymentId,
        failureReason: chargeResult.reason,
      });

      const remote = await this.provider.getPaymentByIdempotencyKey(
        operation.idempotencyKey,
      );
      if (remote.found && remote.status === 'succeeded') {
        return this.completeAfterProviderSuccess(
          operation,
          remote.providerPaymentId,
        );
      }

      return {
        operation_id: operation.id,
        status: OperationStatus.PROVIDER_UNKNOWN,
        amount: parseFloat(operation.amount),
        new_balance: parseFloat(
          await this.walletService.getBalance(operation.userId),
        ),
      };
    }

    if (chargeResult.outcome === 'failed') {
      await this.transition(operation, OperationStatus.FAILED, {
        providerPaymentId: chargeResult.providerPaymentId,
        failureReason: chargeResult.reason,
      });
      const body = {
        operation_id: operation.id,
        status: OperationStatus.FAILED,
        amount: parseFloat(operation.amount),
        new_balance: parseFloat(
          await this.walletService.getBalance(operation.userId),
        ),
      };
      await this.operations.update(operation.id, {
        responseSnapshot: body,
      });
      throw new UnprocessableEntityException({
        ...body,
        reason: chargeResult.reason,
      });
    }

    return this.completeAfterProviderSuccess(
      operation,
      chargeResult.providerPaymentId,
    );
  }

  async completeAfterProviderSuccess(
    operation: Operation,
    providerPaymentId: string,
  ): Promise<CashInResponseDto> {
    const current = await this.operations.findOneOrFail({
      where: { id: operation.id },
    });

    if (
      current.status === OperationStatus.COMPLETED &&
      current.responseSnapshot
    ) {
      return current.responseSnapshot as unknown as CashInResponseDto;
    }

    if (
      current.status !== OperationStatus.PAYMENT_CONFIRMED &&
      current.status !== OperationStatus.COMPLETED
    ) {
      if (canTransition(current.status, OperationStatus.PAYMENT_CONFIRMED)) {
        await this.transition(current, OperationStatus.PAYMENT_CONFIRMED, {
          providerPaymentId,
        });
      }
    }

    const { newBalance } = await this.dataSource.transaction(async (manager) => {
      const opRepo = manager.getRepository(Operation);
      const locked = await opRepo
        .createQueryBuilder('o')
        .setLock('pessimistic_write')
        .where('o.id = :id', { id: current.id })
        .getOneOrFail();

      if (locked.status === OperationStatus.COMPLETED && locked.responseSnapshot) {
        return {
          newBalance: (
            locked.responseSnapshot as { new_balance: number }
          ).new_balance.toFixed(2),
        };
      }

      assertTransition(locked.status, OperationStatus.COMPLETED);

      const credit = await this.walletService.creditForOperation({
        userId: locked.userId,
        amount: locked.amount,
        currency: locked.currency,
        operationId: locked.id,
        manager,
      });

      const response: CashInResponseDto = {
        operation_id: locked.id,
        status: OperationStatus.COMPLETED,
        amount: parseFloat(locked.amount),
        new_balance: parseFloat(credit.newBalance),
      };
      locked.status = OperationStatus.COMPLETED;
      locked.providerPaymentId = providerPaymentId;
      locked.responseSnapshot = response as unknown as Record<string, unknown>;
      await opRepo.save(locked);
      return { newBalance: credit.newBalance };
    });

    const fresh = await this.operations.findOneOrFail({
      where: { id: current.id },
    });
    if (fresh.responseSnapshot) {
      return fresh.responseSnapshot as unknown as CashInResponseDto;
    }

    return {
      operation_id: fresh.id,
      status: fresh.status,
      amount: parseFloat(fresh.amount),
      new_balance: parseFloat(newBalance),
    };
  }

  async findByProviderPaymentId(
    providerPaymentId: string,
  ): Promise<Operation | null> {
    return this.operations.findOne({ where: { providerPaymentId } });
  }

  async findByIdempotencyKey(key: string): Promise<Operation | null> {
    return this.operations.findOne({ where: { idempotencyKey: key } });
  }

  async transition(
    operation: Operation,
    to: OperationStatus,
    patch?: Partial<
      Pick<Operation, 'providerPaymentId' | 'failureReason' | 'responseSnapshot'>
    >,
  ): Promise<Operation> {
    const current = await this.operations.findOneOrFail({
      where: { id: operation.id },
    });

    if (current.status === to) {
      if (patch) {
        Object.assign(current, patch);
        return this.operations.save(current);
      }
      return current;
    }

    if (TERMINAL_STATUSES.has(current.status)) {
      return current;
    }

    assertTransition(current.status, to);
    current.status = to;
    if (patch?.providerPaymentId !== undefined) {
      current.providerPaymentId = patch.providerPaymentId;
    }
    if (patch?.failureReason !== undefined) {
      current.failureReason = patch.failureReason;
    }
    if (patch?.responseSnapshot !== undefined) {
      current.responseSnapshot = patch.responseSnapshot;
    }
    return this.operations.save(current);
  }

  /** Espera a que el pod owner avance (doble-click / retry concurrente). */
  private async waitUntilSettled(operationId: string): Promise<Operation> {
    const maxMs = this.config.get<number>('resilience.followerWaitMs') ?? 1500;
    const start = Date.now();
    let op = await this.operations.findOneOrFail({ where: { id: operationId } });

    while (Date.now() - start < maxMs) {
      if (
        TERMINAL_STATUSES.has(op.status) ||
        op.status === OperationStatus.PROVIDER_UNKNOWN ||
        op.status === OperationStatus.PAYMENT_CONFIRMED
      ) {
        return op;
      }
      await sleep(40);
      op = await this.operations.findOneOrFail({ where: { id: operationId } });
    }
    return op;
  }

  /**
   * Retoma solo si el owner parece muerto (reinicio mid-flight).
   * UPDATE condicional = un solo pod gana el resume.
   */
  private async tryResumeIfStale(operation: Operation): Promise<boolean> {
    const staleMs = this.config.get<number>('resilience.staleOperationMs') ?? 3000;
    const cutoff = new Date(Date.now() - staleMs);
    const result = await this.operations
      .createQueryBuilder()
      .update(Operation)
      .set({
        status: OperationStatus.CREATED,
        failureReason: 'resumed_after_stale_owner',
      })
      .where('id = :id', { id: operation.id })
      .andWhere('status IN (:...statuses)', {
        statuses: [
          OperationStatus.CREATED,
          OperationStatus.PENDING_PAYMENT,
        ],
      })
      .andWhere('updated_at < :cutoff', { cutoff })
      .execute();

    return (result.affected ?? 0) > 0;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
