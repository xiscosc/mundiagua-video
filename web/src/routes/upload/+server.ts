// The browser uploads the video straight to S3 in parts (files are too big to pass through the Worker).
// This endpoint only signs the S3 requests; the browser sends them (see src/lib/upload.ts).
import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import {
	AbortMultipartUploadCommand,
	CompleteMultipartUploadCommand,
	UploadPartCommand
} from '@aws-sdk/client-s3';
import { DeleteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { aws, inputKey } from '#lib/server/aws.ts';
import type { RequestHandler } from './$types';

const id = z.uuid();
const uploadId = z.string().min(1);
const body = z.discriminatedUnion('action', [
	z.object({ action: z.literal('sign'), id, uploadId, part: z.number().int().min(1).max(10_000) }),
	z.object({ action: z.literal('complete'), id, uploadId }),
	// uploadId is missing when the upload failed before S3 started it.
	z.object({ action: z.literal('cancel'), id, uploadId: uploadId.optional() })
]);

export const POST: RequestHandler = async ({ request }) => {
	const parsed = body.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, 'Invalid upload request');
	const req = parsed.data;
	const { env, db, sign } = aws();
	const target = { Bucket: env.UPLOAD_BUCKET, Key: inputKey(req.id), UploadId: req.uploadId };

	switch (req.action) {
		case 'sign':
			return json({ url: await sign(new UploadPartCommand({ ...target, PartNumber: req.part })) });

		case 'complete':
			// Completing the upload makes S3 emit "Object Created", which starts the Fargate job.
			// Mark it queued until the container starts (about a minute) and sets it to processing.
			// If the browser then fails to complete, it cancels and the task is deleted.
			await db.send(
				new UpdateCommand({
					TableName: env.TABLE,
					Key: { id: req.id },
					ConditionExpression: 'attribute_exists(id)',
					UpdateExpression: 'SET #status = :status, updatedAt = :now',
					ExpressionAttributeNames: { '#status': 'status' },
					ExpressionAttributeValues: { ':status': 'queued', ':now': Date.now() }
				})
			);
			return json({ url: await sign(new CompleteMultipartUploadCommand(target)) });

		case 'cancel':
			await db.send(new DeleteCommand({ TableName: env.TABLE, Key: { id: req.id } }));
			return json({ url: req.uploadId ? await sign(new AbortMultipartUploadCommand(target)) : null });
	}
};
