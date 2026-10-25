import type { Status } from '../../src/lifecycle';
import { STATUS_LABEL } from './api';

// Colour is always paired with the status name.
export function StatusBadge({ status }: { status: Status }) {
  return (
    <span className={`badge s-${status}`}>
      <span className="dot" aria-hidden="true" />
      {STATUS_LABEL[status]}
    </span>
  );
}
