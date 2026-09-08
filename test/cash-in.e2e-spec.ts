import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { Operation } from '../src/cash-in/entities/operation.entity';
import { MockPaymentProviderService } from '../src/payment-provider/mock-payment-provider.service';
import { LedgerEntry } from '../src/wallet/entities/ledger-entry.entity';
import { Wallet } from '../src/wallet/entities/wallet.entity';
import { WebhookEvent } from '../src/webhooks/entities/webhook-event.entity';

/**
 * E2E contra Postgres real (docker-compose).
 * Cubre escenarios obligatorios + concurrencia + webhook anticipado + timeout.
 */
describe('Cash-in E2E (postgres)', () => {
  let app: INestApplication;
  let provider: MockPaymentProviderService;
  let operations: Repository<Operation>;
  let wallets: Repository<Wallet>;
  let ledger: Repository<LedgerEntry>;
  let webhooks: Repository<WebhookEvent>;

  const user = 'usr_e2e_1';

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();

    provider = app.get(MockPaymentProviderService);
    operations = app.get(getRepositoryToken(Operation));
    wallets = app.get(getRepositoryToken(Wallet));
    ledger = app.get(getRepositoryToken(LedgerEntry));
    webhooks = app.get(getRepositoryToken(WebhookEvent));
  }, 60000);

  beforeEach(async () => {
    provider.clear();
    await webhooks.clear();
    await ledger.clear();
    await operations.clear();
    await wallets.clear();
  });

  afterAll(async () => {
    await app.close();
  });

  it('success path', async () => {
    const key = randomUUID();
    const res = await request(app.getHttpServer())
      .post('/cash-in')
      .set('Idempotency-Key', key)
      .set('X-Correlation-Id', 'e2e-success')
      .send({
        user_id: user,
        amount: 100,
        currency: 'PEN',
        payment_method: 'card_ok',
      })
      .expect(200);

    expect(res.body.status).toBe('completed');
    expect(res.body.amount).toBe(100);
    expect(res.body.new_balance).toBe(100);
    expect(res.body.operation_id).toMatch(/^op_/);
    expect(res.headers['x-correlation-id']).toBe('e2e-success');
  });

  it('idempotency: duplicate request does not double credit', async () => {
    const key = randomUUID();
    const payload = {
      user_id: user,
      amount: 50,
      currency: 'PEN',
      payment_method: 'card_ok',
    };

    const first = await request(app.getHttpServer())
      .post('/cash-in')
      .set('Idempotency-Key', key)
      .send(payload);

    const second = await request(app.getHttpServer())
      .post('/cash-in')
      .set('Idempotency-Key', key)
      .send(payload);

    expect(first.body.operation_id).toBe(second.body.operation_id);
    expect(first.body).toEqual(second.body);

    const entries = await ledger.find({ where: { userId: user } });
    expect(entries).toHaveLength(1);

    const wallet = await wallets.findOneByOrFail({ userId: user });
    expect(parseFloat(wallet.balance)).toBe(50);
  });

  it('multi-pod simulation: 5 concurrent same Idempotency-Key → one credit', async () => {
    const key = randomUUID();
    const payload = {
      user_id: user,
      amount: 40,
      currency: 'PEN',
      payment_method: 'card_ok',
    };

    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(app.getHttpServer())
          .post('/cash-in')
          .set('Idempotency-Key', key)
          .send(payload),
      ),
    );

    const bodies = responses
      .filter((r) => r.status === 200)
      .map((r) => r.body);
    expect(bodies.length).toBe(5);
    const opIds = new Set(bodies.map((b) => b.operation_id));
    expect(opIds.size).toBe(1);
    expect(bodies.every((b) => b.status === 'completed')).toBe(true);

    const entries = await ledger.find({ where: { userId: user } });
    expect(entries).toHaveLength(1);
    const wallet = await wallets.findOneByOrFail({ userId: user });
    expect(parseFloat(wallet.balance)).toBe(40);
  });

  it('provider failure', async () => {
    const key = randomUUID();
    const res = await request(app.getHttpServer())
      .post('/cash-in')
      .set('Idempotency-Key', key)
      .send({
        user_id: user,
        amount: 100,
        currency: 'PEN',
        payment_method: 'card_fail',
      });

    expect(res.status).toBeGreaterThanOrEqual(400);
    const entries = await ledger.find({ where: { userId: user } });
    expect(entries).toHaveLength(0);
  });

  it('provider timeout then retry reconciles without double charge', async () => {
    const key = randomUUID();
    const payload = {
      user_id: user,
      amount: 70,
      currency: 'PEN',
      payment_method: 'card_timeout',
    };

    const first = await request(app.getHttpServer())
      .post('/cash-in')
      .set('Idempotency-Key', key)
      .send(payload);

    // May complete via immediate reconcile or stay provider_unknown
    expect(['provider_unknown', 'completed']).toContain(first.body.status);

    const second = await request(app.getHttpServer())
      .post('/cash-in')
      .set('Idempotency-Key', key)
      .send(payload);

    expect(second.body.status).toBe('completed');
    expect(second.body.operation_id).toBe(first.body.operation_id);

    const entries = await ledger.find({ where: { userId: user } });
    expect(entries).toHaveLength(1);
  });

  it('webhook duplicity does not double-complete', async () => {
    const key = randomUUID();
    const cash = await request(app.getHttpServer())
      .post('/cash-in')
      .set('Idempotency-Key', key)
      .send({
        user_id: user,
        amount: 25,
        currency: 'PEN',
        payment_method: 'card_ok',
      });

    const providerPaymentId = (
      await operations.findOneByOrFail({ idempotencyKey: key })
    ).providerPaymentId!;

    const event = {
      event_id: 'evt_dup_1',
      event_type: 'payment.succeeded',
      provider_payment_id: providerPaymentId,
      idempotency_key: key,
      amount: 25,
      currency: 'PEN',
    };

    const w1 = await request(app.getHttpServer())
      .post('/webhooks/payment')
      .send(event);
    const w2 = await request(app.getHttpServer())
      .post('/webhooks/payment')
      .send(event);

    expect(w1.body.status).toMatch(/applied|ignored/);
    expect(w2.body.status).toBe('duplicate');

    const entries = await ledger.find({ where: { userId: user } });
    expect(entries).toHaveLength(1);
    expect(cash.body.new_balance).toBe(25);
  });

  it('webhook before cash-in is buffered then applied on claim', async () => {
    const key = randomUUID();
    const providerPaymentId = `pay_${key.replace(/-/g, '').slice(0, 12)}`;

    const buffered = await request(app.getHttpServer())
      .post('/webhooks/payment')
      .send({
        event_id: 'evt_early_1',
        event_type: 'payment.succeeded',
        provider_payment_id: providerPaymentId,
        idempotency_key: key,
        amount: 33,
        currency: 'PEN',
      })
      .expect(200);

    expect(buffered.body.status).toBe('buffered');

    // Seed provider as already charged (webhook implies provider success)
    provider.seedPayment({
      providerPaymentId,
      idempotencyKey: key,
      status: 'succeeded',
      amount: 33,
      currency: 'PEN',
    });

    const cash = await request(app.getHttpServer())
      .post('/cash-in')
      .set('Idempotency-Key', key)
      .send({
        user_id: user,
        amount: 33,
        currency: 'PEN',
        payment_method: 'card_ok',
      })
      .expect(200);

    expect(cash.body.status).toBe('completed');
    expect(cash.body.new_balance).toBe(33);

    const entries = await ledger.find({ where: { userId: user } });
    expect(entries).toHaveLength(1);

    const evt = await webhooks.findOneByOrFail({ providerEventId: 'evt_early_1' });
    expect(evt.status).toBe('applied');
  });

  it('race on balance: concurrent different keys sum correctly', async () => {
    const amounts = [10, 20, 30];
    await Promise.all(
      amounts.map((amount) =>
        request(app.getHttpServer())
          .post('/cash-in')
          .set('Idempotency-Key', randomUUID())
          .send({
            user_id: user,
            amount,
            currency: 'PEN',
            payment_method: 'card_ok',
          })
          .expect(200),
      ),
    );

    const wallet = await wallets.findOneByOrFail({ userId: user });
    expect(parseFloat(wallet.balance)).toBe(60);
    const entries = await ledger.find({ where: { userId: user } });
    expect(entries).toHaveLength(3);
  });
});
