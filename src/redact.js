// Keys whose values are credentials rather than data. DEBUG logging prints Plaid
// responses and request bodies verbatim, so everything logged passes through
// redact() first. `access_token` is the important one — the long-lived
// credential for a linked bank. The rest are here so a change in response shape
// doesn't need re-auditing.
const SECRET_KEYS = new Set([
  'access_token',
  'public_token',
  'link_token',
  'user_token',
  'client_id',
  'secret',
  'password',
]);

const MASK = '***';

// Deep copy with every secret value masked. Safe on any value.
function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value === null || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      SECRET_KEYS.has(key) ? MASK : redact(nested),
    ])
  );
}

export { redact };
