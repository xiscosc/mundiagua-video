import { fail } from '@sveltejs/kit';
import { CreateMultipartUploadCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { DeleteCommand, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { aws, inputKey } from '#lib/server/aws.ts';
import { WATERMARKS } from '#lib/watermarks.ts';
import { newTaskSchema, PART_SIZE, RETENTION_DAYS, type CreatedUpload, type Task } from '#lib/tasks.ts';
import type { Actions, PageServerLoad } from './$types';

/** File name for downloads, built from the task label. */
const downloadName = (label: string) =>
	`${label.replace(/[^\w .()-]+/g, '_').trim().slice(0, 100) || 'video'}.mp4`;

export const load: PageServerLoad = async ({ depends }) => {
	depends('app:tasks');
	try {
		return { tasks: await listTasks(), awsError: false };
	} catch (err) {
		// Show the page with a message instead of a bare 500.
		console.error(err);
		return { tasks: [] as Task[], awsError: true };
	}
};

async function listTasks() {
	const { env, db, sign } = aws();

	const items: Record<string, unknown>[] = [];
	let ExclusiveStartKey: Record<string, unknown> | undefined;
	do {
		const page = await db.send(new ScanCommand({ TableName: env.TABLE, ExclusiveStartKey }));
		items.push(...(page.Items ?? []));
		ExclusiveStartKey = page.LastEvaluatedKey;
	} while (ExclusiveStartKey);

	const now = Date.now();
	const tasks = items
		.map(({ ttl: _ttl, ...item }) => item as unknown as Task)
		.filter((t) => t.expiresAt > now) // DynamoDB TTL deletes can lag by up to ~2 days
		.sort((a, b) => b.createdAt - a.createdAt);

	await Promise.all(
		tasks
			.filter((t) => t.status === 'done')
			.map(async (t) => {
				const output = { Bucket: env.OUTPUT_BUCKET, Key: `${t.id}.mp4` };
				[t.downloadUrl, t.playUrl] = await Promise.all([
					sign(
						new GetObjectCommand({
							...output,
							ResponseContentDisposition: `attachment; filename="${downloadName(t.label)}"`
						})
					),
					sign(new GetObjectCommand(output))
				]);
			})
	);
	return tasks;
}

export const actions: Actions = {
	/** Creates the task and signs the request that starts its upload; the browser does the rest (src/lib/upload.ts). */
	create: async ({ request }) => {
		const form = Object.fromEntries(await request.formData());
		const parsed = newTaskSchema.safeParse({
			...form,
			duration: form.duration || undefined,
			removeAudio: form.removeAudio === 'on' // an unchecked checkbox isn't sent at all
		});
		if (!parsed.success) return fail(400, { error: parsed.error.issues[0].message });
		const input = parsed.data;

		if (!WATERMARKS.some((w) => w.name === input.watermark)) {
			return fail(400, { error: 'Esa marca de agua ya no existe. Recarga la página.' });
		}
		const { env, db, sign } = aws();

		const now = Date.now();
		const task: Task = {
			id: crypto.randomUUID(),
			...input,
			status: 'created',
			createdAt: now,
			updatedAt: now,
			expiresAt: now + RETENTION_DAYS * 24 * 3600 * 1000
		};
		// `ttl` (epoch seconds) is the attribute DynamoDB's TTL deletes on.
		await db.send(
			new PutCommand({ TableName: env.TABLE, Item: { ...task, ttl: Math.floor(task.expiresAt / 1000) } })
		);
		const startUrl = await sign(
			new CreateMultipartUploadCommand({ Bucket: env.UPLOAD_BUCKET, Key: inputKey(task.id) })
		);
		return { id: task.id, startUrl, partSize: PART_SIZE } satisfies CreatedUpload;
	},

	/** Removes the task from the list. Its files are left to expire on their own. */
	delete: async ({ request }) => {
		const id = (await request.formData()).get('id');
		if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) return fail(400, { error: 'Tarea no válida.' });
		const { env, db } = aws();
		await db.send(new DeleteCommand({ TableName: env.TABLE, Key: { id } }));
	}
};
