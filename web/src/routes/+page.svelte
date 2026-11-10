<script lang="ts">
	import NewTaskForm, { type ActiveUpload } from '#lib/components/NewTaskForm.svelte';
	import TaskList from '#lib/components/TaskList.svelte';
	import { WATERMARKS } from '#lib/watermarks.ts';
	import type { PageProps } from './$types';
	import logo from '#lib/assets/logo.png';

	let { data }: PageProps = $props();
	let upload = $state<ActiveUpload | null>(null);
</script>

<svelte:head>
	<title>Mundiagua Video Converter</title>
</svelte:head>

<div class="min-h-dvh">
	<header class="border-b border-zinc-200 bg-white">
		<div class="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3 sm:px-6">
			<img src={logo} alt="Mundiagua" class="h-12 w-auto" />
			<h1 class="border-l border-zinc-200 pl-3 text-base font-semibold">Video Converter</h1>
		</div>
	</header>

	{#if data.awsError}
		<div class="mx-auto max-w-7xl px-4 pt-6 sm:px-6">
			<p role="alert" class="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
				No se puede conectar con el servidor. Inténtalo más tarde.
			</p>
		</div>
	{/if}

	<main class="mx-auto grid max-w-7xl items-start gap-6 px-4 py-6 sm:px-6 lg:grid-cols-[minmax(0,28rem)_minmax(0,1fr)] lg:py-10">
		<NewTaskForm watermarks={WATERMARKS} bind:upload />
		<TaskList tasks={data.tasks} {upload} />
	</main>
</div>
