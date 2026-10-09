# Sequential-connection stress test for local PostgreSQL.
#
# The failure mode under investigation is intermittent: the postmaster survives
# but new BACKEND children fail to start ("could not reserve shared memory
# region ... error code 487"), which manifests as a client hang or
# "server closed the connection unexpectedly".
#
# A single successful connection proves nothing. This opens many short-lived
# connections so the probability of hitting the failure is visible.

param(
  [int]$Attempts = 30,
  [string]$Psql = "C:\pg18\pgsql\bin\psql.exe",
  [string]$DbUser = "raptor_migrator",
  [string]$DbName = "raptor_os",
  [int]$Port = 5432
)

$ok = 0
$fail = 0
$errors = @{}

for ($i = 1; $i -le $Attempts; $i++) {
  $result = & $Psql -U $DbUser -h 127.0.0.1 -p $Port -d $DbName -tAc "select 1;" 2>&1 | Out-String
  if ($LASTEXITCODE -eq 0 -and $result.Trim() -match '^1$') {
    $ok++
  }
  else {
    $fail++
    # Group failures by their first meaningful line so the table shows
    # distinct failure modes rather than N copies of one message.
    $line = ($result -split "`n" |
             Where-Object { $_ -match '\S' -and $_ -notmatch 'At line:|\+ |CategoryInfo|FullyQualifiedErrorId|^\s*$' } |
             Select-Object -First 1)
    if (-not $line) { $line = "unknown (exit=$LASTEXITCODE)" }
    $line = $line.Trim()
    if ($errors.ContainsKey($line)) { $errors[$line]++ } else { $errors[$line] = 1 }
  }
}

Write-Output "connections attempted : $Attempts"
Write-Output "succeeded             : $ok"
Write-Output "failed                : $fail"
Write-Output "success rate          : $([math]::Round(100 * $ok / $Attempts, 1))%"
if ($errors.Count -gt 0) {
  Write-Output ""
  Write-Output "distinct failure modes:"
  $errors.GetEnumerator() | Sort-Object Value -Descending | ForEach-Object {
    Write-Output ("  x{0}  {1}" -f $_.Value, $_.Key)
  }
}

if ($fail -gt 0) { exit 1 }
exit 0