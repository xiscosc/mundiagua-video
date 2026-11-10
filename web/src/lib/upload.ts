// Browser side of the upload. The server signs every S3 request; the browser sends them:
// start the multipart upload, upload the parts (4 at a time, 3 attempts each), then complete it.
import type { CreatedUpload } from './tasks';

const CONCURRENCY = 4;
const ATTEMPTS = 3;

/** Asks the server to sign an S3 request (see src/routes/upload/+server.ts). */
async function signed(body: Record<string, unknown>): Promise<string | null> {
	const res = await fetch('/upload', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body)
	});
	if (!res.ok) throw new Error(`server answered ${res.status}`);
	return ((await res.json()) as { url: string | null }).url;
}

/** Sends an S3 request and returns its XML body; S3 can answer 200 with an <Error> body. */
async function s3(url: string, init: RequestInit) {
	const res = await fetch(url, init);
	const text = await res.text();
	if (!res.ok || text.includes('<Error>')) throw new Error(`S3 answered ${res.status}`);
	return text;
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
 * Uploads the file and completes the upload, which starts processing.
 * On failure or cancel, the task and the partial upload are deleted so nothing is left behind.
 */
export async function uploadVideo(
	file: File,
	{ id, startUrl, contentType, ext, watermarkUrl, partSize }: CreatedUpload,
	signal: AbortSignal,
	onProgress: (loaded: number) => void,
	customWatermark?: File
) {
	const count = Math.ceil(file.size / partSize);
	const etags: string[] = [];
	const loaded = new Array<number>(count).fill(0);
	const report = () => onProgress(loaded.reduce((a, b) => a + b, 0));
	// One failed part stops the others.
	const stop = new AbortController();
	signal.addEventListener('abort', () => stop.abort(), { once: true });
	let uploadId: string | undefined;

	async function worker(uploadId: string) {
		while (next < count && !stop.signal.aborted) {
			const i = next++;
			const blob = file.slice(i * partSize, (i + 1) * partSize);
			for (let attempt = 1; ; attempt++) {
				try {
					const url = await signed({ action: 'sign', id, ext, uploadId, part: i + 1 });
					etags[i] = await putPart(url!, blob, stop.signal, (n) => {
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
	let next = 0;

	try {
		// The custom watermark goes first: completing the video upload starts processing, which needs it.
		if (watermarkUrl && customWatermark) {
			await s3(watermarkUrl, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: customWatermark, signal: stop.signal });
		}
		const started = await s3(startUrl, { method: 'POST', headers: { 'content-type': contentType }, signal: stop.signal });
		uploadId = new DOMParser().parseFromString(started, 'application/xml').querySelector('UploadId')
			?.textContent ?? undefined;
		if (!uploadId) throw new Error('S3 returned no upload id');

		const workers = Math.min(CONCURRENCY, count);
		await Promise.all(Array.from({ length: workers }, () => worker(uploadId!)));

		const parts = etags.map((etag, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${etag}</ETag></Part>`);
		const completeUrl = await signed({ action: 'complete', id, ext, uploadId });
		await s3(completeUrl!, {
			method: 'POST',
			body: `<CompleteMultipartUpload>${parts.join('')}</CompleteMultipartUpload>`
		});
	} catch (err) {
		stop.abort();
		try {
			const abortUrl = await signed({ action: 'cancel', id, ext, uploadId });
			if (abortUrl) await fetch(abortUrl, { method: 'DELETE' });
		} catch {
			// Best effort: S3's lifecycle rule removes unfinished uploads after a day anyway.
		}
		throw err;
	}
}
