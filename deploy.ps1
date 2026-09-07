# Air Ace 一键部署脚本（推送到 GitHub，需先在 github.com/new 创建空仓库 air-ace）
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Test-Path ".git")) {
    git init | Out-Host
    git branch -M main
}
git remote remove origin 2>$null
git remote add origin https://github.com/DDPAT987/air-ace.git

git add -A
$date = Get-Date -Format "yyyy-MM-dd HH:mm"
git commit -m "Air Ace v1.0 browser air combat game - $date" | Out-Host
git push -u origin main --force

Write-Host ""
Write-Host "推送完成。接下来:"
Write-Host "  1. 打开 https://github.com/DDPAT987/air-ace/settings/pages"
Write-Host "  2. Source = Deploy from a branch, Branch = main / (root), Save"
Write-Host "  3. 等 1-3 分钟后访问 https://ddpat987.github.io/air-ace/"
