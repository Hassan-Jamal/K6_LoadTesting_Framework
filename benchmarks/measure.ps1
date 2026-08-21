# Samples a process tree's memory and CPU every 500ms while a load test runs.
# Usage: powershell -File measure.ps1 -ProcessName k6 -Label k6 -OutFile k6.metrics.json
param(
  [string]$ProcessName = "k6",
  [string]$Label = "run",
  [string]$OutFile = "metrics.json",
  [int]$MaxSeconds = 240
)

$samples = @()
$started = $false
$deadline = (Get-Date).AddSeconds($MaxSeconds)
$cpuStart = $null
$lastProcs = $null

while ((Get-Date) -lt $deadline) {
  $procs = @(Get-Process -Name $ProcessName -ErrorAction SilentlyContinue)

  if ($procs.Count -gt 0) {
    if (-not $started) {
      $started = $true
      $cpuStart = ($procs | Measure-Object -Property TotalProcessorTime -Sum).Sum
    }
    $lastProcs = $procs
    # WorkingSet64 is resident physical memory - what the process actually occupies.
    $rss = ($procs | Measure-Object -Property WorkingSet64 -Sum).Sum
    $threads = ($procs | ForEach-Object { $_.Threads.Count } | Measure-Object -Sum).Sum
    $cpu = ($procs | ForEach-Object { $_.TotalProcessorTime.TotalSeconds } | Measure-Object -Sum).Sum
    $samples += [pscustomobject]@{
      t       = (Get-Date).ToString("o")
      rssMB   = [math]::Round($rss / 1MB, 1)
      threads = $threads
      cpuSec  = [math]::Round($cpu, 2)
    }
  } elseif ($started) {
    break   # process finished
  }

  Start-Sleep -Milliseconds 500
}

if ($samples.Count -eq 0) {
  '{"error":"process never appeared"}' | Out-File -Encoding utf8 $OutFile
  exit 1
}

$peakRss     = ($samples | Measure-Object -Property rssMB -Maximum).Maximum
$avgRss      = [math]::Round((($samples | Measure-Object -Property rssMB -Average).Average), 1)
$peakThreads = ($samples | Measure-Object -Property threads -Maximum).Maximum
$totalCpu    = ($samples | Measure-Object -Property cpuSec -Maximum).Maximum
$wall        = ([datetime]($samples[-1].t) - [datetime]($samples[0].t)).TotalSeconds

$result = [pscustomobject]@{
  label          = $Label
  peakRssMB      = $peakRss
  avgRssMB       = $avgRss
  peakOsThreads  = $peakThreads
  cpuSeconds     = [math]::Round($totalCpu, 2)
  wallSeconds    = [math]::Round($wall, 1)
  # CPU seconds consumed per wall-clock second, across all cores.
  avgCoresUsed   = [math]::Round($totalCpu / [math]::Max($wall, 1), 2)
  sampleCount    = $samples.Count
  samples        = $samples
}

$result | ConvertTo-Json -Depth 4 | Out-File -Encoding utf8 $OutFile
"$Label -> peak RSS ${peakRss} MB | peak OS threads ${peakThreads} | CPU ${totalCpu}s over ${wall}s"
