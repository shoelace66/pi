# AutoPi Linux x64 beginner guide

The first AutoPi Linux release targets x64 systems using glibc. Ubuntu 22.04, Ubuntu 24.04, and Debian 12 are in the acceptance matrix. Alpine/musl, ARM64, and the Electron desktop application are not included yet.

## Use the command-line package

Download both files from the same GitHub Release:

- `AutoPi-0.84.1-linux-x64.tar.gz`
- `AutoPi-0.84.1-linux-x64.tar.gz.sha256`

Open a terminal in the download directory and run:

```bash
sha256sum -c AutoPi-0.84.1-linux-x64.tar.gz.sha256
mkdir AutoPi-0.84.1-linux-x64
tar -xzf AutoPi-0.84.1-linux-x64.tar.gz -C AutoPi-0.84.1-linux-x64
cd AutoPi-0.84.1-linux-x64
./autopi
```

The checksum command must report `OK`. If Linux reports that the files are not executable, run:

```bash
chmod u+x autopi pi pi-wake
```

`autopi` is the primary command, `pi` is the compatibility entry point, and `pi-wake` delivers Wake events to an AutoPi session that is still online. The archive contains its runtime and does not require Node.js.

On first launch, select a model and follow the provider's login or API-key flow. Run AutoPi only inside trusted projects and review high-risk operations such as command execution and file writes.

## Install the Linux VS Code extension

Download `AutoPi-0.84.1-linux-x64.vsix` and its matching `.sha256` file, then verify and install it:

```bash
sha256sum -c AutoPi-0.84.1-linux-x64.vsix.sha256
code --install-extension AutoPi-0.84.1-linux-x64.vsix
```

You can also choose **Install from VSIX…** from the top-right menu in the Extensions view. After opening a project:

1. Trust the workspace. AutoPi is view-only in an untrusted workspace.
2. Run **AutoPi: Configure API Key**.
3. Select AutoPi in the Activity Bar.
4. Describe the complete workflow in plain language, for example:

```text
After training succeeds, run the test set, analyze the real output, and write reports/eval.md. Stop the remaining stages and explain why if any stage fails.
```

The sidebar shows tool calls, approvals, background tasks, and log files. Generated reports can be opened directly in the editor from the message timeline.

## Remote SSH and WSL

AutoPi is a workspace extension and must be installed where the workspace extension host runs:

- Local Linux project: install the Linux x64 VSIX locally.
- Windows connected to Linux through Remote SSH: connect first, then use **Install from VSIX…** in the remote Extensions view.
- WSL project: open a WSL window and install the Linux x64 VSIX into the WSL extension host.

Do not install the Windows x64 VSIX into a Linux remote host. AutoPi validates the bundled backend platform and build manifest and rejects a mismatched package.

## Automation lifecycle

Managed training, evaluation, and report tasks run only while the corresponding AutoPi CLI or VS Code process remains alive. Closing the host terminates managed process trees. The next launch shows recovery information but does not rerun training or evaluation automatically.
