// Keys whose values are credentials rather than data. Plaid responses and our
// own request bodies both carry them, and DEBUG logging prints both verbatim,
// so everything logged goes through redact() first.
//
// `access_token` is the important one: it is the long-lived credential for a
// linked bank, and it appears in the token exchange response.
const SECRET_KEYS = new Set([
  'access_token',
  'public_token',
  'link_token',
  'client_id',
  'secret',
  'password',
]);

const MASK = '***';

// Returns a deep copy with every secret value masked. Primitives pass through,
// so this is safe to call on anything loggable.
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
