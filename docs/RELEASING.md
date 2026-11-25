# Releasing updates (Auto Updater)

AutoHR uses `tauri-plugin-updater`. Updates are only installed if they are signed with the
developer's private key; the matching public key is embedded in the app (`tauri.conf.json` →
`plugins.updater.pubkey`). Only administrators can check for or install updates
(Settings → التحديثات), and a verified encrypted backup is written to `Backups/PreUpdate`
before installing. Development builds never install updates.

## One-time: signing key (on the developer's own machine only)

```powershell
npx tauri signer generate -w "$env:USERPROFILE\.tauri\autohr-updater.key"
```

- Keep `autohr-updater.key` and its password **outside the repository**, with an offline copy.
  If it is lost, installed copies can no longer be updated automatically.
- Never commit it, paste it in chat, or upload it. `.gitignore` blocks `*.key` and `.tauri/`.
- Copy the contents of `autohr-updater.key.pub` (the public key) into
  `plugins.updater.pubkey` in `src-tauri/tauri.conf.json` and commit that.

## Each release

1. Bump the version: `npm run version:patch` (or set it), commit.
2. Build signed artifacts:
   ```powershell
   # TAURI_SIGNING_PRIVATE_KEY must hold the key CONTENTS, not its path.
   $env:TAURI_SIGNING_PRIVATE_KEY = Get-Content -Raw "$env:USERPROFILE\.tauri\autohr-updater.key"
   $s = Read-Host "Key password" -AsSecureString
   $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
   npm run tauri:release
   # Afterwards, clear them from the session:
   Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY, Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD
   ```
   This produces in `target/release/bundle/nsis/` the installer `CNSArch_<v>_x64-setup.exe`
   and its signature `CNSArch_<v>_x64-setup.exe.sig`.
3. Write `latest.json`:
   ```json
   {
     "version": "1.0.5",
     "notes": "ما الجديد في هذا الإصدار",
     "pub_date": "2026-12-01T10:00:00Z",
     "platforms": {
       "windows-x86_64": {
         "signature": "<contents of the .sig file>",
         "url": "https://github.com/engessamh-dev/CNSArch-releases/releases/download/v1.0.5/CNSArch_1.0.5_x64-setup.exe"
       }
     }
   }
   ```
4. In the **public releases-only repository** `engessamh-dev/CNSArch-releases` (no source code there),
   create the GitHub Release `v<version>`, mark it as the latest release (not a draft or
   pre-release), and attach the installer, the `.sig` and `latest.json`.
   Since 1.0.5 the app reads `https://github.com/engessamh-dev/CNSArch-releases/releases/latest/download/latest.json`.
   The source repository `engessamh-dev/AutoHR` can stay private.
5. **«ما الجديد» (what's new):** write the notes in the **description** of that same release
   `v<version>` on GitHub, in simple Arabic, one point per line starting with `- `
   (a line starting with `## ` becomes a heading). Since 1.1.0 the app shows this text once,
   on the first sign-in after updating, and from «حول النظام» → «ما الجديد في هذا الإصدار».
   It can be edited on GitHub at any time (Edit release) without a new build.
   Also add the same points to `src/whats-new.json` before building: the app shows that copy
   when it has no internet. The short `notes` in `latest.json` appear in the update prompt.

### Transition from 1.0.3

Copies installed from 1.0.3 still check the old URL in the source repository
(`engessamh-dev/AutoHR/releases/latest/download/latest.json`). To let them update, publish
1.0.5 once in **both** repositories. After every such copy has updated to 1.0.5, the source
repository can be made private; the old URL then simply stops answering.

The normal `npm run tauri:build` does not need the key and does not produce updater files.
