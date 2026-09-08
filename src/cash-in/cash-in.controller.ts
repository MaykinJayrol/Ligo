import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { CashInDto, isUuid } from './dto/cash-in.dto';
import { CashInService } from './cash-in.service';

@Controller()
export class CashInController {
  constructor(private readonly cashInService: CashInService) {}

  @HttpCode(200)
  @Post('cash-in')
  async cashIn(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: CashInDto,
    @Req() req: Request,
  ) {
    if (!idempotencyKey || !isUuid(idempotencyKey)) {
      throw new BadRequestException(
        'Header Idempotency-Key is required and must be a UUID',
      );
    }

    const correlationId = req.correlationId ?? idempotencyKey;
    return this.cashInService.cashIn(body, idempotencyKey, correlationId);
  }
}
