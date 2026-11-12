# Checks the Authenticode signatures of a signed Windows build before anything is published (see CODE_SIGNING.md), as
# scripts/verify-mac-release.sh does for macOS. Each file must have, by Microsoft's SignTool and by reading the signature
# itself: a signature that verifies under the default Authenticode policy (/pa) and chains to a trusted root, a SHA-256
# file digest, a signing certificate whose common name is -Publisher, and an RFC 3161 timestamp.
#
#   powershell -NoProfile -File scripts/verify-windows-release.ps1 -Publisher '<CN>' -File <exe>
#       One signed file, such as Foreman.exe before it goes into the installer.
#   powershell -NoProfile -File scripts/verify-windows-release.ps1 -Publisher '<CN>' -Folder <dist>
#       The one installer in <dist>; the Foreman.exe inside it, which must carry the same certificate; and latest.yml and
#       the blockmap beside it, which must describe the signed installer, or installed copies would reject the update.
#
# Windows PowerShell 5.1 (on every Windows runner) with the Windows SDK's SignTool, and 7-Zip for -Folder. It reports
# every problem it finds and exits 1 if there was any.

[CmdletBinding(DefaultParameterSetName = 'Folder')]
param(
  [Parameter(Mandatory = $true)] [string] $Publisher,
  [Parameter(Mandatory = $true, ParameterSetName = 'File')] [string] $File,
  [Parameter(Mandatory = $true, ParameterSetName = 'Folder')] [string] $Folder
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$problems = New-Object System.Collections.Generic.List[string]

$OID_SHA256 = '2.16.840.1.101.3.4.2.1'
$OID_RFC3161_TIMESTAMP = '1.3.6.1.4.1.311.3.3.1'
$OID_TSTINFO = '1.2.840.113549.1.9.16.1.4'

function Find-SignTool {
  $kits = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
  $found = Get-ChildItem $kits -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^\d+(\.\d+){3}$' } |
    Sort-Object { [version]$_.Name } -Descending |
    ForEach-Object { Join-Path $_.FullName 'x64\signtool.exe' } |
    Where-Object { Test-Path $_ } |
    Select-Object -First 1
  if (-not $found) { throw 'SignTool was not found; install the Windows SDK.' }
  $found
}

# The PKCS #7 signature in a PE file's certificate table (WIN_CERTIFICATE), or $null when the file has none.
function Read-PeSignature([string] $Path) {
  $stream = [IO.File]::OpenRead($Path)
  try {
    $reader = New-Object IO.BinaryReader($stream)
    $stream.Position = 0x3C
    $pe = $reader.ReadInt32()
    $stream.Position = $pe
    if ($reader.ReadUInt32() -ne 0x00004550) { throw "$Path is not a PE file." }
    $optional = $pe + 24
    $stream.Position = $optional
    $directories = if ($reader.ReadUInt16() -eq 0x20B) { $optional + 112 } else { $optional + 96 }
    $stream.Position = $directories + 4 * 8 # IMAGE_DIRECTORY_ENTRY_SECURITY: a file offset and a size
    $offset = $reader.ReadUInt32()
    $size = $reader.ReadUInt32()
    if ($offset -eq 0 -or $size -lt 8) { return $null }
    $stream.Position = $offset
    $length = [int]$reader.ReadUInt32()
    $null = $reader.ReadUInt16() # wRevision
    if ($reader.ReadUInt16() -ne 2) { throw "$Path has a certificate table entry that isn't PKCS #7 signed data." }
    $cms = New-Object System.Security.Cryptography.Pkcs.SignedCms
    $cms.Decode($reader.ReadBytes($length - 8))
    $cms
  } finally {
    $stream.Dispose()
  }
}

# Checks one file's signature; returns its signing certificate's thumbprint, or $null when it has no signature.
function Test-Signature([string] $Path, [string] $Name) {
  # SignTool reports failures on stderr, which Windows PowerShell would turn into a terminating error under 'Stop'.
  $ErrorActionPreference = 'Continue'
  $output = (& $script:signtool verify /pa /tw /v $Path 2>&1 | ForEach-Object { "$_" }) -join "`n"
  $code = $LASTEXITCODE
  $ErrorActionPreference = 'Stop'
  # /tw makes a signature without a timestamp a warning, and SignTool exits 2 on a warning.
  if ($code -ne 0) { $problems.Add("${Name}: SignTool did not verify the signature (exit code $code).`n$output") }
  if ($output -notmatch 'Hash of file \(sha256\):') { $problems.Add("${Name}: SignTool does not report a SHA-256 file digest.") }
  $timestamped = [regex]::Match($output, 'The signature is timestamped: (.+)')
  if (-not $timestamped.Success) { $problems.Add("${Name}: SignTool does not report a timestamp.") }

  $cms = Read-PeSignature $Path
  if (-not $cms) {
    $problems.Add("${Name}: the file has no Authenticode signature.")
    return $null
  }
  $signer = $cms.SignerInfos[0]
  $subject = $signer.Certificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
  if ($subject -ne $Publisher) { $problems.Add("${Name}: signed by '$subject', expected '$Publisher'.") }
  if ($signer.DigestAlgorithm.Value -ne $OID_SHA256) { $problems.Add("${Name}: the signature digest is $($signer.DigestAlgorithm.FriendlyName) ($($signer.DigestAlgorithm.Value)), not SHA-256.") }
  $stamps = @($signer.UnsignedAttributes | Where-Object { $_.Oid.Value -eq $OID_RFC3161_TIMESTAMP })
  if ($stamps.Count -eq 0) {
    $problems.Add("${Name}: the signature has no RFC 3161 timestamp.")
  } else {
    $token = New-Object System.Security.Cryptography.Pkcs.SignedCms
    $token.Decode($stamps[0].Values[0].RawData)
    if ($token.ContentInfo.ContentType.Value -ne $OID_TSTINFO) { $problems.Add("${Name}: the RFC 3161 timestamp holds no TSTInfo.") }
  }
  $when = if ($timestamped.Success) { $timestamped.Groups[1].Value.Trim() } else { 'no timestamp' }
  Write-Host "${Name}: signed by '$subject' (certificate $($signer.Certificate.Thumbprint)), timestamped $when"
  $signer.Certificate.Thumbprint
}

function Invoke-7Zip([string[]] $Arguments) {
  $ErrorActionPreference = 'Continue'
  $output = (& 7z @Arguments 2>&1 | ForEach-Object { "$_" }) -join "`n"
  $code = $LASTEXITCODE
  $ErrorActionPreference = 'Stop'
  if ($code -ne 0) { throw "7z $($Arguments -join ' ') failed (exit code $code).`n$output" }
}

function Get-Sha512Base64([string] $Path) {
  $stream = [IO.File]::OpenRead($Path)
  try { [Convert]::ToBase64String([Security.Cryptography.SHA512]::Create().ComputeHash($stream)) } finally { $stream.Dispose() }
}

$script:signtool = Find-SignTool

if ($PSCmdlet.ParameterSetName -eq 'File') {
  $null = Test-Signature (Resolve-Path $File).Path (Split-Path $File -Leaf)
} else {
  $installers = @(Get-ChildItem $Folder -Filter '*.exe' -File)
  if ($installers.Count -ne 1) { throw "Expected one installer in $Folder, found $($installers.Count)." }
  $installer = $installers[0]
  $installerCertificate = Test-Signature $installer.FullName $installer.Name

  # electron-builder's NSIS installer holds the app as $PLUGINSDIR\app-<arch>.7z, which 7-Zip can open.
  $work = Join-Path ([IO.Path]::GetTempPath()) ('foreman-verify-' + [guid]::NewGuid())
  try {
    Invoke-7Zip @('x', '-y', "-o$work\installer", $installer.FullName, '$PLUGINSDIR\app-*.7z')
    $packages = @(Get-ChildItem "$work\installer" -Recurse -Filter 'app-*.7z' -File)
    if ($packages.Count -ne 1) { throw "Expected one app package in $($installer.Name), found $($packages.Count)." }
    Invoke-7Zip @('e', '-y', "-o$work\app", $packages[0].FullName, 'Foreman.exe')
    $appCertificate = Test-Signature "$work\app\Foreman.exe" "Foreman.exe in $($installer.Name)"
    if ($appCertificate -and $installerCertificate -and $appCertificate -ne $installerCertificate) {
      $problems.Add("Foreman.exe and $($installer.Name) are signed with different certificates ($appCertificate, $installerCertificate).")
    }
  } finally {
    Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
  }

  $feedFile = Join-Path $Folder 'latest.yml'
  if (-not (Test-Path $feedFile)) {
    $problems.Add('latest.yml is missing.')
  } else {
    $feed = Get-Content $feedFile -Raw
    $sha512 = Get-Sha512Base64 $installer.FullName
    $hashes = @([regex]::Matches($feed, '(?m)^\s*sha512:\s*(\S+)\s*$') | ForEach-Object { $_.Groups[1].Value })
    $sizes = @([regex]::Matches($feed, '(?m)^\s*size:\s*(\d+)\s*$') | ForEach-Object { [long]$_.Groups[1].Value })
    $path = [regex]::Match($feed, '(?m)^path:\s*(.+?)\s*$').Groups[1].Value
    $feedProblems = $problems.Count
    if ($path -ne $installer.Name) { $problems.Add("latest.yml names '$path', not $($installer.Name).") }
    if ($hashes.Count -eq 0 -or @($hashes | Where-Object { $_ -ne $sha512 }).Count -gt 0) { $problems.Add("latest.yml's sha512 is not the signed installer's ($sha512).") }
    if ($sizes.Count -eq 0 -or @($sizes | Where-Object { $_ -ne $installer.Length }).Count -gt 0) { $problems.Add("latest.yml's size is not the signed installer's ($($installer.Length)).") }
    if ($problems.Count -eq $feedProblems) { Write-Host "latest.yml: describes $($installer.Name) as it is now" }
  }
  if (-not (Test-Path "$($installer.FullName).blockmap")) { $problems.Add("$($installer.Name).blockmap is missing.") }
}

if ($problems.Count -gt 0) {
  foreach ($problem in $problems) { Write-Host "::error::$($problem -replace "`r?`n", '%0A')" }
  exit 1
}
Write-Host 'Windows signatures verified.'
