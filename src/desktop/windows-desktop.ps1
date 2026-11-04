param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("observe", "click", "type", "hotkey")]
  [string]$Action,
  [Parameter(Mandatory = $true)]
  [string]$PayloadBase64
)
# Only predefined operations. Never evaluate arbitrary commands received from a model.
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
if (-not [System.Windows.Forms.SystemInformation]::UserInteractive) {
  throw "Interactive Windows desktop is unavailable."
}
try {
  $json = [System.Text.Encoding]::UTF8.GetString(
    [Convert]::FromBase64String($PayloadBase64)
  )
  $payload = $json | ConvertFrom-Json
} catch {
  throw "Desktop payload is invalid."
}
function Write-Reply([hashtable]$Reply) {
  [Console]::Out.WriteLine(($Reply | ConvertTo-Json -Compress -Depth 4))
}
switch ($Action) {
  "observe" {
    $outputPath = [string]$payload.output
    if (-not [IO.Path]::IsPathRooted($outputPath)) {
      throw "Screenshot path must be absolute."
    }
    $virtual = [System.Windows.Forms.SystemInformation]::VirtualScreen
    if ($virtual.Width -lt 1 -or $virtual.Height -lt 1) {
      throw "No available Windows desktop display."
    }
    $source = $null
    $graphics = $null
    $resized = $null
    $draw = $null
    try {
      $source = New-Object System.Drawing.Bitmap($virtual.Width, $virtual.Height)
      $graphics = [System.Drawing.Graphics]::FromImage($source)
      $graphics.CopyFromScreen($virtual.X, $virtual.Y, 0, 0, $source.Size)
      $scale = [Math]::Min(
        1.0, [Math]::Min(1600.0 / $virtual.Width, 1600.0 / $virtual.Height)
      )
      $width = [Math]::Max(1, [int][Math]::Round($virtual.Width * $scale))
      $height = [Math]::Max(1, [int][Math]::Round($virtual.Height * $scale))
      $resized = New-Object System.Drawing.Bitmap($width, $height)
      $draw = [System.Drawing.Graphics]::FromImage($resized)
      $draw.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $draw.DrawImage($source, 0, 0, $width, $height)
      $resized.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)
      Write-Reply @{
        ok = $true
        width = $width
        height = $height
        virtualLeft = $virtual.X
        virtualTop = $virtual.Y
        virtualWidth = $virtual.Width
        virtualHeight = $virtual.Height
      }
    } finally {
      if ($draw) { $draw.Dispose() }
      if ($resized) { $resized.Dispose() }
      if ($graphics) { $graphics.Dispose() }
      if ($source) { $source.Dispose() }
    }
  }
  "click" {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class WTDesktopClick {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
}
'@
    $x = [int]$payload.x
    $y = [int]$payload.y
    $button = [string]$payload.button
    $clicks = [int]$payload.clicks
    if ($button -notin @("left", "right") -or $clicks -lt 1 -or $clicks -gt 2) {
      throw "Invalid desktop click."
    }
    # Coordinates refer to the most recent scaled screenshot, not to the
    # full-resolution physical desktop. Map all-monitor preview pixels back.
    $virtual = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $scale = [Math]::Min(
      1.0, [Math]::Min(1600.0 / $virtual.Width, 1600.0 / $virtual.Height)
    )
    $previewWidth = [Math]::Max(1, [int][Math]::Round($virtual.Width * $scale))
    $previewHeight = [Math]::Max(1, [int][Math]::Round($virtual.Height * $scale))
    if ($x -lt 0 -or $y -lt 0 -or $x -ge $previewWidth -or $y -ge $previewHeight) {
      throw "Click is outside the current screenshot preview."
    }
    $nativeX = $virtual.X + [int][Math]::Floor(($x + 0.5) * $virtual.Width / $previewWidth)
    $nativeY = $virtual.Y + [int][Math]::Floor(($y + 0.5) * $virtual.Height / $previewHeight)
    if (-not [WTDesktopClick]::SetCursorPos($nativeX, $nativeY)) {
      throw "Could not position the cursor."
    }
    $down = if ($button -eq "left") { [uint32]0x0002 } else { [uint32]0x0008 }
    $up = if ($button -eq "left") { [uint32]0x0004 } else { [uint32]0x0010 }
    for ($i = 0; $i -lt $clicks; $i++) {
      [WTDesktopClick]::mouse_event($down, 0, 0, 0, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds 55
      [WTDesktopClick]::mouse_event($up, 0, 0, 0, [UIntPtr]::Zero)
      if ($i -lt $clicks - 1) { Start-Sleep -Milliseconds 95 }
    }
    Write-Reply @{ ok = $true; x = $x; y = $y; button = $button; clicks = $clicks }
  }
  "type" {
    $text = [string]$payload.text
    if ($text.Length -gt 500) { throw "Desktop input is too long." }
    foreach ($letter in $text.ToCharArray()) {
      $character = [string]$letter
      if ($character -eq [string][char]13) { continue }
      if ($character -eq [string][char]10) { $send = "{ENTER}" }
      elseif ($character -eq [string][char]9) { $send = "{TAB}" }
      elseif ($character -eq "{") { $send = "{{}" }
      elseif ($character -eq "}") { $send = "{}}" }
      elseif ($character -match '^[+^%~()\[\]]$') { $send = "{" + $character + "}" }
      else { $send = $character }
      [System.Windows.Forms.SendKeys]::SendWait($send)
    }
    Write-Reply @{ ok = $true; characters = $text.Length }
  }
  "hotkey" {
    $combo = ([string]$payload.combo).ToUpperInvariant()
    $parts = $combo.Split("+")
    if ($parts.Count -lt 1 -or $parts.Count -gt 4) {
      throw "Invalid hotkey."
    }
    $last = $parts[$parts.Count - 1]
    $allowed = $last -match '^[A-Z0-9]$' -or
      $last -match '^F(?:[1-9]|1[0-2])$' -or
      $last -in @("ENTER", "ESC", "TAB", "BACKSPACE", "DELETE", "SPACE",
        "UP", "DOWN", "LEFT", "RIGHT", "HOME", "END", "PGUP", "PGDN")
    if (-not $allowed) { throw "Unsupported hotkey." }
    $prefix = ""
    $modifiers = @()
    for ($i = 0; $i -lt $parts.Count - 1; $i++) {
      $modifier = $parts[$i]
      if ($modifier -notin @("CTRL", "ALT", "SHIFT") -or $modifiers -contains $modifier) {
        throw "Invalid hotkey modifiers."
      }
      $modifiers += $modifier
      if ($modifier -eq "CTRL") { $prefix += "^" }
      if ($modifier -eq "ALT") { $prefix += "%" }
      if ($modifier -eq "SHIFT") { $prefix += "+" }
    }
    $special = @{
      "ESC" = "ESC"; "ENTER" = "ENTER"; "TAB" = "TAB";
      "BACKSPACE" = "BACKSPACE"; "DELETE" = "DELETE"; "SPACE" = "SPACE";
      "UP" = "UP"; "DOWN" = "DOWN"; "LEFT" = "LEFT"; "RIGHT" = "RIGHT";
      "HOME" = "HOME"; "END" = "END"; "PGUP" = "PGUP"; "PGDN" = "PGDN";
    }
    $key = if ($special.ContainsKey($last) -or $last -match '^F(?:[1-9]|1[0-2])$') {
      "{" + $last + "}"
    } else { $last.ToLowerInvariant() }
    [System.Windows.Forms.SendKeys]::SendWait($prefix + $key)
    Write-Reply @{ ok = $true; combo = $combo }
  }
}
