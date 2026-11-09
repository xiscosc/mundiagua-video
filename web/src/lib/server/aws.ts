import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetObjectCommand, S3Client, type UploadPartCommand } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env as workerEnv } from 'cloudflare:workers';

export const inputKey = (taskId: string) => `in/${taskId}.mp4`;

interface AwsEnv {
	AWS_ACCESS_KEY_ID?: string;
	AWS_SECRET_ACCESS_KEY?: string;
	AWS_REGION: string;
	UPLOAD_BUCKET: string;
	OUTPUT_BUCKET: string;
	TABLE: string;
}

/** AWS clients configured from the Worker's vars (wrangler.jsonc) and secrets. */
export function aws() {
	const env = workerEnv as unknown as AwsEnv;
	if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) {
		throw new Error('AWS keys not set: add them as Worker secrets, or to web/.dev.vars for local dev');
	}
	const config = {
		region: env.AWS_REGION,
		credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY }
	};
	const s3 = new S3Client({
		...config,
		// Otherwise the SDK adds checksum params to signed upload links that browsers can't satisfy.
		requestChecksumCalculation: 'WHEN_REQUIRED',
		responseChecksumValidation: 'WHEN_REQUIRED'
	});
	const db = DynamoDBDocumentClient.from(new DynamoDBClient(config), {
		marshallOptions: { removeUndefinedValues: true }
	});
	const sign = (command: GetObjectCommand | UploadPartCommand) =>
		command instanceof GetObjectCommand
			? getSignedUrl(s3, command, { expiresIn: 3600 })
			: getSignedUrl(s3, command, { expiresIn: 3600 });
	return { env, s3, db, sign };
}
