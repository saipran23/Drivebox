import { prisma } from '../config/prisma.js'
import { encryptText } from '../utils/crypto.js'

const scopes = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
]

async function main() {
  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET
  const redirectUri = process.env.GOOGLE_REDIRECT_URI ?? 'http://localhost:4000/connected-accounts/google/callback'

  if (!clientId || !clientSecret) throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required.')

  await prisma.providerConfig.updateMany({
    where: { userId: null, provider: 'google_drive', status: 'active' },
    data: { status: 'disabled' },
  })

  const config = await prisma.providerConfig.create({
    data: {
      userId: null,
      provider: 'google_drive',
      clientIdEncrypted: encryptText(clientId),
      clientSecretEncrypted: encryptText(clientSecret),
      redirectUri,
      scopes,
      status: 'active',
    },
  })

  console.log(`Seeded global Google Drive config: ${config.id}`)
}

main()
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
