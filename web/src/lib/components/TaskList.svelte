<script lang="ts">
	import { enhance } from '$app/forms';
	import { CircleCheck, CircleX, Clock, Download, Inbox, LoaderCircle, CloudUpload, Trash2 } from '@lucide/svelte';
	import type { Task } from '#lib/tasks.ts';
	import { formatBytes, formatDuration, formatDate } from '#lib/format.ts';
	import type { ActiveUpload } from './NewTaskForm.svelte';

	let { tasks, upload }: { tasks: Task[]; upload: ActiveUpload | null } = $props();

	const STATUS = {
		uploading: { text: 'Subiendo', icon: CloudUpload, tone: 'bg-indigo-50 text-indigo-700 ring-indigo-600/20' },
		created: { text: 'Pendiente de subida', icon: Clock, tone: 'bg-zinc-100 text-zinc-600 ring-zinc-500/20' },
		queued: { text: 'Pendiente de procesar', icon: Clock, tone: 'bg-amber-50 text-amber-700 ring-amber-600/20' },
		processing: { text: 'Procesando', icon: LoaderCircle, tone: 'bg-sky-50 text-sky-700 ring-sky-600/20' },
		done: { text: 'Listo', icon: CircleCheck, tone: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20' },
		failed: { text: 'Error', icon: CircleX, tone: 'bg-red-50 text-red-700 ring-red-600/20' }
	};
</script>

<section class="rounded-2xl border border-zinc-200 bg-white shadow-sm" aria-labelledby="tasks-title">
	<header class="border-b border-zinc-100 px-6 py-5">
		<h2 id="tasks-title" class="text-base font-semibold">Vídeos</h2>
		<p class="mt-1 text-sm text-zinc-500">Los vídeos terminados se guardan 7 días.</p>
	</header>

	{#if tasks.length === 0}
		<div class="flex flex-col items-center px-6 py-16 text-center">
			<span class="grid size-12 place-items-center rounded-full bg-zinc-100 text-zinc-400">
				<Inbox class="size-6" aria-hidden="true" />
			</span>
			<p class="mt-4 text-sm font-medium">Aún no hay vídeos</p>
			<p class="mt-1 text-sm text-zinc-500">Sube uno y aparecerá aquí.</p>
		</div>
	{:else}
		<ul class="divide-y divide-zinc-100">
			{#each tasks as task (task.id)}
				{@const uploading = upload?.id === task.id && task.status === 'created'}
				{@const status = STATUS[uploading ? 'uploading' : task.status]}
				<li class="flex flex-col gap-3 px-6 py-4 sm:flex-row sm:items-center">
					<div class="min-w-0 flex-1">
						<div class="flex flex-wrap items-center gap-x-3 gap-y-1">
							<p class="truncate font-medium">{task.label}</p>
							<span class={['inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset', status.tone]}>
								<status.icon class={['size-3.5', task.status === 'processing' && 'animate-spin']} aria-hidden="true" />
								{status.text}
							</span>
						</div>
						<p class="mt-1 truncate text-sm text-zinc-500">
							{task.filename} · {formatBytes(task.size)}{task.duration ? ` · ${formatDuration(task.duration)}` : ''} · {task.speed}× · {task.watermark.replace(/\.png$/, '').replaceAll('_', ' ')}
						</p>
						<p class="mt-0.5 text-xs text-zinc-400">
							{#if uploading && upload}
								{Math.floor((upload.loaded / upload.total) * 100)}% subido
							{:else if task.status === 'queued'}
								Subido {formatDate(task.updatedAt)}
							{:else if task.status === 'processing'}
								Iniciado {formatDate(task.updatedAt)}{task.duration ? ` · duración final ${formatDuration(task.duration / task.speed)}` : ''}
							{:else if task.status === 'done'}
								Terminado {formatDate(task.updatedAt)} · disponible hasta el {formatDate(task.expiresAt)}
							{:else if task.status === 'failed'}
								Falló {formatDate(task.updatedAt)}. Vuelve a subirlo para reintentarlo.
							{:else}
								Creado {formatDate(task.createdAt)}
							{/if}
						</p>
						{#if uploading && upload}
							<div class="mt-2 h-1.5 max-w-sm overflow-hidden rounded-full bg-zinc-100">
								<div class="h-full rounded-full bg-indigo-600 transition-[width] duration-300" style:width="{(upload.loaded / upload.total) * 100}%"></div>
							</div>
						{/if}
					</div>
					<div class="flex shrink-0 items-center gap-2">
					{#if task.downloadUrl}
						<a
							href={task.downloadUrl}
							class="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg bg-zinc-900 px-3.5 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-zinc-700 focus-visible:ring-3 focus-visible:ring-indigo-500/40 focus-visible:outline-none"
						>
							<Download class="size-4" aria-hidden="true" />
							Descargar
						</a>
					{/if}
					{#if !uploading}
						<form
							method="POST"
							action="?/delete"
							use:enhance={({ cancel }) => {
								if (!confirm(`¿Eliminar «${task.label}» de la lista?`)) cancel();
							}}
						>
							<input type="hidden" name="id" value={task.id} />
							<button
								class="grid size-9 place-items-center rounded-lg text-zinc-400 transition hover:bg-red-50 hover:text-red-600 focus-visible:ring-3 focus-visible:ring-red-500/30 focus-visible:outline-none"
								aria-label="Eliminar {task.label}"
								title="Eliminar"
							>
								<Trash2 class="size-4" aria-hidden="true" />
							</button>
						</form>
					{/if}
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</section>
