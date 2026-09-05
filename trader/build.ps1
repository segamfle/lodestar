<#
    Build the trader.

    clang++ rather than cl, because it is roughly a generation ahead on
    autovectorising the kind of flat double loops the engine is made of, and
    -march=native is worth having on a machine that will only ever run its own
    binaries.

    Note what is deliberately absent: -ffast-math. It buys a little on paper
    and breaks the cache outright, because a missing bar is represented as NaN
    and fast-math tells the compiler NaN cannot occur.

        .\build.ps1                  # release build of everything
        .\build.ps1 -Config debug    # sanitised, assertions on
        .\build.ps1 -Target test     # just the tests
        .\build.ps1 -Run             # build, then run the tests
#>

[CmdletBinding()]
param(
    [ValidateSet('all', 'test', 'fetch', 'backtest')]
    [string]$Target = 'all',

    [ValidateSet('release', 'debug')]
    [string]$Config = 'release',

    [switch]$Run
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

$clang = 'C:\Program Files\LLVM\bin\clang++.exe'
if (-not (Test-Path $clang)) {
    throw "clang++ not found at $clang"
}

# clang targets the MSVC ABI on Windows, so it needs the Visual Studio headers
# and import libraries on INCLUDE/LIB. vcvars is the sanctioned way to get them.
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path $vswhere)) {
    throw 'vswhere not found; is Visual Studio installed?'
}
$vsRoot = & $vswhere -latest -products * -property installationPath
$vcvars = Join-Path $vsRoot 'VC\Auxiliary\Build\vcvars64.bat'
if (-not (Test-Path $vcvars)) {
    throw "vcvars64.bat not found under $vsRoot"
}

$common = @(
    '-std=c++23'
    '-Wall', '-Wextra', '-Wpedantic'
    '-Wno-language-extension-token'      # windows.h leans on __int64 and friends
    "-I`"$root\include`""
)

if ($Config -eq 'release') {
    $flags = $common + @('-O3', '-march=native', '-fno-fast-math', '-DNDEBUG')
} else {
    $flags = $common + @('-O0', '-g', '-fno-omit-frame-pointer', '-D_DEBUG')
}

$buildDir = Join-Path $root "build\$Config"
New-Item -ItemType Directory -Force -Path $buildDir | Out-Null

# Every target and the translation units it is made of. Headers are not listed
# because nothing here is precompiled; a changed header just means rebuilding,
# which takes a couple of seconds.
$targets = @{
    test     = @{ out = 'cache_test.exe'; sources = @('tests\cache_test.cpp', 'src\bars.cpp') }
    fetch    = @{ out = 'fetch.exe';      sources = @('tools\fetch.cpp',      'src\bars.cpp') }
    backtest = @{ out = 'backtest.exe';   sources = @('tools\backtest.cpp',   'src\bars.cpp') }
}

$wanted = if ($Target -eq 'all') { $targets.Keys } else { @($Target) }

$built = @()
foreach ($name in $wanted) {
    $spec = $targets[$name]

    $missing = $spec.sources | Where-Object { -not (Test-Path (Join-Path $root $_)) }
    if ($missing) {
        Write-Host "skip  $name (not written yet: $($missing -join ', '))" -ForegroundColor DarkGray
        continue
    }

    $exe = Join-Path $buildDir $spec.out
    $sources = $spec.sources | ForEach-Object { "`"$(Join-Path $root $_)`"" }

    $line = "`"$clang`" $($flags -join ' ') $($sources -join ' ') -o `"$exe`""
    $command = "`"$vcvars`" >nul 2>&1 && $line"

    Write-Host "build $name -> $($spec.out)" -ForegroundColor Cyan
    cmd /c $command
    if ($LASTEXITCODE -ne 0) {
        throw "$name failed to build"
    }
    $built += @{ name = $name; exe = $exe }
}

if (-not $built) {
    Write-Host 'nothing to build' -ForegroundColor Yellow
    return
}

Write-Host "ok    $($built.Count) target(s) in $buildDir" -ForegroundColor Green

if ($Run) {
    foreach ($item in $built) {
        if ($item.name -ne 'test') { continue }
        Write-Host "`nrun   $($item.name)" -ForegroundColor Cyan
        & $item.exe
        if ($LASTEXITCODE -ne 0) {
            throw 'tests failed'
        }
    }
}
