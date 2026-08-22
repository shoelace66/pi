// biome-ignore-all lint/a11y/noSvgWithoutTitle: These icon components are decorative and paired with accessible text or labels.

import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

export function PlusIcon(props?: IconProps): React.JSX.Element {
	return (
		<svg
			width="16"
			height="16"
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			{...props}
		>
			<path d="M8 3v10M3 8h10" />
		</svg>
	);
}

export function SearchIcon(props?: IconProps): React.JSX.Element {
	return (
		<svg
			width="16"
			height="16"
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			{...props}
		>
			<circle cx="7" cy="7" r="4.5" />
			<path d="m14 14-3.5-3.5" />
		</svg>
	);
}

export function SettingsIcon(props?: IconProps): React.JSX.Element {
	return (
		<svg
			width="16"
			height="16"
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			{...props}
		>
			<path d="M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z" />
			<path d="M13.5 8a5.5 5.5 0 0 0-.08-.9l1.5-1.2-1.5-2.6-1.8.7a5.5 5.5 0 0 0-1.5-.9L9.5 1h-3l-.6 2.2a5.5 5.5 0 0 0-1.5.9l-1.8-.7-1.5 2.6 1.5 1.2A5.5 5.5 0 0 0 2.5 8c0 .3.03.6.08.9l-1.5 1.2 1.5 2.6 1.8-.7c.45.37.96.68 1.5.9L6.5 15h3l.6-2.2c.54-.22 1.05-.53 1.5-.9l1.8.7 1.5-2.6-1.5-1.2c.05-.3.08-.6.08-.9Z" />
		</svg>
	);
}

export function SendIcon(props?: IconProps): React.JSX.Element {
	return (
		<svg
			width="16"
			height="16"
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			{...props}
		>
			<path d="M2 8l11-5-4 11-2-4-5-2Z" />
		</svg>
	);
}

export function StopIcon(props?: IconProps): React.JSX.Element {
	return (
		<svg
			width="16"
			height="16"
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			{...props}
		>
			<rect x="4" y="4" width="8" height="8" rx="1.5" />
		</svg>
	);
}

export function PinIcon(props?: IconProps): React.JSX.Element {
	return (
		<svg
			width="16"
			height="16"
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			{...props}
		>
			<path d="M9 2 6 5l-3 .5L5 8l-2 4 4-2 2.5 2 .5-3 3-3-4.5-4Z" />
		</svg>
	);
}

export function TrashIcon(props?: IconProps): React.JSX.Element {
	return (
		<svg
			width="16"
			height="16"
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			{...props}
		>
			<path d="M3 4.5h10M6 2.5h4l.75 2H5.25l.75-2ZM4.5 4.5l.6 9h5.8l.6-9M6.5 7v4M9.5 7v4" />
		</svg>
	);
}

export function ArchiveIcon(props?: IconProps): React.JSX.Element {
	return (
		<svg
			width="16"
			height="16"
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			{...props}
		>
			<rect x="2" y="3" width="12" height="3" rx="1" />
			<path d="M3 6v7a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V6" />
			<path d="M6 9h4" />
		</svg>
	);
}

export function CopyIcon(props?: IconProps): React.JSX.Element {
	return (
		<svg
			width="16"
			height="16"
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			{...props}
		>
			<rect x="5" y="5" width="9" height="9" rx="1.5" />
			<path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" />
		</svg>
	);
}

export function CheckIcon(props?: IconProps): React.JSX.Element {
	return (
		<svg
			width="16"
			height="16"
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			{...props}
		>
			<path d="m3 8 3.5 3.5L13 4" />
		</svg>
	);
}

export function FolderIcon(props?: IconProps): React.JSX.Element {
	return (
		<svg
			width="16"
			height="16"
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			{...props}
		>
			<path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6a1 1 0 0 1 .7.3l1.4 1.4a1 1 0 0 0 .7.3H12.5A1.5 1.5 0 0 1 14 6.5v5A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5v-7Z" />
		</svg>
	);
}

export function ChevronDownIcon(props?: IconProps): React.JSX.Element {
	return (
		<svg
			width="16"
			height="16"
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			{...props}
		>
			<path d="m4 6 4 4 4-4" />
		</svg>
	);
}

export function ChevronRightIcon(props?: IconProps): React.JSX.Element {
	return (
		<svg
			width="16"
			height="16"
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			{...props}
		>
			<path d="m6 4 4 4-4 4" />
		</svg>
	);
}

export function SunIcon(props?: IconProps): React.JSX.Element {
	return (
		<svg
			width="16"
			height="16"
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			{...props}
		>
			<circle cx="8" cy="8" r="3" />
			<path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6 13 13M13 3l-1.4 1.4M4.4 11.6 3 13" />
		</svg>
	);
}

