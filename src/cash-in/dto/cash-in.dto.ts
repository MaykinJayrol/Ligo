import { Type } from 'class-transformer';
import {
  IsNumber,
  IsPositive,
  IsString,
  Length,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

export class CashInDto {
  @IsString()
  @MaxLength(128)
  user_id!: string;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Min(0.01)
  amount!: number;

  @IsString()
  @Length(3, 3)
  @Matches(/^[A-Z]{3}$/)
  currency!: string;

  @IsString()
  @MaxLength(128)
  payment_method!: string;
}

export class CashInResponseDto {
  operation_id!: string;
  status!: string;
  amount!: number;
  new_balance!: number;
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}
