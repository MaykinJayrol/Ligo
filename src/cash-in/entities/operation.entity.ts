import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
  VersionColumn,
} from 'typeorm';
import { OperationStatus } from '../state-machine/operation.state-machine';

@Entity('operations')
export class Operation {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  id!: string;

  /** Multi-pod claim: UNIQUE en DB — el INSERT atómico decide el ganador. */
  @Column({ name: 'idempotency_key', type: 'uuid', unique: true })
  idempotencyKey!: string;

  @Column({ name: 'user_id', type: 'varchar', length: 128 })
  userId!: string;

  @Column({ type: 'numeric', precision: 18, scale: 2 })
  amount!: string;

  @Column({ type: 'varchar', length: 8 })
  currency!: string;

  @Column({ name: 'payment_method', type: 'varchar', length: 128 })
  paymentMethod!: string;

  @Column({ type: 'varchar', length: 32 })
  status!: OperationStatus;

  /** Detecta mismo Idempotency-Key con body distinto → 409 Conflict. */
  @Column({ name: 'request_hash', type: 'varchar', length: 64 })
  requestHash!: string;

  @Index({ unique: true })
  @Column({ name: 'provider_payment_id', type: 'varchar', length: 128, nullable: true })
  providerPaymentId!: string | null;

  @Column({ name: 'correlation_id', type: 'varchar', length: 64 })
  correlationId!: string;

  @Column({ name: 'failure_reason', type: 'varchar', length: 512, nullable: true })
  failureReason!: string | null;

  /** Snapshot de la respuesta HTTP exitosa / final para retries. */
  @Column({ name: 'response_snapshot', type: 'jsonb', nullable: true })
  responseSnapshot!: Record<string, unknown> | null;

  @VersionColumn()
  version!: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
