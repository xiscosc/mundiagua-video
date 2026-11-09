import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env as workerEnv } from 'cloudflare:workers';

export const inputKey = (taskId: string) => `in/${taskId}.mp4`;
// Outside in/, so uploading it doesn't start a processing job.
export const customWatermarkKey = (taskId: string) => `watermarks/${taskId}.png`;

interface AwsEnv {
	AWS_ACCESS_KEY_ID?: string;
	AWS_SECRET_ACCESS_KEY?: string;
	AWS_REGION: string;
	UPLOAD_BUCKET: string;
	OUTPUT_BUCKET: string;
	TABLE: string;
}

/**
 * AWS clients configured from the Worker's variables and secrets.
 * The server only signs S3 URLs; the browser makes the S3 calls. The SDK's S3 response
 * parser needs DOMParser, which Workers don't have, so `s3.send` must not be used here.
 */
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
		// Otherwise the SDK adds checksum params to signed URLs that browsers can't satisfy.
		requestChecksumCalculation: 'WHEN_REQUIRED',
		responseChecksumValidation: 'WHEN_REQUIRED'
	});
	const db = DynamoDBDocumentClient.from(new DynamoDBClient(config), {
		marshallOptions: { removeUndefinedValues: true }
	});
	// `as never`: the SDK's per-operation command types don't unify into one parameter type.
	const sign = (command: object) => getSignedUrl(s3, command as never, { expiresIn: 3600 });
	return { env, db, sign };
}
