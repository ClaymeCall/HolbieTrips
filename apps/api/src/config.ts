/** Reads a required setting while allowing a local-only development default. */
const required = (name: string, fallback?: string): string => {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`Configuration manquante: ${name}`);
  return value;
};

/** Parses common truthy environment values for feature switches. */
const enabled = (name: string, fallback = false): boolean => {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
};

/** Immutable runtime configuration shared by API route modules. */
export const config = {
  port: Number(process.env.PORT ?? 8080),
  databaseUrl: required('DATABASE_URL', 'postgresql://holbie:local_demo_database_password@127.0.0.1:5432/holbietrips'),
  paymentUrl: required('FAKE_PAYMENT_URL', 'http://fake-payment:8081'),
  mailUrl: required('FAKE_MAIL_URL', 'http://fake-mail:8082'),
  paymentKey: required('PAYMENT_SIGNING_KEY', 'local-demo-payment-signing-key-not-a-real-secret'),
  encryptionKey: required('APP_ENCRYPTION_KEY', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'),
  sessionHours: Number(process.env.SESSION_TTL_HOURS ?? 8),
  supportDiagnosticsEnabled: enabled('SUPPORT_DIAGNOSTICS_ENABLED'),
  destinationPackFile: required('DESTINATION_PACK_FILE', `${process.cwd()}/database/fixtures/destination-pack-approved.json`),
  destinationPackSha256: required('DESTINATION_PACK_SHA256', '78f5ba6c78041a2f7cff89ad032c5df7a5a03c9dddbe63150d7ca2d23be4bc93')
};
