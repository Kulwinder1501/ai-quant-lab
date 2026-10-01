# VOLUME-01 Weekly Auto-Run Script
# Scheduled via Windows Task Scheduler to execute every Monday at 09:00 IST
# Run manually with: .\ops\volume01_weekly_run.ps1

$REPO_ROOT = Split-Path -Parent $PSScriptRoot
$PYTHONPATH = "$REPO_ROOT\apps\ml"
$SCRIPT = "$REPO_ROOT\apps\ml\run_volume_intelligence_experiment.py"
$LOG_DIR = "$REPO_ROOT\logs\volume01"
$DATE_STAMP = (Get-Date -Format "yyyy-MM-dd")
$LOG_FILE = "$LOG_DIR\volume01_run_$DATE_STAMP.log"

# Ensure log directory exists
if (-not (Test-Path $LOG_DIR)) {
    New-Item -ItemType Directory -Path $LOG_DIR | Out-Null
}

Write-Host "============================================================"
Write-Host " VOLUME-01 Weekly Re-Evaluation"
Write-Host " Date        : $DATE_STAMP"
Write-Host " OOS End     : $DATE_STAMP (dynamic - today's date)"
Write-Host " Instruments : BANKNIFTY, NIFTY50"
Write-Host " Log         : $LOG_FILE"
Write-Host "============================================================"

# Run BANKNIFTY
Write-Host "`n[1/2] Running BANKNIFTY..."
$env:PYTHONPATH = $PYTHONPATH
$env:PYTHONUTF8 = "1"

python $SCRIPT `
    --instrument BANKNIFTY `
    --permutations 10000 `
    --bootstraps 10000 `
    --oos-end $DATE_STAMP `
    2>&1 | Tee-Object -FilePath $LOG_FILE -Append

# Run NIFTY50
Write-Host "`n[2/2] Running NIFTY50..."
python $SCRIPT `
    --instrument NIFTY50 `
    --permutations 10000 `
    --bootstraps 10000 `
    --oos-end $DATE_STAMP `
    2>&1 | Tee-Object -FilePath $LOG_FILE -Append

Write-Host "`n============================================================"
Write-Host " Run complete. Results logged to: $LOG_FILE"
Write-Host "============================================================"
