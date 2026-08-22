import { useEffect, useRef, useState } from "react";
import type { DesktopExtensionUIRequest, DesktopExtensionUIResponse } from "../../../shared/view-models.ts";
import { useI18n } from "../i18n.tsx";
import { CloseIcon } from "../icons.tsx";
import { cn } from "../utils.ts";

export function ExtensionRequestDialog({
	request,
	onRespond,
}: {
	readonly request: DesktopExtensionUIRequest;
	readonly onRespond: (response: DesktopExtensionUIResponse) => void;
}): React.JSX.Element {
	const { t } = useI18n();
	const cancelled = (): void => onRespond({ requestId: request.requestId, outcome: "cancelled" });
	return (
		<div className="modal-backdrop">
			<div
				className="modal extension-dialog"
				role="dialog"
				aria-modal="true"
				aria-labelledby="extension-dialog-title"
			>
				<header className="modal-header">
					<div>
						<h2 id="extension-dialog-title">{request.title}</h2>
						<p>
							{t("Extension request")}
							{request.timeout !== undefined && (
								<ExtensionCountdown timeout={request.timeout} onDone={cancelled} />
							)}
						</p>
					</div>
					<button
						type="button"
						className="icon-button"
						onClick={cancelled}
						aria-label={t("Cancel extension request")}
					>
						<CloseIcon width={15} height={15} />
					</button>
				</header>
				{request.kind === "select" && <ExtensionSelect request={request} onRespond={onRespond} />}
				{request.kind === "confirm" && <ExtensionConfirm request={request} onRespond={onRespond} />}
				{request.kind === "input" && <ExtensionInput request={request} onRespond={onRespond} />}
			</div>
		</div>
	);
}

function ExtensionCountdown({
	timeout,
	onDone,
}: {
	readonly timeout: number;
	readonly onDone: () => void;
}): React.JSX.Element {
	const { t } = useI18n();
	const [remaining, setRemaining] = useState(() => Math.ceil(timeout / 1000));
	const onDoneRef = useRef(onDone);
	onDoneRef.current = onDone;
	useEffect(() => {
		const startedAt = Date.now();
		const timer = window.setInterval(() => {
			const left = Math.ceil((timeout - (Date.now() - startedAt)) / 1000);
			if (left <= 0) {
				window.clearInterval(timer);
				onDoneRef.current();
				return;
			}
			setRemaining(left);
		}, 250);
		return () => window.clearInterval(timer);
	}, [timeout]);
	return <span className="extension-countdown"> · {t("auto-cancel in {count}s", { count: remaining })}</span>;
}

function cancelResponse(
	request: DesktopExtensionUIRequest,
	onRespond: (response: DesktopExtensionUIResponse) => void,
): () => void {
	return () => onRespond({ requestId: request.requestId, outcome: "cancelled" });
}

