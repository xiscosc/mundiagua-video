<script lang="ts">
	import { enhance, type SubmitFunction } from '$app/forms';
	import { invalidate } from '$app/navigation';
	import { Check, CircleAlert, CircleCheck, CloudUpload, Film, Gauge, X } from '@lucide/svelte';
	import { DEFAULT_SPEED, GB, MAX_SIZE, SPEEDS, type CreatedUpload, type Watermark } from '#lib/tasks.ts';
	import { formatBytes, formatDuration } from '#lib/format.ts';
	import { uploadVideo } from '#lib/upload.ts';

	export interface ActiveUpload {
		id: string;
		label: string;
		loaded: number;
		total: number;
		startedAt: number;
	}

	let {
		watermarks,
		upload = $bindable(null)
	}: { watermarks: Watermark[]; upload: ActiveUpload | null } = $props();

	let file = $state<File | null>(null);
	let duration = $state<number>();
	/** A still frame of the chosen video, for the watermark preview. */
	let frame = $state('');
	let label = $state('');
	let chosenWatermark = $state('');
	const watermark = $derived(chosenWatermark || watermarks[0]?.name || '');
	const watermarkUrl = $derived(watermarks.find((w) => w.name === watermark)?.url);
	let speed = $state<number>(DEFAULT_SPEED);
	let dragging = $state(false);
	let creating = $state(false);
	let error = $state('');
	let notice = $state('');
	let controller: AbortController | null = null;
	let fileInput: HTMLInputElement;

	const busy = $derived(creating || upload !== null);
	const rate = $derived(upload ? upload.loaded / Math.max(1, (Date.now() - upload.startedAt) / 1000) : 0);

	function pick(f: File | undefined) {
		error = '';
		notice = '';
		if (!f) return;
		if (f.type !== 'video/mp4' && !f.name.toLowerCase().endsWith('.mp4')) {
			error = 'Solo se admiten vídeos MP4.';
			return;
		}
		if (f.size > MAX_SIZE) {
			error = `Este vídeo ocupa ${formatBytes(f.size)}. El máximo es ${MAX_SIZE / GB} GB.`;
			return;
		}
		file = f;
		duration = undefined;
		frame = '';
		readVideo(f);
	}

	/** Reads the video's length (for "duración final") and grabs a frame (for the preview). */
	function readVideo(f: File) {
		const video = document.createElement('video');
		const url = URL.createObjectURL(f);
		video.muted = true;
		video.preload = 'auto';
		video.onloadedmetadata = () => {
			if (file !== f || !Number.isFinite(video.duration)) return URL.revokeObjectURL(url);
			duration = video.duration;
			video.currentTime = Math.min(1, video.duration / 2);
		};
		video.onseeked = () => {
			if (file === f && video.videoWidth) {
				const canvas = document.createElement('canvas');
				canvas.width = Math.min(1280, video.videoWidth);
				canvas.height = Math.round((video.videoHeight * canvas.width) / video.videoWidth);
				canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height);
				frame = canvas.toDataURL('image/jpeg', 0.85);
			}
			URL.revokeObjectURL(url);
		};
		video.onerror = () => URL.revokeObjectURL(url);
		video.src = url;
	}

	function clearFile() {
		file = null;
		duration = undefined;
		frame = '';
		if (fileInput) fileInput.value = '';
	}

	function onDrop(e: DragEvent) {
		e.preventDefault();
		dragging = false;
		if (!busy) pick(e.dataTransfer?.files[0]);
	}

	const submit: SubmitFunction = ({ formData, cancel }) => {
		error = '';
		notice = '';
		if (!file) {
			error = 'Primero elige un vídeo.';
			return cancel();
		}
		if (!label.trim()) {
			error = 'Añade el ID interno del vídeo.';
			return cancel();
		}
		const video = file;
		const taskLabel = label.trim();
		formData.set('filename', video.name);
		formData.set('size', String(video.size));
		if (duration) formData.set('duration', String(duration));
		creating = true;

		return async ({ result }) => {
			creating = false;
			if (result.type === 'failure') {
				error = (result.data?.error as string) ?? 'No se pudo crear la tarea.';
				return;
			}
			if (result.type !== 'success' || !result.data) {
				error = 'No se pudo crear la tarea. Inténtalo de nuevo.';
				return;
			}
			const created = result.data as unknown as CreatedUpload;
			controller = new AbortController();
			upload = { id: created.id, label: taskLabel, loaded: 0, total: video.size, startedAt: Date.now() };
			await invalidate('app:tasks');
			try {
				await uploadVideo(video, created, controller.signal, (loaded) => {
					if (upload) upload.loaded = loaded;
				});
				notice = `“${taskLabel}” se ha subido. Ya puedes cerrar esta página.`;
				clearFile();
				label = '';
			} catch (err) {
				console.error(err);
				error =
					err instanceof DOMException && err.name === 'AbortError'
						? 'Subida cancelada.'
						: 'Error al subir el vídeo. Inténtalo de nuevo.';
			} finally {
				upload = null;
				controller = null;
				await invalidate('app:tasks');
			}
		};
	};
