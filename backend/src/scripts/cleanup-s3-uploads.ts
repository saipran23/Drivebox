import { cleanupFailedAttempts } from '../modules/uploads/failover-cleanup.service.js'
import { cleanupExpiredS3Uploads } from '../modules/uploads/s3-upload.service.js'
import { prisma } from '../config/prisma.js'

Promise.all([cleanupExpiredS3Uploads(), cleanupFailedAttempts()]).then(results => ({ cleaned: results.reduce((n, r) => n + r.cleaned, 0), failed: results.reduce((n, r) => n + r.failed, 0) })).then(result => { console.log(result); if (result.failed) process.exitCode = 1 }).catch(() => { console.error('Upload cleanup failed. Check database and storage access.'); process.exitCode = 1 }).finally(() => prisma.$disconnect())
