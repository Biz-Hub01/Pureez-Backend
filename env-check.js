// env-check.js content:
const requiredEnvVars = [
  'SUPABASE_URL',
  'SUPABASE_KEY',
  'MPESA_CONSUMER_KEY',
  'MPESA_CONSUMER_SECRET',
  'MPESA_BUSINESS_SHORTCODE',
  'MPESA_PASSKEY'
];

const missingVars = requiredEnvVars.filter(v => !process.env[v]);

if (missingVars.length > 0) {
  console.error('❌ Missing required environment variables:', missingVars.join(', '));
  process.exit(1);
} else {
  console.log('✅ All required environment variables are present');
}