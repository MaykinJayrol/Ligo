import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { PaymentWebhookDto } from './dto/payment-webhook.dto';
import { WebhooksService } from './webhooks.service';

@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooksService: WebhooksService) {}

  @HttpCode(200)
  @Post('payment')
  async payment(@Body() body: PaymentWebhookDto) {
    return this.webhooksService.handlePaymentWebhook(body);
  }
}
