param(
  [string]$SourceRoot = 'E:\Khoa hoc\k6',
  [string]$Message = 'Update docs'
)

$ErrorActionPreference = 'Stop'

$repoRoot = $PSScriptRoot
$repoDocs = Join-Path $repoRoot 'docs'
$sourceDocs = Join-Path $SourceRoot 'docs'
$sourceExamples = Join-Path $SourceRoot 'examples'

function Copy-Tree {
  param(
    [string]$From,
    [string]$To,
    [string[]]$SkipNames = @()
  )

  Get-ChildItem -LiteralPath $From -Recurse -File | Where-Object {
    $SkipNames -notcontains $_.Name
  } | ForEach-Object {
    $relative = $_.FullName.Substring($From.Length).TrimStart('\', '/')
    $destination = Join-Path $To $relative
    $parent = Split-Path -Parent $destination
    if ($parent) {
      New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }
    Copy-Item -LiteralPath $_.FullName -Destination $destination -Force
  }
}

if (-not (Test-Path -LiteralPath $sourceDocs)) {
  throw "Missing source docs folder: $sourceDocs"
}

if (-not (Test-Path -LiteralPath $sourceExamples)) {
  throw "Missing source examples folder: $sourceExamples"
}

New-Item -ItemType Directory -Force -Path $repoDocs | Out-Null

Copy-Tree -From $sourceDocs -To $repoDocs -SkipNames @('mkdocs.yml')
Copy-Tree -From $sourceExamples -To (Join-Path $repoDocs 'examples')

$mkdocsExe = Join-Path $repoRoot '.venv\Scripts\mkdocs.exe'
if (Test-Path -LiteralPath $mkdocsExe) {
  & $mkdocsExe build
} else {
  & mkdocs build
}

& git -C $repoRoot add .github docs mkdocs.yml README.md requirements.txt .gitignore sync-from-source.ps1

if ($LASTEXITCODE -ne 0) {
  throw 'git add failed'
}

& git -C $repoRoot diff --cached --quiet
if ($LASTEXITCODE -eq 0) {
  Write-Host 'No changes to commit.'
  exit 0
}

& git -C $repoRoot commit -m $Message
if ($LASTEXITCODE -ne 0) {
  throw 'git commit failed'
}

& git -C $repoRoot push origin main
if ($LASTEXITCODE -ne 0) {
  throw 'git push failed'
}
