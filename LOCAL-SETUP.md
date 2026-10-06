# Run the configured DriveBox project


Use Node.js 22.12 or newer and MySQL 8. Start MySQL on localhost:3306 with the credentials in backend/.env. The configured database is `9drive`. These instructions are for running directly on your computer; the existing Docker instructions require container-specific database hostnames.

Open a terminal in the extracted `9drive/backend` directory and run:

```sh
npm ci
npm run prisma:generate
npm run db:migrate:deploy
npm run build
npm start
```

The migration command applies pending migrations. It does not reset your database. Run the build before npm start so dist/server.js exists. During development, `npm run dev` can replace the build/start commands.

Keep that terminal running. Open another terminal in `9drive/frontend` and run:

```sh
npm ci
npm run dev -- --host localhost --port 5173 --strictPort
```

Visit http://localhost:5173. Register or sign in, then open Settings and select Connect Google Drive. Google opens so you can select an account and approve Drive access. If the popup is blocked, the same flow opens in the current tab. Use localhost consistently rather than switching between localhost and 127.0.0.1, because browser login storage is specific to the origin.

Google configuration loads from backend/.env automatically when sign-in or account connection starts. A separate seed command is no longer required. A previously saved personal Google configuration takes priority for that user's Drive connections; public Google sign-in uses the global environment configuration.

In Google Cloud, the OAuth client must authorize this exact redirect URI:

```text
http://localhost:4000/connected-accounts/google/callback
```

Google requires the requested callback to match an authorized redirect URI exactly. See [Google's OAuth web-server documentation](https://developers.google.com/identity/protocols/oauth2/web-server#redirect-uri). The Google Drive API must also be enabled for your project, and the account must be allowed by your consent-screen configuration. These remote settings and your live Google consent were not verified here.

Your reCAPTCHA server secret is empty, so email registration currently does not require CAPTCHA. The frontend now reads that setting from the backend rather than showing a challenge solely because a site key exists. To enable CAPTCHA later, provide the matching RECAPTCHA_SECRET_KEY in backend/.env and restart the backend.

# What changed

Stage 8 adds Cloud Timeline with filterable activity history and pagination. See [STAGE-8.md](STAGE-8.md). Dropbox storage is added afterward; the supplied backend-only app key/secret are now configured. Follow [DROPBOX-SETUP.md](DROPBOX-SETUP.md) to register the callback before selecting Connect Dropbox in Settings. All other private environment values remain unchanged. See [DRIVEBOX-UPDATE.md](DRIVEBOX-UPDATE.md) for the redesign and verification.

Stage 5 adds Delivery Rooms in the sidebar. Create an expiring upload-only link, optionally set a password, and receive guest files through your existing storage accounts. See [STAGE-5.md](STAGE-5.md) for limits, recovery, and deployment details.

The API Keys page and sidebar button are removed. The refreshed interface includes File Protection, where you can select one, two, or three total copies and review background copy status. See [STAGE-4.md](STAGE-4.md) before enabling replication.

Connect Drive uses a frontend connection page that sends the app's Bearer token through the API helper. Direct browser visits to the backend /connected-accounts/google/connect route also lead through that page. Expired access tokens refresh automatically; expired login sessions return you to sign-in and resume the connection afterward. The authenticated connect-url API still requires a valid app token.

The explicit VITE_API_URL value is respected in production builds as well as development. The supplied encryption key retains its exact value and the original 32-character minimum validation. Google credentials are stored encrypted in MySQL and never sent to the frontend. OAuth state is claimed once to reject replayed callbacks. A temporary quota-sync failure no longer reports an otherwise successful account connection as failed.

If you use Postman or another API client, first POST your email/password to /auth/login, then send the returned accessToken in `Authorization: Bearer <accessToken>`. The Google client secret is not a Bearer token. For normal browser use, DriveBox manages this header automatically.

# Verification

The backend and frontend builds passed. The backend's 104 tests passed against a temporary MySQL database, including registration/login, environment configuration, Bearer authentication, token refresh, ownership checks, OAuth callback replay protection, and the Stages 1–5 and 8 upload, health, failover, replication, delivery-room, download fallback, quota, and cleanup regression tests, plus Dropbox linking, refresh, resumable recovery, cross-provider replication/failover and delivery. Five frontend API tests passed for URL selection, authentication headers, refresh coordination, login errors, and reauthentication redirects.

Google and Dropbox token exchange and cloud responses were simulated in automated tests. Live consent and real Google Drive/Dropbox connections were not performed. Browser UI interaction was not automatically tested.

Run frontend API tests with `npm test` from frontend. Backend integration tests require a separate migrated test database in TEST_DATABASE_URL; never point that variable at your live database.
