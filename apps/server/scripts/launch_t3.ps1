param(
    [string]$BaseDir = (Join-Path ([Environment]::GetFolderPath('UserProfile')) '.t3'),
    [switch]$ShowConfiguration
)
$ErrorActionPreference = 'Stop'
$settingsPath = Join-Path $BaseDir 'userdata\settings.json'
$privacy = $null
if (Test-Path -LiteralPath $settingsPath) {
    $privacy = (Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json).privacy
}
function Allows-T3Data([string]$Name) {
    if ($null -eq $privacy) { return $false }
    $property = $privacy.PSObject.Properties[$Name]
    return $null -ne $property -and $property.Value -is [bool] -and $property.Value
}
$analytics = Allows-T3Data 'productAnalytics'
$diagnostics = Allows-T3Data 'diagnosticExports'
$env:T3CODE_HOME = $BaseDir
$env:T3CODE_PRIVACY_SETTINGS_PATH = $settingsPath
$env:T3CODE_ANALYTICS_ENABLED = if ($analytics) { 'true' } else { 'false' }
$env:T3CODE_TELEMETRY_ENABLED = if ($analytics -or $diagnostics) { 'true' } else { 'false' }
$env:T3CODE_OTEL_SDK_DISABLED = if ($diagnostics) { 'false' } else { 'true' }
$env:T3CODE_DISABLE_OPTIONAL_EGRESS = if (Allows-T3Data 'connect') { 'false' } else { 'true' }
$env:T3CODE_DISABLE_ACTIVITY_PUBLISHING = if (Allows-T3Data 'activityPublishing') { 'false' } else { 'true' }
$env:T3CODE_DISABLE_CODEX_REPORTING = if (Allows-T3Data 'codexReporting') { 'false' } else { 'true' }
$env:T3CODE_DISABLE_CLAUDE_REPORTING = if (Allows-T3Data 'claudeReporting') { 'false' } else { 'true' }
if ($ShowConfiguration) {
    Get-ChildItem Env: | Where-Object { $_.Name -in @('T3CODE_ANALYTICS_ENABLED','T3CODE_TELEMETRY_ENABLED','T3CODE_OTEL_SDK_DISABLED','T3CODE_DISABLE_OPTIONAL_EGRESS','T3CODE_DISABLE_ACTIVITY_PUBLISHING','T3CODE_DISABLE_CODEX_REPORTING','T3CODE_DISABLE_CLAUDE_REPORTING') } | ForEach-Object { @{ name=$_.Name; value=$_.Value } } | ConvertTo-Json
    exit 0
}
$executable = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Programs\t3code\T3 Code (Beta).exe'
$process = Start-Process -FilePath $executable -WorkingDirectory (Split-Path -Parent $executable) -WindowStyle Normal -PassThru
@{ started=$true; pid=$process.Id } | ConvertTo-Json
