import { createHash } from 'crypto';

export function hashCashInRequest(body: {
  user_id: string;
  amount: number;
  currency: string;
  payment_method: string;
}): string {
  const canonical = JSON.stringify({
    user_id: body.user_id,
    amount: Number(body.amount).toFixed(2),
    currency: body.currency,
    payment_method: body.payment_method,
  });
  return createHash('sha256').update(canonical).digest('hex');
}
