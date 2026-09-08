import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
  VersionColumn,
} from 'typeorm';

@Entity('wallets')
export class Wallet {
  @PrimaryColumn({ name: 'user_id', type: 'varchar', length: 128 })
  userId!: string;

  @Column({ type: 'numeric', precision: 18, scale: 2, default: 0 })
  balance!: string;

  @Column({ type: 'varchar', length: 8, default: 'PEN' })
  currency!: string;

  /** Optimistic locking contra race condition sobre el saldo. */
  @VersionColumn()
  version!: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
