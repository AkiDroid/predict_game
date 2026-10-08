param(
    [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) { throw '请先安装 Python 3.10+，并将 python 加入 PATH。' }
$venv = Join-Path $root '.deploy/venv'
$runner = Join-Path $venv 'Scripts/python.exe'
if (-not (Test-Path $runner)) {
    & $python.Source -m venv $venv
    if ($LASTEXITCODE -ne 0) { throw '创建部署专用 Python 环境失败。' }
}
$requirements = Join-Path $root 'deploy/requirements.txt'
$stamp = Join-Path $venv 'requirements.sha256'
$hash = (Get-FileHash $requirements -Algorithm SHA256).Hash
if (-not (Test-Path $stamp) -or (Get-Content $stamp -Raw).Trim() -ne $hash) {
    & $runner -m pip install --disable-pip-version-check -r $requirements
    if ($LASTEXITCODE -ne 0) { throw '安装部署依赖失败，请检查网络后重试。' }
    Set-Content -LiteralPath $stamp -Value $hash
}
$arguments = @((Join-Path $root 'deploy/deploy.py'))
if ($DryRun) { $arguments += '--dry-run' }
& $runner -X utf8 @arguments
exit $LASTEXITCODE
