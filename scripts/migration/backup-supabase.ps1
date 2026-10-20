param(
  [Parameter(Mandatory=$true)][string]$BackupDir
)
$ErrorActionPreference = 'Stop'
# EXPORT ONLY: this script does not connect to Neon, mutate Supabase, or delete source data.
# PGHOST, PGPORT, PGDATABASE, PGUSER and PGPASSWORD must be set in the invoking terminal.
# Password is supplied using a secure local prompt, NEVER as a command argument.
foreach ($name in @('PGHOST', 'PGDATABASE', 'PGUSER', 'PGPASSWORD')) {
  $value = [Environment]::GetEnvironmentVariable($name, 'Process')
  if ([string]::IsNullOrWhiteSpace($value)) { throw "Missing environment variable $name. Set it securely in this PowerShell session." }
}
foreach ($tool in @('pg_dump', 'pg_restore')) {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "$tool not found. Install PostgreSQL 17 or 18 client utilities before exporting." }
}
$version = (& pg_dump --version | Out-String).Trim()
if ($version -notmatch '(\d+)(?:\.\d+)?\s*$') { throw "Cannot determine pg_dump version." }
if ([int]$Matches[1] -lt 17) { throw "pg_dump version 17 or newer is required for Supabase PostgreSQL 17." }
if ([string]::IsNullOrWhiteSpace($env:PGPORT)) { $env:PGPORT = '5432' }
# Use the project CA downloaded from Supabase Dashboard > Database > Settings > SSL.
# The shared Supavisor pooler does not chain to a public root CA.
if ([string]::IsNullOrWhiteSpace($env:PGSSLROOTCERT) -or -not (Test-Path -LiteralPath $env:PGSSLROOTCERT -PathType Leaf)) {
  throw 'Missing official Supabase CA certificate (PGSSLROOTCERT). Download it from Supabase Database Settings; refuse insecure TLS fallback.'
}
$env:PGSSLMODE = 'verify-full'
$env:PGCONNECT_TIMEOUT = '20'
$root = [IO.Path]::GetFullPath($BackupDir)
[IO.Directory]::CreateDirectory($root) | Out-Null
$name = 'supabase-public-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '.dump'
$outPath = Join-Path $root $name
$tempPath = $outPath + '.partial'
$manifestPath = $outPath + '.manifest.json'
if (Test-Path -LiteralPath $outPath) { throw "Refusing to overwrite an existing backup" }
if (Test-Path -LiteralPath $tempPath) { throw "Refusing to overwrite a partial backup" }
if (Test-Path -LiteralPath $manifestPath) { throw "Refusing to overwrite a manifest" }
Write-Output 'Creating PUBLIC schema (structure AND data) custom-format backup with verified TLS. Credentials are not printed.'
& pg_dump --no-password --format=custom --no-owner --no-acl --schema=public --file=$tempPath
if ($LASTEXITCODE -ne 0) { throw "pg_dump failed. An incomplete .partial file may remain: $tempPath" }
$contents = & pg_restore --list $tempPath 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) { throw "pg_restore could not read archive; .partial file retained for diagnosis." }
if ($contents -notmatch 'TABLE DATA public products' -or $contents -notmatch 'TABLE DATA public price_history') {
  throw "Archive does not contain both public.products and public.price_history table data. Do not treat it as valid."
}
Move-Item -LiteralPath $tempPath -Destination $outPath -ErrorAction Stop
$hash = (Get-FileHash -LiteralPath $outPath -Algorithm SHA256).Hash.ToLowerInvariant()
$size = (Get-Item -LiteralPath $outPath).Length
$manifest = [pscustomobject]@{
  version = 1
  createdAt = ([DateTimeOffset]::UtcNow).ToString('o')
  source = 'supabase-public'
  note = 'PUBLIC schema only. No promise of complete Auth or Storage service migration.'
  files = @([pscustomobject]@{name = $name; bytes = [int64]$size; sha256 = $hash})
}
$manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
Write-Output ('BACKUP_CREATED archive=' + $outPath)
Write-Output ('BACKUP_MANIFEST=' + $manifestPath)
Write-Output ('BACKUP_SIZE_BYTES=' + $size)
Write-Output ('BACKUP_SHA256=' + $hash)
Write-Output 'NEXT: validate with verify-backup.js and independently compare table counts after a test restore.'
