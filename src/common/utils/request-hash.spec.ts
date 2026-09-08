import { hashCashInRequest } from '../../common/utils/request-hash';

describe('hashCashInRequest', () => {
  it('is stable for equivalent payloads', () => {
    const a = hashCashInRequest({
      user_id: 'usr_1',
      amount: 100,
      currency: 'PEN',
      payment_method: 'card_xyz',
    });
    const b = hashCashInRequest({
      user_id: 'usr_1',
      amount: 100.0,
      currency: 'PEN',
      payment_method: 'card_xyz',
    });
    expect(a).toBe(b);
  });

  it('changes when amount changes', () => {
    const a = hashCashInRequest({
      user_id: 'usr_1',
      amount: 100,
      currency: 'PEN',
      payment_method: 'card_xyz',
    });
    const b = hashCashInRequest({
      user_id: 'usr_1',
      amount: 200,
      currency: 'PEN',
      payment_method: 'card_xyz',
    });
    expect(a).not.toBe(b);
  });
});
