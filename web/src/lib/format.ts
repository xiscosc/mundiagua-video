export function formatBytes(bytes: number) {
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let i = 0;
	while (bytes >= 1024 && i < units.length - 1) {
		bytes /= 1024;
		i++;
	}
	return `${bytes.toFixed(i > 1 && bytes < 10 ? 1 : 0)} ${units[i]}`;
}

/** 7445 -> "2h 04m", 372 -> "6m 12s", 45 -> "45s" */
export function formatDuration(seconds: number) {
	const s = Math.round(seconds);
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
	if (m) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
	return `${s}s`;
}

const dateFormat = new Intl.DateTimeFormat('es', {
	day: 'numeric',
	month: 'short',
	hour: '2-digit',
	minute: '2-digit'
});

/** 1794240850105 -> "9 nov, 17:14" */
export function formatDate(ms: number) {
	return dateFormat.format(ms);
}
