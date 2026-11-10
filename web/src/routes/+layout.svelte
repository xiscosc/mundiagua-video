<script lang="ts">
	import './layout.css';
	import favicon from '#lib/assets/favicon.avif';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();
</script>

<svelte:head>
	<link rel="icon" type="image/avif" href={favicon} />
</svelte:head>

{@render children()}
