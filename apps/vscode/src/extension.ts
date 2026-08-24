import * as vscode from "vscode";
import { AutoPiSidebarProvider } from "./sidebar-provider.ts";

let activeProvider: AutoPiSidebarProvider | undefined;

export function activate(context: vscode.ExtensionContext): void {
	const provider = new AutoPiSidebarProvider(context);
	activeProvider = provider;
	context.subscriptions.push(
		provider,
		vscode.window.registerWebviewViewProvider(AutoPiSidebarProvider.viewType, provider, {
			webviewOptions: { retainContextWhenHidden: true },
		}),
		vscode.commands.registerCommand("autopi.focus", () =>
			vscode.commands.executeCommand("workbench.view.extension.autopi"),
		),
		vscode.commands.registerCommand("autopi.newSession", () => provider.newSession()),
		vscode.commands.registerCommand("autopi.refresh", () => provider.refresh()),
		vscode.commands.registerCommand("autopi.configureApiKey", async () => {
			const apiKey = await vscode.window.showInputBox({
				title: "配置 AutoPi API 密钥",
				prompt:
					"密钥会按当前工作区和 Provider 存入 VS Code SecretStorage，不会写入设置或命令行参数。留空可删除当前作用域的密钥。",
				password: true,
				ignoreFocusOut: true,
			});
			if (apiKey === undefined) return;
			const scope = await provider.configureApiKey(apiKey.trim());
			const action = apiKey.trim() ? "已安全保存" : "已删除";
			void vscode.window.showInformationMessage(
				`AutoPi API 密钥${action}（${scope.workspace} / ${scope.provider}）。`,
			);
		}),
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration("autopi")) void provider.restartHosts();
		}),
	);
}

export async function deactivate(): Promise<void> {
	await activeProvider?.stop();
	activeProvider = undefined;
}
