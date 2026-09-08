import { Type } from 'class-transformer';
import {
  IsIn,
  IsNumber,
  IsObject,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
} from 'class-validator';

export class PaymentWebhookDto {
  @IsString()
  @MaxLength(128)
  event_id!: string;

  @IsString()
  @IsIn(['payment.created', 'payment.succeeded', 'payment.failed'])
  event_type!: string;

  @IsString()
  @MaxLength(128)
  provider_payment_id!: string;

  /** Idempotency key original del cargo — permite correlacionar si el webhook llega primero. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  idempotency_key?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  amount?: number;

  @IsOptional()
  @IsString()
  currency?: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
