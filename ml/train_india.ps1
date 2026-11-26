# Trains every all-India model in one go, then the ensemble's rain and ranges and the Ridge baseline (a few hours on an ordinary CPU), writing to
# ml/artifacts/india/<model>/ and a log at ml/train_india.log. While it runs it asks Windows
# not to idle-sleep (SetThreadExecutionState; no settings are changed, and it ends with the job).
# Run from the ml folder:  powershell -ExecutionPolicy Bypass -File train_india.ps1
# 'Continue': TensorFlow writes warnings to stderr, which Windows PowerShell would otherwise treat
# as fatal errors. Failure is judged by each step's exit code instead.
$ErrorActionPreference = 'Continue'
Add-Type -Namespace Win32 -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);'
$ES_CONTINUOUS = [uint32]'0x80000000'; $ES_SYSTEM_REQUIRED = [uint32]'0x00000001'
[void][Win32.Power]::SetThreadExecutionState($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED)

$py = "$HOME\.venvs\weatherai\Scripts\python.exe"
$log = Join-Path $PSScriptRoot 'train_india.log'
$env:TF_CPP_MIN_LOG_LEVEL = '2'
$env:PYTHONUNBUFFERED = '1'
# Adds a timestamped line to the log. Retries briefly: the log is also held open by the training
# step's own output redirect and anyone reading it, and a failed write must not go unnoticed.
function Write-Mark($text) {
    $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $text`r`n"
    for ($i = 0; $i -lt 20; $i++) {
        try { [IO.File]::AppendAllText($log, $line); return } catch { Start-Sleep -Milliseconds 500 }
    }
    Write-Warning "could not write to the log: $text"
}
$steps = @(
    @('-m', 'weatherai_ml.train', '--region', 'india', '--models', 'lstm', 'gru', 'cnn_lstm', 'transformer',
      '--target-mode', 'residual24', '--lookback', '48', '--train-stride', '4', '--loss', 'huber'),
    @('-m', 'weatherai_ml.gbm', '--region', 'india'),
    @('-m', 'weatherai_ml.ensemble', '--region', 'india'),
    # Then the ensemble's rain and ranges, in this order; --fresh so no cached predictions of older models are reused.
    @('-m', 'weatherai_ml.recalibrate', '--region', 'india', '--fresh'),
    @('-m', 'weatherai_ml.rain_chance', '--region', 'india'),
    @('-m', 'weatherai_ml.chance_model', '--region', 'india'),
    @('-m', 'weatherai_ml.rain_amount', '--region', 'india'),
    @('-m', 'weatherai_ml.rain_warning', '--region', 'india'),
    @('-m', 'weatherai_ml.linear', '--region', 'india')
)
try {
    foreach ($s in $steps) {
        Write-Mark "START python $($s -join ' ')"
        # cmd's >> keeps the log readable while it grows (a PowerShell pipe would lock it).
        cmd.exe /c "`"$py`" $($s -join ' ') >> `"$log`" 2>&1"
        if ($LASTEXITCODE -ne 0) { throw "step failed with exit code $LASTEXITCODE" }
        Write-Mark "DONE"
    }
    Write-Mark "ALL DONE"
} catch {
    Write-Mark "FAILED: $_"
    exit 1
} finally {
    [void][Win32.Power]::SetThreadExecutionState($ES_CONTINUOUS)  # back to normal sleep behaviour
}
