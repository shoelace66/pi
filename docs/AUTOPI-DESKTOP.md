# AutoPi Desktop

AutoPi Desktop is the graphical product surface for the same agent runtime used by the AutoPi command line. It is not a separate agent implementation: both interfaces use `@earendil-works/pi-coding-agent`, the same session files, model settings, extensions, tools, and Wake runtime.

## Product behavior

- Opening a workspace lists and resumes its existing AutoPi sessions.
- The most recently selected session is restored automatically for each workspace.
- Settings can enable **Start AutoPi at login** on packaged Windows builds.
- The integrated terminal, workspace explorer, Git view, prompts, tools, slash commands, and background activities all operate through the typed Electron bridge.
- The desktop process is single-instance; opening AutoPi again focuses the existing window.
- The packaged directory includes `autopi.cmd` for CLI access, `pi.cmd` for compatibility, and `pi-wake.cmd` for external Wake delivery.

## Run from source

```powershell
npm install --ignore-scripts
npm run build
.\autopi.bat
```

Use `.\autopi.bat --cli` for the source command-line interface. Add `--build` to force a desktop rebuild, or `--dev` to use the Vite development server.

## Verification

```powershell
npm run check
npm --workspace @autopi/desktop test
```

The desktop tests cover command parsing, localized text, long histories, automation input, workspace files, Git status, and terminal cancellation. Root checks cover formatting, types, generated model data, package boundaries, and desktop type safety.

## Windows release

```powershell
npm run package:desktop
```

This command builds the core and desktop, stages local workspace packages, packages Electron for Windows x64, applies the official AutoPi icon, and writes the following under `.artifacts`:

- `AutoPi-<version>-win-x64/`
- `AutoPi-<version>-win-x64.zip`
- `AutoPi-<version>-win-x64.zip.sha256`

Every portable directory contains `START-HERE-开始使用.txt`, `使用教程.md`, `README.txt`, the project license, and `BUILD-MANIFEST.json` / `BUILD-MANIFEST.txt`. The manifest records the product version, core version, Electron version, source revision, dirty-source flag, build ID, component hashes, and a deterministic tree digest. Packaging extracts the ZIP again and verifies that it is the same build before succeeding.

For the maintained Windows handoff:

```powershell
npm run release:desktop
```

This additionally replaces `D:\PiDesktop` with the verified output and compares its build ID and tree digest with the packaged source. The target guard rejects a drive root, user home, repository root, relative target, or a path containing the repository.
