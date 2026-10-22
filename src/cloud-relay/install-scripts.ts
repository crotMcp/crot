/** Downloadable bootstrap scripts. Packages remain operator-published, checksum-verified release artifacts. */
export function posixInstaller(origin: string, platform: "linux" | "macos"): string {
  return `#!/usr/bin/env bash
set -euo pipefail
[ "$(uname -s)" = "${platform === "linux" ? "Linux" : "Darwin"}" ] || { echo 'Wrong operating system' >&2; exit 1; }
command -v node >/dev/null || { echo 'Install Node.js 20+ from nodejs.org and retry.' >&2; exit 1; }
node -e 'if(Number(process.versions.node.split(".")[0])<20)process.exit(1)'
command -v npm >/dev/null
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
curl --proto '=https' --tlsv1.2 -fsS '${origin}/download/bundle/${platform}' -o "$work/release.tar.gz"
curl --proto '=https' --tlsv1.2 -fsS '${origin}/download/bundle/${platform}.sha256' -o "$work/expected"
node --input-type=commonjs -e 'const fs=require("fs"),c=require("crypto"),p=process.argv;const expected=fs.readFileSync(p[2],"utf8").trim();if(!/^[a-f0-9]{64}$/.test(expected)||c.createHash("sha256").update(fs.readFileSync(p[1])).digest("hex")!==expected)throw Error("Release checksum mismatch")' "$work/release.tar.gz" "$work/expected"
# Extract only a verified operator-published package into a fresh user-owned directory.
dest="$HOME/.local/share/crot/releases"
mkdir -p "$dest"
root="$(mktemp -d "$dest/release-XXXXXXXX")"
tar -xzf "$work/release.tar.gz" -C "$root"
cd "$root"
npm ci --include=dev --no-audit --no-fund
${
  platform === "linux"
    ? `# OS authorization is explicit; the fixed installer checks/delivers build prerequisites.
sudo /bin/bash "$root/scripts/l1-install.sh" install`
    : `# Seatbelt/private-storage verification is performed by CROT, without elevation.
[ -x /usr/bin/sandbox-exec ] || { echo 'Seatbelt is unavailable on this macOS version.' >&2; exit 1; }`
}
node dist/bin/crot-mcp.js browser install
node dist/bin/crot-mcp.js service autostart install
node dist/bin/crot-mcp.js app
`;
}
export function windowsInstaller(origin: string): string {
  return `# CROT explicit per-user install; host preparation asks for UAC separately.
$ErrorActionPreference = 'Stop'
if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) { throw 'Install Node.js 20+ from nodejs.org and retry.' }
& node.exe -e 'if(Number(process.versions.node.split(".")[0])<20)process.exit(1)'
if ($LASTEXITCODE -ne 0) { throw 'Node.js 20+ is required.' }
$work = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
try {
 $zip = Join-Path $work 'release.zip'
 Invoke-WebRequest -UseBasicParsing -Uri '${origin}/download/bundle/windows' -OutFile $zip
 $expected = (Invoke-WebRequest -UseBasicParsing -Uri '${origin}/download/bundle/windows.sha256').Content.Trim()
 if ($expected -notmatch '^[a-f0-9]{64}$' -or (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) { throw 'Release checksum mismatch.' }
 $root = Join-Path $env:LOCALAPPDATA ('CROT\\releases\\' + [Guid]::NewGuid().ToString('N'))
 Expand-Archive -LiteralPath $zip -DestinationPath $root
 Push-Location $root
 try {
  & npm.cmd ci --include=dev --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
  # Use the same fixed, owner-invoked setup as the desktop UI (UAC + component delivery).
  & node.exe scripts/finish-install.mjs
  if ($LASTEXITCODE -ne 0) { throw 'CROT setup failed.' }
 } finally { Pop-Location }
} finally { Remove-Item -LiteralPath $work -Recurse -Force }
`;
}
