import { PrismaClient } from '@prisma/client'

export const prisma = new PrismaClient({
  transactionOptions: {
    maxWait: 10000,
    timeout: 30000,
  },
})
