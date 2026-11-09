// The browser sends the video straight to S3 in parts (files are too big to pass through the Worker).
// This endpoint signs each part, then finishes or cancels the upload.
import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import {
	AbortMultipartUploadCommand,
	CompleteMultipartUploadCommand,
	UploadPartCommand
} from '@aws-sdk/client-s3';
import { DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { aws, inputKey } from '#lib/server/aws.ts';
import type { RequestHandler } from './$types';

const ref = { id: z.uuid(), uploadId: z.string().min(1) };
const body = z.discriminatedUnion('action', [
	z.object({ action: z.literal('sign'), ...ref, part: z.number().int().min(1).max(10_000) }),
	z.object({
		action: z.literal('complete'),
		...ref,
		etags: z.array(z.string().regex(/^"?[0-9a-f-]+"?$/)).min(1).max(10_000)
	}),
	z.object({ action: z.literal('cancel'), ...ref })
]);

export const POST: RequestHandler = async ({ request }) => {
	const parsed = body.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, 'Invalid upload request');
	const req = parsed.data;
	const { env, s3, db, sign } = aws();
	const target = { Bucket: env.UPLOAD_BUCKET, Key: inputKey(req.id), UploadId: req.uploadId };

	switch (req.action) {
		case 'sign':
			return json({ url: await sign(new UploadPartCommand({ ...target, PartNumber: req.part })) });

		case 'complete':
			// S3 then emits "Object Created", which starts the Fargate job.
			await s3.send(
				new CompleteMultipartUploadCommand({
					...target,
					MultipartUpload: { Parts: req.etags.map((ETag, i) => ({ ETag, PartNumber: i + 1 })) }
				})
			);
			return new Response(null, { status: 204 });

		case 'cancel':
			await Promise.all([
				s3.send(new AbortMultipartUploadCommand(target)),
				db.send(new DeleteCommand({ TableName: env.TABLE, Key: { id: req.id } }))
			]);
			return new Response(null, { status: 204 });
	}
};
