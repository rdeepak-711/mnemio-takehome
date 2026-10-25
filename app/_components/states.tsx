import { errorText, isUnseeded } from './api';

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <p className="state state-loading" role="status">
      <span className="spinner" aria-hidden="true" />
      {label}
    </p>
  );
}

export function Empty() {
  return (
    <p className="state state-empty">
      No contacts yet. Run <code>npm run seed</code>.
    </p>
  );
}

// An unseeded database is shown as the empty state; anything else as an error with its message.
export function Failed({ error }: { error: unknown }) {
  if (isUnseeded(error)) return <Empty />;
  return (
    <p className="state state-error" role="alert">
      <strong>Could not load this.</strong> {errorText(error)}
    </p>
  );
}
