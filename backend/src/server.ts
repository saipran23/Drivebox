import { startDeliveryRoomWorker } from './modules/delivery-rooms/delivery-room.service.js'
import { startReplicationWorker } from './modules/replication/replication.service.js'
import { startFailoverCleanup } from './modules/uploads/failover-cleanup.service.js'
import { app } from './app.js'
import { env } from './config/env.js'
import { startProviderHealthMonitor } from './modules/provider-health/provider-health.service.js'

const stopDeliveryRooms = startDeliveryRoomWorker()
const stopReplicationWorker = startReplicationWorker()
const stopFailoverCleanup = startFailoverCleanup()
const stopHealthMonitor = startProviderHealthMonitor()
const server = app.listen(env.APP_PORT, () => {
  console.log(`Backend running on http://localhost:${env.APP_PORT}`)
})
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    stopHealthMonitor()
    stopDeliveryRooms()
    stopReplicationWorker()
    stopFailoverCleanup()
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 10000).unref()
  })
}
