#Requires -Version 7
param(
  [string]$Version = '1.2.0',
  [string]$OutFile = "$env:USERPROFILE\Downloads\amo-signed\tab-recorder-$Version-signed.xpi",
  [Parameter(Mandatory = $true)]
  [string]$CredentialsFile,
  [switch]$Delete
)
$ErrorActionPreference = 'Stop'
$creds = Get-Content (Resolve-Path $CredentialsFile) -Raw | ConvertFrom-Json

function ConvertTo-B64Url([byte[]]$bytes) {
  [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}
function New-AmoJwt {
  $now = [DateTimeOffset]::UtcNow
  $header = @{ alg = 'HS256'; typ = 'JWT' } | ConvertTo-Json -Compress
  $payload = @{
    iss = $creds.amo_api_key
    jti = [Guid]::NewGuid().ToString()
    iat = $now.AddSeconds(-5).ToUnixTimeSeconds()
    exp = $now.AddMinutes(4).ToUnixTimeSeconds()
  } | ConvertTo-Json -Compress
  $h = ConvertTo-B64Url ([Text.Encoding]::UTF8.GetBytes($header))
  $p = ConvertTo-B64Url ([Text.Encoding]::UTF8.GetBytes($payload))
  $hmac = [Security.Cryptography.HMACSHA256]::new([Text.Encoding]::UTF8.GetBytes($creds.amo_api_secret))
  $sig = ConvertTo-B64Url ($hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes("$h.$p")))
  "$h.$p.$sig"
}

$jwt = New-AmoJwt
$headers = @{ Authorization = "JWT $jwt" }
$base = 'https://addons.mozilla.org/api/v5/addons/addon/tabrecorder@local.dev'

if ($Delete) {
  try {
    Invoke-RestMethod -Method Delete -Uri "$base/versions/$Version/" -Headers $headers | Out-Null
    "deleted version $Version"
  } catch {
    "delete failed: $($_.Exception.Response.StatusCode) $($_.Exception.Message)"
  }
  return
}

$verInfo = Invoke-RestMethod -Uri "$base/versions/$Version/" -Headers $headers
"version found: $($verInfo.version); files: $($verInfo.files.Count)"
$file = $verInfo.files | Select-Object -First 1
"file status: $($file.status), size: $($file.size), url: $($file.url)"

New-Item -ItemType Directory -Path (Split-Path $OutFile) -Force | Out-Null
Invoke-WebRequest -Uri $file.url -Headers $headers -OutFile $OutFile
"downloaded: $OutFile ((Get-Item $OutFile).Length B)"