export function MoonIcon(props?: IconProps): React.JSX.Element {
	return (
		<svg
			width="16"
			height="16"
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			{...props}
		>
			<path d="M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5Z" />
		</svg>
	);
}

export function CodeIcon(props?: IconProps): React.JSX.Element {
	return (
		<svg
			width="16"
			height="16"
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			{...props}
		>
			<path d="m5 5-3 3 3 3M11 5l3 3-3 3M9.5 3.5l-3 9" />
		</svg>
	);
}

export function TerminalIcon(props?: IconProps): React.JSX.Element {
	return (
		<svg
			width="16"
			height="16"
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			{...props}
		>
			<rect x="2" y="3" width="12" height="10" rx="1.5" />
			<path d="m5 7 2 1.5L5 10M9 10h3" />
		</svg>
	);
}

export function CloseIcon(props?: IconProps): React.JSX.Element {
	return (
		<svg
			width="16"
			height="16"
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			{...props}
		>
			<path d="M4 4l8 8M12 4l-8 8" />
		</svg>
	);
}

export function ClockIcon(props?: IconProps): React.JSX.Element {
	return (
		<svg
			width="16"
			height="16"
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			{...props}
		>
			<circle cx="8" cy="8" r="6" />
			<path d="M8 4.5V8l2.5 1.5" />
		</svg>
	);
}

export function BellIcon(props?: IconProps): React.JSX.Element {
	return (
		<svg
			width="16"
			height="16"
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			{...props}
		>
			<path d="M8 2a4 4 0 0 0-4 4v3l-1.5 2h11L12 9V6a4 4 0 0 0-4-4Z" />
			<path d="M6.5 13a1.5 1.5 0 0 0 3 0" />
		</svg>
	);
}

export function SparkleIcon(props?: IconProps): React.JSX.Element {
	return (
		<svg
			width="16"
			height="16"
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			{...props}
		>
			<path d="M8 1.5 9.8 6.2 14.5 8 9.8 9.8 8 14.5 6.2 9.8 1.5 8 6.2 6.2 8 1.5Z" />
		</svg>
	);
}

export function PaletteIcon(props?: IconProps): React.JSX.Element {
	return (
		<svg
			width="16"
			height="16"
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			{...props}
		>
			<path d="M8 1.5a6.5 6.5 0 0 0 0 13c.83 0 1.5-.67 1.5-1.5 0-.39-.15-.74-.39-1-.24-.27-.39-.62-.39-1 0-.83.67-1.5 1.5-1.5H12a2.5 2.5 0 0 0 2.5-2.5C14.5 3.8 11.6 1.5 8 1.5Z" />
			<circle cx="4.5" cy="8" r=".75" fill="currentColor" stroke="none" />
			<circle cx="6.5" cy="4.5" r=".75" fill="currentColor" stroke="none" />
			<circle cx="10.5" cy="4.5" r=".75" fill="currentColor" stroke="none" />
			<circle cx="11.5" cy="8" r=".75" fill="currentColor" stroke="none" />
		</svg>
	);
}

export function UserIcon(props?: IconProps): React.JSX.Element {
	return (
		<svg
			width="16"
			height="16"
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			{...props}
		>
			<circle cx="8" cy="5" r="3" />
			<path d="M2.5 14a5.5 5.5 0 0 1 11 0" />
		</svg>
	);
}

export function BotIcon(props?: IconProps): React.JSX.Element {
	return (
		<svg
			width="16"
			height="16"
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			{...props}
		>
			<rect x="3" y="5" width="10" height="8" rx="2" />
			<path d="M8 2v3M5.5 9h.01M10.5 9h.01M6.5 11h3" />
		</svg>
	);
}

export function WrenchIcon(props?: IconProps): React.JSX.Element {
	return (
		<svg
			width="16"
			height="16"
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			{...props}
		>
			<path d="M11.5 2.5a3 3 0 0 0-3.8 3.8L2 12l2 2 5.7-5.7a3 3 0 0 0 3.8-3.8l-2 2-1.5-.5-.5-1.5 2-2Z" />
		</svg>
	);
}

export function AlertIcon(props?: IconProps): React.JSX.Element {
	return (
		<svg
			width="16"
			height="16"
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			{...props}
		>
			<path d="M8 2 1.5 13h13L8 2Z" />
			<path d="M8 6.5v3M8 11.5v.01" />
		</svg>
	);
}

export function RefreshIcon(props?: IconProps): React.JSX.Element {
	return (
		<svg
			width="16"
			height="16"
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			{...props}
		>
			<path d="M13.5 5.5A5.5 5.5 0 1 0 14 8M14 3v2.5h-2.5" />
		</svg>
	);
}
