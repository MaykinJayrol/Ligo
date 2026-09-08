export enum OperationStatus {
  CREATED = 'created',
  PENDING_PAYMENT = 'pending_payment',
  PROVIDER_UNKNOWN = 'provider_unknown',
  PAYMENT_CONFIRMED = 'payment_confirmed',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

/** Terminal statuses — retries return stored outcome. */
export const TERMINAL_STATUSES: ReadonlySet<OperationStatus> = new Set([
  OperationStatus.COMPLETED,
  OperationStatus.FAILED,
]);

/**
 * Valid transitions for the cash-in state machine.
 * Out-of-order webhooks are handled by applying only legal edges
 * (or no-op when already past the event).
 */
const TRANSITIONS: Record<OperationStatus, ReadonlySet<OperationStatus>> = {
  [OperationStatus.CREATED]: new Set([
    OperationStatus.PENDING_PAYMENT,
    OperationStatus.PAYMENT_CONFIRMED, // webhook early / out-of-order
    OperationStatus.COMPLETED, // webhook early direct completion
    OperationStatus.FAILED,
  ]),
  [OperationStatus.PENDING_PAYMENT]: new Set([
    OperationStatus.PAYMENT_CONFIRMED,
    OperationStatus.PROVIDER_UNKNOWN,
    OperationStatus.FAILED,
    OperationStatus.COMPLETED,
  ]),
  [OperationStatus.PROVIDER_UNKNOWN]: new Set([
    OperationStatus.PAYMENT_CONFIRMED,
    OperationStatus.COMPLETED,
    OperationStatus.FAILED,
  ]),
  [OperationStatus.PAYMENT_CONFIRMED]: new Set([
    OperationStatus.COMPLETED,
    OperationStatus.FAILED,
  ]),
  [OperationStatus.COMPLETED]: new Set(),
  [OperationStatus.FAILED]: new Set(),
};

export function canTransition(
  from: OperationStatus,
  to: OperationStatus,
): boolean {
  if (from === to) return true; // idempotent no-op
  return TRANSITIONS[from]?.has(to) ?? false;
}

export function assertTransition(
  from: OperationStatus,
  to: OperationStatus,
): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid operation transition: ${from} -> ${to}`);
  }
}

/**
 * Rank used for out-of-order webhook handling:
 * a webhook that would move "backwards" is ignored (already applied / superseded).
 */
export function statusRank(status: OperationStatus): number {
  switch (status) {
    case OperationStatus.CREATED:
      return 0;
    case OperationStatus.PENDING_PAYMENT:
      return 1;
    case OperationStatus.PROVIDER_UNKNOWN:
      return 2;
    case OperationStatus.PAYMENT_CONFIRMED:
      return 3;
    case OperationStatus.COMPLETED:
      return 4;
    case OperationStatus.FAILED:
      return 4;
    default:
      return -1;
  }
}
