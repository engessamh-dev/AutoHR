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
   $env:TAURI_SIGNING_PRIVATE_KEY_PATH = "$env:USERPROFILE\.tauri\autohr-updater.key"
   $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = Read-Host -AsSecureString | ConvertFrom-SecureString -AsPlainText
   npm run tauri:release
   ```
   This produces in `target/release/bundle/nsis/` the installer `CNSArch_<v>_x64-setup.exe`
   and its signature `CNSArch_<v>_x64-setup.exe.sig`.
3. Write `latest.json`:
   ```json
   {
     "version": "1.0.4",
     "notes": "ما الجديد في هذا الإصدار",
     "pub_date": "2026-12-01T10:00:00Z",
     "platforms": {
       "windows-x86_64": {
         "signature": "<contents of the .sig file>",
         "url": "https://github.com/engessamh-dev/AutoHR/releases/download/v1.0.4/CNSArch_1.0.4_x64-setup.exe"
       }
     }
   }
   ```
4. Create the GitHub Release `v<version>` and attach the installer, the `.sig` and `latest.json`.
   The app reads `https://github.com/engessamh-dev/AutoHR/releases/latest/download/latest.json`.

The normal `npm run tauri:build` does not need the key and does not produce updater files.