function ExtensionSelect({
	request,
	onRespond,
}: {
	readonly request: DesktopExtensionUIRequest & { kind: "select" };
	readonly onRespond: (response: DesktopExtensionUIResponse) => void;
}): React.JSX.Element {
	const { t } = useI18n();
	const [index, setIndex] = useState(0);
	const listRef = useRef<HTMLDivElement>(null);
	useEffect(() => listRef.current?.focus(), []);
	const cancel = cancelResponse(request, onRespond);
	const select = (value: string): void => onRespond({ requestId: request.requestId, outcome: "selected", value });
	if (request.options.length === 0) {
		return (
			<div>
				<p className="extension-message">{t("This extension did not provide any choices.")}</p>
				<footer className="modal-actions">
					<button type="button" className="quiet-button" onClick={cancel}>
						{t("Cancel")}
					</button>
				</footer>
			</div>
		);
	}
	return (
		<div>
			<div
				ref={listRef}
				className="extension-option-list"
				role="listbox"
				tabIndex={0}
				aria-label={request.title}
				onKeyDown={(event) => {
					if (event.key === "ArrowDown") {
						event.preventDefault();
						setIndex((current) => (current + 1) % request.options.length);
					}
					if (event.key === "ArrowUp") {
						event.preventDefault();
						setIndex((current) => (current - 1 + request.options.length) % request.options.length);
					}
					if (event.key === "Home") {
						event.preventDefault();
						setIndex(0);
					}
					if (event.key === "End") {
						event.preventDefault();
						setIndex(request.options.length - 1);
					}
					if (event.key === "Enter") {
						event.preventDefault();
						const value = request.options[index];
						if (value !== undefined) select(value);
					}
					if (event.key === "Escape") {
						event.preventDefault();
						cancel();
					}
				}}
			>
				{request.options.map((option, optionIndex) => (
					<button
						type="button"
						key={`${optionIndex}:${option}`}
						className={cn("extension-option", optionIndex === index && "active")}
						role="option"
						aria-selected={optionIndex === index}
						tabIndex={-1}
						onClick={() => select(option)}
						onMouseEnter={() => setIndex(optionIndex)}
						onFocus={() => setIndex(optionIndex)}
					>
						<span className="extension-option-label">{option}</span>
						<span className="extension-option-meta">{t("Choose")}</span>
					</button>
				))}
			</div>
			<footer className="modal-actions">
				<button type="button" className="quiet-button" onClick={cancel}>
					{t("Cancel")}
				</button>
			</footer>
		</div>
	);
}

function ExtensionConfirm({
	request,
	onRespond,
}: {
	readonly request: DesktopExtensionUIRequest & { kind: "confirm" };
	readonly onRespond: (response: DesktopExtensionUIResponse) => void;
}): React.JSX.Element {
	const { t } = useI18n();
	const confirmRef = useRef<HTMLButtonElement>(null);
	useEffect(() => confirmRef.current?.focus(), []);
	const cancel = cancelResponse(request, onRespond);
	const onEscape = (event: React.KeyboardEvent): void => {
		if (event.key === "Escape") {
			event.preventDefault();
			cancel();
		}
	};
	return (
		<form
			onSubmit={(event) => {
				event.preventDefault();
				onRespond({ requestId: request.requestId, outcome: "confirmed", value: true });
			}}
		>
			<p className="extension-message">{request.message}</p>
			<footer className="modal-actions">
				<button type="button" className="quiet-button" onClick={cancel} onKeyDown={onEscape}>
					{t("Cancel")}
				</button>
				<button type="submit" className="primary-button" ref={confirmRef} onKeyDown={onEscape}>
					{t("Confirm")}
				</button>
			</footer>
		</form>
	);
}

function ExtensionInput({
	request,
	onRespond,
}: {
	readonly request: DesktopExtensionUIRequest & { kind: "input" };
	readonly onRespond: (response: DesktopExtensionUIResponse) => void;
}): React.JSX.Element {
	const { t } = useI18n();
	const [value, setValue] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);
	useEffect(() => inputRef.current?.focus(), []);
	const submit = (): void => {
		if (!value.trim()) return;
		onRespond({ requestId: request.requestId, outcome: "entered", value: value.trim() });
	};
	return (
		<form
			onSubmit={(event) => {
				event.preventDefault();
				submit();
			}}
		>
			<input
				ref={inputRef}
				className="extension-input"
				value={value}
				placeholder={request.placeholder}
				onChange={(event) => setValue(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Escape") {
						event.preventDefault();
						onRespond({ requestId: request.requestId, outcome: "cancelled" });
					}
				}}
			/>
			<footer className="modal-actions">
				<button
					type="button"
					className="quiet-button"
					onClick={() => onRespond({ requestId: request.requestId, outcome: "cancelled" })}
				>
					{t("Cancel")}
				</button>
				<button type="submit" className="primary-button" disabled={!value.trim()}>
					{t("Submit")}
				</button>
			</footer>
		</form>
	);
}
