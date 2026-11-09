import type { Watermark } from './tasks.ts';

// The PNGs in ./watermarks ship with the app. The container image includes the same
// files (container/Dockerfile), so both sides always have the same set.
const files = import.meta.glob<string>('./watermarks/*.png', {
	eager: true,
	query: '?url',
	import: 'default'
});

export const WATERMARKS: Watermark[] = Object.entries(files)
	.map(([path, url]) => ({ name: path.slice(path.lastIndexOf('/') + 1), url }))
	.sort((a, b) => a.name.localeCompare(b.name));
