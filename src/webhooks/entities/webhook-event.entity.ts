import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export type WebhookEventStatus =
  | 'received'
  | 'buffered'
  | 'applied'
  | 'ignored';

@Entity('webhook_events')
export class WebhookEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Idempotencia de webhook: el mismo event_id del proveedor se ignora. */
  @Index({ unique: true })
  @Column({ name: 'provider_event_id', type: 'varchar', length: 128 })
  providerEventId!: string;

  @Column({ name: 'provider_payment_id', type: 'varchar', length: 128 })
  @Index()
  providerPaymentId!: string;

  /** Permite replay cuando el webhook llegó antes que el POST /cash-in. */
  @Index()
  @Column({ name: 'idempotency_key', type: 'uuid', nullable: true })
  idempotencyKey!: string | null;

  @Column({ name: 'event_type', type: 'varchar', length: 64 })
  eventType!: string;

  @Column({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  @Column({ type: 'varchar', length: 32, default: 'received' })
  status!: WebhookEventStatus;

  @Column({ name: 'ignore_reason', type: 'varchar', length: 256, nullable: true })
  ignoreReason!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
