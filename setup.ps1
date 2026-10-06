#Requires -Version 5.1
$ErrorActionPreference = "Stop"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "Node.js 20+ is required."
}

$nodeMajor = [int]((node --version).TrimStart("v").Split(".")[0])
if ($nodeMajor -lt 20) {
    throw "Node.js 20+ is required. Found $(node --version)."
}

function New-RandomHexKey {
    $bytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $rng.GetBytes($bytes)
    } finally {
        $rng.Dispose()
    }
    return ([BitConverter]::ToString($bytes) -replace "-", "").ToLowerInvariant()
}

$backendDir = Join-Path $PSScriptRoot "backend"
$frontendDir = Join-Path $PSScriptRoot "frontend"
$backendEnv = Join-Path $backendDir ".env"
$frontendEnv = Join-Path $frontendDir ".env"

if (-not (Test-Path -LiteralPath $backendEnv)) {
    $databaseUrl = Read-Host "MySQL DATABASE_URL [mysql://root@localhost:3306/9drive]"
    if ([string]::IsNullOrWhiteSpace($databaseUrl)) {
        $databaseUrl = "mysql://root@localhost:3306/9drive"
    }

    @(
        "DATABASE_URL=`"$databaseUrl`""
        "APP_PORT=4000"
        "FRONTEND_URL=`"http://localhost:5173`""
        "JWT_ACCESS_SECRET=`"$(New-RandomHexKey)`""
        "TOKEN_ENCRYPTION_KEY=`"$(New-RandomHexKey)`""
        "ACCESS_TOKEN_TTL_SECONDS=900"
        "REFRESH_TOKEN_TTL_DAYS=30"
        "MAX_UPLOAD_BYTES=5368709120"
        "RECAPTCHA_SECRET_KEY=`"`""
        "GOOGLE_CLIENT_ID=`"`""
        "GOOGLE_CLIENT_SECRET=`"`""
        "GOOGLE_REDIRECT_URI=`"http://localhost:4000/connected-accounts/google/callback`""
    ) | Set-Content -LiteralPath $backendEnv -Encoding UTF8
    Write-Host "Created backend/.env"
}

if (-not (Test-Path -LiteralPath $frontendEnv)) {
    @(
        "VITE_API_URL=http://localhost:4000"
        "VITE_RECAPTCHA_SITE_KEY="
    ) | Set-Content -LiteralPath $frontendEnv -Encoding UTF8
    Write-Host "Created frontend/.env"
}

Push-Location $backendDir
try {
    npm install
    if ($LASTEXITCODE -ne 0) { throw "Backend dependency installation failed." }
    npm run prisma:generate
    if ($LASTEXITCODE -ne 0) { throw "Prisma client generation failed." }
} finally {
    Pop-Location
}

Push-Location $frontendDir
try {
    npm install
    if ($LASTEXITCODE -ne 0) { throw "Frontend dependency installation failed." }
} finally {
    Pop-Location
}

Write-Host "Setup complete. Run migrations with: cd backend; npm run prisma:migrate"