</script>

<svelte:window onbeforeunload={(e) => upload && e.preventDefault()} />

<section
	class="rounded-2xl border border-zinc-200 bg-white shadow-sm"
	aria-labelledby="new-task-title"
>
	<header class="border-b border-zinc-100 px-6 py-5">
		<h2 id="new-task-title" class="text-base font-semibold">Nuevo vídeo</h2>
		<p class="mt-1 text-sm text-zinc-500">
			Sube un vídeo, elige la marca de agua y la aceleración. Se procesa en segundo plano.
		</p>
	</header>

	<form method="POST" action="?/create" use:enhance={submit} class="space-y-6 px-6 py-6">
		<fieldset disabled={busy} class="space-y-6">
			<!-- Video -->
			<div>
				<span class="mb-2 block text-sm font-medium">Vídeo</span>
				{#if file}
					<div class="overflow-hidden rounded-xl border border-zinc-200">
						<!-- Preview, laid out like ffmpeg: video letterboxed to 16:9, watermark stretched over the frame -->
						<div
							class="relative aspect-video bg-black"
							role="img"
							aria-label="Vista previa del vídeo con la marca de agua"
						>
							{#if frame}
								<img src={frame} alt="" class="absolute inset-0 size-full object-contain" />
							{/if}
							{#if watermarkUrl}
								<img src={watermarkUrl} alt="" class="absolute inset-0 size-full" />
							{/if}
						</div>
						<div class="flex items-center gap-3 px-4 py-3">
							<Film class="size-5 shrink-0 text-zinc-400" aria-hidden="true" />
							<div class="min-w-0 flex-1">
								<p class="truncate text-sm font-medium">{file.name}</p>
								<p class="text-xs text-zinc-500">
									{formatBytes(file.size)}{duration ? ` · ${formatDuration(duration)}` : ''}
								</p>
							</div>
							<button
								type="button"
								onclick={clearFile}
								class="rounded-lg p-1.5 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 disabled:opacity-50"
								aria-label="Quitar vídeo"
							>
								<X class="size-4" />
							</button>
						</div>
					</div>
				{:else}
					<label
						for="video"
						class={[
							'flex cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors',
							dragging
								? 'border-indigo-500 bg-indigo-50'
								: 'border-zinc-300 hover:border-indigo-400 hover:bg-zinc-50'
						]}
						ondragover={(e) => {
							e.preventDefault();
							dragging = true;
						}}
						ondragleave={() => (dragging = false)}
						ondrop={onDrop}
					>
						<span class="grid size-12 place-items-center rounded-full bg-indigo-50 text-indigo-600">
							<CloudUpload class="size-6" aria-hidden="true" />
						</span>
						<span class="text-sm">
							<span class="font-semibold text-indigo-600">Elige un vídeo</span> o arrástralo aquí
						</span>
						<span class="text-xs text-zinc-500">MP4, hasta {MAX_SIZE / GB} GB</span>
					</label>
				{/if}
				<!-- No name: the file goes straight to S3, never through the form. -->
				<input
					bind:this={fileInput}
					id="video"
					type="file"
					accept="video/mp4,.mp4"
					class="sr-only"
					onchange={(e) => pick(e.currentTarget.files?.[0])}
				/>
			</div>

			<!-- Label -->
			<div>
				<label for="label" class="mb-2 block text-sm font-medium">ID interno</label>
				<input
					id="label"
					name="label"
					bind:value={label}
					maxlength="200"
					placeholder="p. ej. MA-2026-0153"
					class="block w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm shadow-xs outline-none placeholder:text-zinc-400 focus:border-indigo-500 focus:ring-3 focus:ring-indigo-500/20"
				/>
				<p class="mt-1.5 text-xs text-zinc-500">
					Para identificar el vídeo en la lista. También es el nombre del archivo al descargarlo.
				</p>
			</div>

			<!-- Watermark -->
			<fieldset>
				<legend class="mb-2 text-sm font-medium">Marca de agua</legend>
				{#if watermarks.length === 0}
					<p class="rounded-lg border border-dashed border-zinc-300 px-4 py-6 text-center text-sm text-zinc-500">
						No hay marcas de agua disponibles.
					</p>
				{:else}
					<div class="grid grid-cols-3 gap-2 sm:grid-cols-4">
						{#each watermarks as wm (wm.name)}
							<label
								class={[
									'group relative cursor-pointer overflow-hidden rounded-xl border-2 transition has-focus-visible:ring-3 has-focus-visible:ring-indigo-500/30',
									watermark === wm.name
										? 'border-indigo-500'
										: 'border-zinc-200 hover:border-zinc-300'
								]}
							>
								<input
									type="radio"
									name="watermark"
									value={wm.name}
									checked={watermark === wm.name}
									onchange={() => (chosenWatermark = wm.name)}
									class="sr-only"
								/>
								<div class="bg-checkerboard aspect-video">
									<img src={wm.url} alt="" class="size-full object-contain" loading="lazy" />
								</div>
								<div class="border-t border-zinc-100 px-2 py-1">
									<span class="block text-[11px] leading-tight font-medium">{wm.name.replace(/\.png$/, '').replaceAll('_', ' ')}</span>
								</div>
								{#if watermark === wm.name}
									<span class="absolute top-1 right-1 grid size-4 place-items-center rounded-full bg-indigo-600 text-white shadow">
										<Check class="size-3" strokeWidth={3} aria-hidden="true" />
									</span>
								{/if}
							</label>
						{/each}
					</div>
				{/if}
			</fieldset>

			<!-- Speed -->
			<fieldset>
				<legend class="mb-2 text-sm font-medium">Aceleración</legend>
				<div class="grid grid-cols-4 gap-1 rounded-xl bg-zinc-100 p-1 sm:grid-cols-8">
					{#each SPEEDS as s (s)}
						<label
							class={[
								'cursor-pointer rounded-lg py-2 text-center text-sm font-medium transition has-focus-visible:ring-3 has-focus-visible:ring-indigo-500/30',
								speed === s
									? 'bg-white text-indigo-700 shadow-sm'
									: 'text-zinc-600 hover:text-zinc-900'
							]}
						>
							<input type="radio" name="speed" value={s} bind:group={speed} class="sr-only" />
							{s}×
						</label>
					{/each}
				</div>
				<p class="mt-2 flex items-center gap-1.5 text-xs text-zinc-500">
					<Gauge class="size-3.5" aria-hidden="true" />
					{#if duration}
						{formatDuration(duration)} se queda en <strong class="font-semibold text-zinc-700">{formatDuration(duration / speed)}</strong>
					{:else}
						Un vídeo de 2 horas se queda en {formatDuration(7200 / speed)}
					{/if}
				</p>
			</fieldset>

			<!-- Audio -->
			<label class="flex cursor-pointer items-center gap-2.5 text-sm font-medium">
				<input
					type="checkbox"
					name="removeAudio"
					checked
					class="size-4 rounded border-zinc-300 accent-indigo-600"
				/>
				Eliminar audio
			</label>
		</fieldset>

		{#if error}
			<p role="alert" class="flex items-start gap-2 rounded-lg bg-red-50 px-3 py-2.5 text-sm text-red-700">
				<CircleAlert class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
				{error}
			</p>
		{/if}
		{#if notice}
			<p role="status" class="flex items-start gap-2 rounded-lg bg-emerald-50 px-3 py-2.5 text-sm text-emerald-800">
				<CircleCheck class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
				{notice}
			</p>
		{/if}

		{#if upload}
			{@const pct = Math.floor((upload.loaded / upload.total) * 100)}
			<div class="rounded-xl border border-indigo-200 bg-indigo-50/60 p-4" role="status">
				<div class="flex items-center justify-between text-sm">
					<span class="font-medium">Subiendo… {pct}%</span>
					<button
						type="button"
						onclick={() => controller?.abort()}
						class="rounded-md px-2 py-1 text-xs font-medium text-zinc-600 hover:bg-white hover:text-zinc-900"
					>
						Cancelar
					</button>
				</div>
				<div class="mt-3 h-2 overflow-hidden rounded-full bg-indigo-100">
					<div class="h-full rounded-full bg-indigo-600 transition-[width] duration-300" style:width="{pct}%"></div>
				</div>
				<p class="mt-2 text-xs text-zinc-600">
					{formatBytes(upload.loaded)} de {formatBytes(upload.total)}
					{#if rate > 0}
						· {formatBytes(rate)}/s · quedan {formatDuration((upload.total - upload.loaded) / rate)}
					{/if}
					· No cierres esta página.
				</p>
			</div>
		{:else}
			<button
				type="submit"
				disabled={busy}
				class="flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-500 focus-visible:ring-3 focus-visible:ring-indigo-500/40 focus-visible:outline-none disabled:opacity-60"
			>
				<CloudUpload class="size-4" aria-hidden="true" />
				{creating ? 'Preparando…' : 'Subir y procesar'}
			</button>
		{/if}
	</form>
</section>
