import dotenv from 'dotenv'
import { z } from 'zod'

dotenv.config()

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  APP_PORT: z.coerce.number().default(4000),
  FRONTEND_URL: z.string().url(),
  JWT_ACCESS_SECRET: z.string().min(32),
  TOKEN_ENCRYPTION_KEY: z.string().min(32),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().default(30),
  MAX_UPLOAD_BYTES: z.coerce.number().default(5 * 1024 * 1024 * 1024),
  PROVIDER_HEALTH_ENABLED: z.enum(['true', 'false']).default('true').transform(value => value === 'true'),
  PROVIDER_HEALTH_INTERVAL_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
  PROVIDER_HEALTH_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30000).default(8000),
  PROVIDER_HEALTH_FAILURE_THRESHOLD: z.coerce.number().int().min(2).max(10).default(3),
  PROVIDER_HEALTH_SLOW_MS: z.coerce.number().int().min(100).max(30000).default(2000),
  RECAPTCHA_SECRET_KEY: z.string().optional(),
  DROPBOX_CLIENT_ID: z.string().trim().optional(),
  DROPBOX_CLIENT_SECRET: z.string().trim().optional(),
  DROPBOX_REDIRECT_URI: z.string().trim().url().default('http://localhost:4000/connected-accounts/dropbox/callback'),
  GOOGLE_CLIENT_ID: z.string().trim().optional(),
  GOOGLE_CLIENT_SECRET: z.string().trim().optional(),
  GOOGLE_REDIRECT_URI: z.string().url().default('http://localhost:4000/connected-accounts/google/callback'),
})

export const env = envSchema.parse(process.env)
