# claude-best: uruchamia Claude Code na koncie z najwiekszym zapasem limitu.
#
# Czyta limity wszystkich kont z claude-swap (cswap list --json), wybiera konto,
# na ktorym najwiecej tygodniowego limitu przepadnie, jesli go szybko nie uzyc
# (pozostaly % 7d podzielony przez godziny do resetu 7d), i odpala
# `cswap run N` w TYM oknie terminala. Inne okna zostaja na swoich kontach.
#
# Pomija konta: z oknem 5h od 90%, z limitem 7d od 98%, wymagajace ponownego
# logowania, oraz z limitem modelu od 98%, gdy ten model jest w argumentach
# (np. claude-best --model fable).
#
# Uzycie:
#   claude-best              wybierz konto i uruchom Claude
#   claude-best -n           tylko pokaz tabele i wybor, nic nie uruchamiaj
#   claude-best --resume     argumenty ida dalej do claude
#
# Zainstaluj: skopiuj claude-best.ps1 i claude-best.cmd do katalogu w PATH (np. ~/.local/bin).
# Tylko ASCII: PowerShell 5.1 czyta pliki bez BOM jako ANSI.

$ErrorActionPreference = 'Stop'
$cswap = Join-Path $env:USERPROFILE '.local\bin\cswap.exe'
if (-not (Test-Path $cswap)) { Write-Host "Brak cswap: $cswap" -ForegroundColor Red; exit 2 }

$onlyShow = $false
$pass = @()
foreach ($a in $args) {
    if ($a -eq '-n' -or $a -eq '--pokaz') { $onlyShow = $true } else { $pass += $a }
}
$modelArg = ''
for ($i = 0; $i -lt $pass.Count; $i++) {
    if ($pass[$i] -eq '--model' -and $i + 1 -lt $pass.Count) { $modelArg = ([string]$pass[$i + 1]).ToLower() }
}

$raw = & $cswap list --json 2>$null
try { $data = ($raw -join "`n") | ConvertFrom-Json } catch { Write-Host 'cswap nie zwrocil JSON' -ForegroundColor Red; exit 3 }

$now = [DateTime]::UtcNow
function Pct($w) {
    if ($null -eq $w -or $null -eq $w.pct) { return $null }
    if ($w.resetsAt) {
        $r = [DateTime]::Parse($w.resetsAt).ToUniversalTime()
        if ($r -le $now) { return 0 }
    }
    return [double]$w.pct
}
function Hours($w) {
    if ($null -eq $w -or -not $w.resetsAt) { return 168.0 }
    $h = ([DateTime]::Parse($w.resetsAt).ToUniversalTime() - $now).TotalHours
    return [Math]::Max(1.0, $h)
}

$rows = @()
foreach ($acc in $data.accounts) {
    $u = $acc.usage
    $h5 = $null; $d7 = $null; $hrs = 168.0; $model = $null
    if ($u) {
        $h5 = Pct $u.fiveHour
        $d7 = Pct $u.sevenDay
        $hrs = Hours $u.sevenDay
        foreach ($s in @($u.scoped)) {
            if ($s -and $modelArg -and $modelArg.Contains(([string]$s.name).ToLower())) { $model = Pct $s }
        }
    }
    $why = ''
    if ($acc.usageStatus -ne 'ok') { $why = "status: $($acc.usageStatus)" }
    elseif ($null -eq $d7) { $why = 'brak danych' }
    elseif ($null -ne $h5 -and $h5 -ge 90) { $why = "okno 5h $([Math]::Round($h5))%" }
    elseif ($d7 -ge 98) { $why = "tydzien $([Math]::Round($d7))%" }
    elseif ($null -ne $model -and $model -ge 98) { $why = "limit modelu $([Math]::Round($model))%" }
    $score = if ($why -eq '') { (100 - $d7) / $hrs } else { -1 }
    $rows += [pscustomobject]@{ Nr = $acc.number; Konto = $acc.email; H5 = $h5; D7 = $d7; Godz = $hrs; Wynik = $score; Pominiete = $why }
}

Write-Host ''
Write-Host ' Nr  Konto                          5h     7d   reset 7d   zapas/h' -ForegroundColor DarkGray
foreach ($r in $rows) {
    $h5t = if ($null -eq $r.H5) { '  ?' } else { '{0,3}%' -f [Math]::Round($r.H5) }
    $d7t = if ($null -eq $r.D7) { '  ?' } else { '{0,3}%' -f [Math]::Round($r.D7) }
    $rt = if ($r.Godz -ge 48) { '{0,5:N1} d' -f ($r.Godz / 24) } else { '{0,5:N0} h' -f $r.Godz }
    $sc = if ($r.Wynik -ge 0) { '{0,6:N2}%' -f $r.Wynik } else { '  ' + $r.Pominiete }
    Write-Host (' {0,2}  {1,-28} {2,5}  {3,5}  {4,9}  {5}' -f $r.Nr, $r.Konto, $h5t, $d7t, $rt, $sc)
}

$best = $rows | Where-Object { $_.Wynik -ge 0 } | Sort-Object Wynik -Descending | Select-Object -First 1
if (-not $best) {
    Write-Host ''
    Write-Host 'Zadne konto nie ma teraz wolnego limitu. Sprawdz reset w tabeli.' -ForegroundColor Yellow
    exit 4
}
Write-Host ''
Write-Host ("Wybrane: konto {0} ({1}), {2:N0}% tygodnia wolne, reset za {3:N0} h." -f $best.Nr, $best.Konto, (100 - $best.D7), $best.Godz) -ForegroundColor Green

if ($onlyShow) { exit 0 }
Write-Host ("Start: cswap run {0}" -f $best.Nr) -ForegroundColor DarkGray
if ($pass.Count -gt 0) { & $cswap run $best.Nr -- @pass } else { & $cswap run $best.Nr }
exit $LASTEXITCODE
