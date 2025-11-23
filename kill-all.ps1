# Kill all LSP server, dev server, and watch processes

Write-Host "[Cleanup] Killing all lsp_server processes..." -ForegroundColor Yellow
Get-Process -Name "lsp_server" -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 500

Write-Host "[Cleanup] Killing processes on port 5173..." -ForegroundColor Yellow
Get-NetTCPConnection -LocalPort 5173 -ErrorAction SilentlyContinue | 
    Select-Object -ExpandProperty OwningProcess | 
    Sort-Object -Unique | 
    ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 500

Write-Host "[Cleanup] Killing nodemon processes..." -ForegroundColor Yellow
Get-Process -Name "nodemon" -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 500

Write-Host "[Cleanup] Killing node processes (dev-server.mjs)..." -ForegroundColor Yellow
Get-WmiObject Win32_Process -Filter "name='node.exe'" | Where-Object {
    $_.CommandLine -like "*dev-server.mjs*"
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 500

Write-Host "[Cleanup] Complete!" -ForegroundColor Green
