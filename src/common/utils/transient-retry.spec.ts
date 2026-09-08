import {
  isTransientDbError,
  withTransientRetry,
} from './transient-retry';

describe('transient retry (DB failures)', () => {
  it('retries transient errors then succeeds', async () => {
    let calls = 0;
    const result = await withTransientRetry(
      async () => {
        calls += 1;
        if (calls < 3) {
          throw Object.assign(new Error('connection terminated'), {
            code: 'ECONNREFUSED',
          });
        }
        return 'ok';
      },
      { attempts: 3, baseMs: 1, label: 'test_db' },
    );

    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  it('does not retry non-transient errors', async () => {
    let calls = 0;
    await expect(
      withTransientRetry(
        async () => {
          calls += 1;
          throw Object.assign(new Error('unique'), { code: '23505' });
        },
        { attempts: 3, baseMs: 1, label: 'test_unique' },
      ),
    ).rejects.toMatchObject({ code: '23505' });
    expect(calls).toBe(1);
  });

  it('classifies serialization/deadlock as transient', () => {
    expect(isTransientDbError({ code: '40001' })).toBe(true);
    expect(isTransientDbError({ code: '40P01' })).toBe(true);
    expect(isTransientDbError({ code: '23505' })).toBe(false);
  });
});
