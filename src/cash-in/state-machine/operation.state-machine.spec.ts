import {
  OperationStatus,
  canTransition,
  statusRank,
} from './operation.state-machine';

describe('Operation state machine', () => {
  it('allows webhook-early completion from created', () => {
    expect(canTransition(OperationStatus.CREATED, OperationStatus.COMPLETED)).toBe(
      true,
    );
    expect(
      canTransition(OperationStatus.CREATED, OperationStatus.PAYMENT_CONFIRMED),
    ).toBe(true);
  });

  it('allows provider_unknown recovery via webhook/reconcile', () => {
    expect(
      canTransition(OperationStatus.PROVIDER_UNKNOWN, OperationStatus.COMPLETED),
    ).toBe(true);
    expect(
      canTransition(OperationStatus.PROVIDER_UNKNOWN, OperationStatus.FAILED),
    ).toBe(true);
  });

  it('forbids resurrecting terminal states', () => {
    expect(canTransition(OperationStatus.COMPLETED, OperationStatus.FAILED)).toBe(
      false,
    );
    expect(canTransition(OperationStatus.FAILED, OperationStatus.COMPLETED)).toBe(
      false,
    );
  });

  it('treats same-status as idempotent no-op', () => {
    expect(canTransition(OperationStatus.COMPLETED, OperationStatus.COMPLETED)).toBe(
      true,
    );
  });

  it('ranks statuses for out-of-order webhook decisions', () => {
    expect(statusRank(OperationStatus.COMPLETED)).toBeGreaterThan(
      statusRank(OperationStatus.PENDING_PAYMENT),
    );
    expect(statusRank(OperationStatus.PAYMENT_CONFIRMED)).toBeGreaterThan(
      statusRank(OperationStatus.CREATED),
    );
  });
});
