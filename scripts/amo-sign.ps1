#Requires -Version 7
<#
.SYNOPSIS
  Sign a WebExtension source directory with Mozilla AMO (unlisted by default).
  Credentials are read from amo-credentials.json next to this script and are
  never printed or logged by this script.

.EXAMPLE
  pwsh C:\Users\devl\OneDrive\MyDocs\keys\amo-sign.ps1 -SourceDir C:\stage\my-ext
#>
param(
  [Parameter(Mandatory = $true)]
  [string]$SourceDir,

  [Parameter(Mandatory = $true)]
  [string]$CredentialsFile,

  [string]$ArtifactsDir = "$env:USERPROFILE\Downloads\amo-signed",

  [ValidateSet('unlisted', 'listed')]
  [string]$Channel = 'unlisted'
)

$ErrorActionPreference = 'Stop'
$credsPath = Resolve-Path $CredentialsFile
if (-not (Test-Path $credsPath)) { throw "Credentials file not found: $credsPath" }

$creds = Get-Content $credsPath -Raw | ConvertFrom-Json
if (-not $creds.amo_api_key -or -not $creds.amo_api_secret) {
  throw "Credentials file must contain amo_api_key and amo_api_secret"
}

$source = Resolve-Path $SourceDir
New-Item -ItemType Directory -Path $ArtifactsDir -Force | Out-Null

$webExt = Get-Command web-ext -ErrorAction SilentlyContinue
if (-not $webExt) {
  $cmd = "$env:APPDATA\npm\web-ext.cmd"
  if (Test-Path $cmd) { $webExtCmd = $cmd } else { throw 'web-ext not found in PATH' }
} else {
  $webExtCmd = $webExt.Source
}

& $webExtCmd sign `
  --api-key $creds.amo_api_key `
  --api-secret $creds.amo_api_secret `
  --channel $Channel `
  --source-dir $source `
  --artifacts-dir $ArtifactsDir

if ($LASTEXITCODE -ne 0) { throw "web-ext sign failed with exit code $LASTEXITCODE" }

"--- signed artifacts ---"
Get-ChildItem $ArtifactsDir -Filter *.xpi |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 3 FullName, Length, LastWriteTime | Format-List
