// Browser side of the multipart upload: 4 parts in flight, each retried up to 3 times.
import type { CreatedUpload } from './tasks';

const CONCURRENCY = 4;
const ATTEMPTS = 3;

async function call(body: Record<string, unknown>) {
	const res = await fetch('/upload', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body)
	});
	if (!res.ok) throw new Error(`server answered ${res.status}`);
	return res;
}

function putPart(url: string, blob: Blob, signal: AbortSignal, onProgress: (loaded: number) => void) {
	return new Promise<string>((resolve, reject) => {
		const xhr = new XMLHttpRequest();
		xhr.open('PUT', url);
		xhr.upload.onprogress = (e) => onProgress(e.loaded);
		xhr.onload = () => {
			const etag = xhr.getResponseHeader('ETag');
			if (xhr.status < 300 && etag) resolve(etag);
			else reject(new Error(`S3 answered ${xhr.status}`));
		};
		xhr.onerror = () => reject(new Error('network error'));
		xhr.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'));
		signal.addEventListener('abort', () => xhr.abort(), { once: true });
		xhr.send(blob);
	});
}

/**
 * Uploads the file and completes the multipart upload (which starts processing).
 * On failure or cancel, the task and partial upload are deleted so nothing is left behind.
 */
export async function uploadVideo(
	file: File,
	{ id, uploadId, partSize }: CreatedUpload,
	signal: AbortSignal,
	onProgress: (loaded: number) => void
) {
	const count = Math.ceil(file.size / partSize);
	const etags: string[] = [];
	const loaded = new Array<number>(count).fill(0);
	const report = () => onProgress(loaded.reduce((a, b) => a + b, 0));
	// One failed part stops the others.
	const stop = new AbortController();
	signal.addEventListener('abort', () => stop.abort(), { once: true });

	let next = 0;
	async function worker() {
		while (next < count && !stop.signal.aborted) {
			const i = next++;
			const blob = file.slice(i * partSize, (i + 1) * partSize);
			for (let attempt = 1; ; attempt++) {
				try {
					const res = await call({ action: 'sign', id, uploadId, part: i + 1 });
					const { url } = (await res.json()) as { url: string };
					etags[i] = await putPart(url, blob, stop.signal, (n) => {
						loaded[i] = n;
						report();
					});
					break;
				} catch (err) {
					loaded[i] = 0;
					report();
					if (stop.signal.aborted || attempt === ATTEMPTS) throw err;
					await new Promise((r) => setTimeout(r, 1000 * attempt));
				}
			}
		}
	}

	try {
		await Promise.all(Array.from({ length: Math.min(CONCURRENCY, count) }, worker));
		await call({ action: 'complete', id, uploadId, etags });
	} catch (err) {
		stop.abort();
		await call({ action: 'cancel', id, uploadId }).catch(() => {});
		throw err;
	}
}
