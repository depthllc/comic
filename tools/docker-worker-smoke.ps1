$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$dockerConfig = Join-Path ([IO.Path]::GetTempPath()) "comic30-docker-cli-$PID"
$sourceContainer = "comic30-source-smoke-$PID"
$rigContainer = "comic30-rig-smoke-$PID"
$animationContainer = "comic30-animation-smoke-$PID"
$audioContainer = "comic30-audio-smoke-$PID"
$sourceImage = "comic30-source-assets:smoke"
$rigImage = "comic30-rigs:smoke"
$animationImage = "comic30-animation:smoke"
$audioImage = "comic30-audio:smoke"
$engineAccessible = $false

function Assert-LastExitCode([string]$operation) {
  if ($LASTEXITCODE -ne 0) {
    throw "$operation failed with exit code $LASTEXITCODE."
  }
}

function Read-WorkerHealth([string]$container, [int]$port) {
  $lastError = $null

  for ($attempt = 1; $attempt -le 20; $attempt += 1) {
    $raw = & docker exec $container node -e "fetch('http://127.0.0.1:$port/health').then(r=>r.text()).then(console.log).catch(e=>{console.error(e.message);process.exit(1)})" 2>&1
    if ($LASTEXITCODE -eq 0) {
      return (($raw -join "`n") | ConvertFrom-Json)
    }

    $lastError = $raw -join "`n"
    Start-Sleep -Milliseconds 500
  }

  throw "Worker $container did not expose its health contract: $lastError"
}

New-Item -ItemType Directory -Force -Path $dockerConfig | Out-Null
$env:DOCKER_CONFIG = $dockerConfig

Push-Location $repoRoot
try {
  Write-Host "Checking Docker Desktop engine access..." -ForegroundColor Cyan
  & docker version
  if ($LASTEXITCODE -ne 0) {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    throw "Docker Desktop denied engine access to $identity. Run npm run test:docker from a normal PowerShell window signed in as the Windows user ignit. Do not add a sandbox account to docker-users."
  }
  $engineAccessible = $true

  Write-Host "Building Comic30 source-asset worker..." -ForegroundColor Cyan
  & docker build --file workers/source-asset-worker/Dockerfile --tag $sourceImage .
  Assert-LastExitCode "Source-asset worker image build"

  Write-Host "Building Comic30 rig worker..." -ForegroundColor Cyan
  & docker build --file workers/rig-worker/Dockerfile --tag $rigImage .
  Assert-LastExitCode "Rig worker image build"

  Write-Host "Building Comic30 animation worker..." -ForegroundColor Cyan
  & docker build --file workers/animation-worker/Dockerfile --tag $animationImage .
  Assert-LastExitCode "Animation worker image build"

  Write-Host "Building Comic30 audio worker..." -ForegroundColor Cyan
  & docker build --file workers/audio-worker/Dockerfile --tag $audioImage .
  Assert-LastExitCode "Audio worker image build"

  & docker run --detach --rm --name $sourceContainer --no-healthcheck $sourceImage | Out-Null
  Assert-LastExitCode "Source-asset worker container start"

  & docker run --detach --rm --name $rigContainer --no-healthcheck $rigImage | Out-Null
  Assert-LastExitCode "Rig worker container start"

  & docker run --detach --rm --name $animationContainer --no-healthcheck $animationImage | Out-Null
  Assert-LastExitCode "Animation worker container start"

  & docker run --detach --rm --name $audioContainer --no-healthcheck $audioImage | Out-Null
  Assert-LastExitCode "Audio worker container start"

  $sourceHealth = Read-WorkerHealth $sourceContainer 5190
  $rigHealth = Read-WorkerHealth $rigContainer 5191
  $animationHealth = Read-WorkerHealth $animationContainer 5192
  $audioHealth = Read-WorkerHealth $audioContainer 5193

  if ($sourceHealth.service -ne "comic30-source-asset-worker") {
    throw "Unexpected source-worker health response."
  }
  if ($rigHealth.service -ne "comic30-rig-worker") {
    throw "Unexpected rig-worker health response."
  }
  if ($animationHealth.service -ne "comic30-animation-worker") {
    throw "Unexpected animation-worker health response."
  }
  if ($audioHealth.service -ne "comic30-audio-worker") {
    throw "Unexpected audio-worker health response."
  }

  Write-Host "Comic30 Docker images built and all four worker contracts started successfully." -ForegroundColor Green
  Write-Host ("Source worker: ready={0}; providers={1}" -f $sourceHealth.ready, (($sourceHealth.providers | ConvertTo-Json -Compress)))
  Write-Host ("Rig worker: ready={0}; generationReady={1}" -f $rigHealth.ready, $rigHealth.generationReady)
  Write-Host ("Animation worker: ready={0}; profiles={1}" -f $animationHealth.ready, (($animationHealth.profiles | ConvertTo-Json -Compress)))
  Write-Host ("Audio worker: ready={0}; provider={1}" -f $audioHealth.ready, (($audioHealth.provider | ConvertTo-Json -Compress)))
  Write-Host "A false provider-ready value is expected until TRELLIS.2, UniRig, MotionGPT/Blender, and AudioCraft are configured."
}
finally {
  if ($engineAccessible) {
    $cleanupErrorPreference = $ErrorActionPreference
    $ErrorActionPreference = "SilentlyContinue"
    try {
      & docker rm --force $sourceContainer 2>&1 | Out-Null
      & docker rm --force $rigContainer 2>&1 | Out-Null
      & docker rm --force $animationContainer 2>&1 | Out-Null
      & docker rm --force $audioContainer 2>&1 | Out-Null
    }
    finally {
      $ErrorActionPreference = $cleanupErrorPreference
    }
  }
  Pop-Location

  $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
  $resolvedConfig = [IO.Path]::GetFullPath($dockerConfig)
  if ($resolvedConfig.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $resolvedConfig)) {
    Remove-Item -LiteralPath $resolvedConfig -Recurse -Force
  }
}
