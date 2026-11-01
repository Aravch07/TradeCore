param([switch]$Wasm,[switch]$Test,[string]$WasiSdk)
$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
    New-Item -ItemType Directory -Path 'build' -Force | Out-Null
    $taskCompiler = Get-Command gcc -ErrorAction SilentlyContinue
    if (-not $taskCompiler) { throw 'Install a C11 compiler (MSYS2 UCRT64 GCC on Windows) and add gcc to PATH.' }
    & $taskCompiler.Source -std=c11 -O2 -Wall -Wextra -Wpedantic -Werror -I include src/engine.c src/cli.c -o build/tradecore.exe
    if ($LASTEXITCODE -ne 0) { throw 'Native CLI build failed.' }
    & $taskCompiler.Source -std=c11 -O2 -Wall -Wextra -Werror src/server.c -lws2_32 -o build/tradecore-server.exe
    if ($LASTEXITCODE -ne 0) { throw 'Local C server build failed. Stop it before rebuilding on Windows.' }
    if ($Test) {
        & $taskCompiler.Source -std=c11 -O2 -Wall -Wextra -Wpedantic -Werror -I include src/engine.c tests/test_engine.c -o build/test-engine.exe
        if ($LASTEXITCODE -ne 0) { throw 'Test build failed.' }
        & '.\build\test-engine.exe'
        if ($LASTEXITCODE -ne 0) { throw 'C engine tests failed.' }
    }
    if ($Wasm) {
        if (-not $WasiSdk) { $WasiSdk = $env:WASI_SDK_PATH }
        if (-not $WasiSdk) {
            $taskSdkCache = Join-Path $env:USERPROFILE '.cache\tradecore-tools'
            $taskSdkFolder = Get-ChildItem -LiteralPath $taskSdkCache -Directory -Filter 'wasi-sdk-*-windows' -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
            if ($taskSdkFolder) { $WasiSdk = $taskSdkFolder.FullName }
        }
        $taskClang = if ($WasiSdk) { Join-Path $WasiSdk 'bin\clang.exe' } else { 'clang' }
        & $taskClang --target=wasm32-unknown-unknown -std=c11 -O2 -Wall -Wextra -Werror -nostdlib -fno-builtin -I include '-Wl,--no-entry' '-Wl,--export-all' '-Wl,--export-memory' '-Wl,-z,stack-size=262144' '-Wl,--initial-memory=4194304' '-Wl,--max-memory=8388608' src/engine.c -o web/engine.wasm
        if ($LASTEXITCODE -ne 0) { throw 'WebAssembly build failed. Set WASI_SDK_PATH or pass -WasiSdk.' }
    }
    Write-Host 'Ready: .\build\tradecore.exe (CLI) or .\build\tradecore-server.exe 4173 (website).' -ForegroundColor Green
} finally { Pop-Location }
