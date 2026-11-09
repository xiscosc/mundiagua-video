// Task model and limits, shared by the server and the browser.
import { z } from 'zod';

export const SPEEDS = [1, 2, 3, 10, 15, 20, 25, 30] as const;
export const DEFAULT_SPEED = 20;
export const GB = 1024 ** 3;
/** Keep below the Fargate task's ephemeral storage (infra/main.tf). */
export const MAX_SIZE = 50 * GB;
/** S3 multipart allows 10,000 parts, so 100 MB parts cover files up to ~1 TB. */
export const PART_SIZE = 100 * 1024 ** 2;
/** Outputs and tasks are deleted after this many days (S3 lifecycle + DynamoDB TTL). */
export const RETENTION_DAYS = 7;
/** A PNG directly in watermarks/: no slashes, no whitespace. Same rule as container/entrypoint.sh. */
export const WATERMARK_NAME = /^[^/\s]+\.png$/;

export type TaskStatus = 'created' | 'processing' | 'done' | 'failed';

export interface Task {
	id: string;
	label: string;
	filename: string;
	size: number;
	/** Input duration in seconds, if the browser could read it. */
	duration?: number;
	speed: number;
	watermark: string;
	status: TaskStatus;
	/** Epoch ms. */
	createdAt: number;
	/** Epoch ms of the last status change. */
	updatedAt: number;
	/** Epoch ms after which the task and its output are deleted. */
	expiresAt: number;
	/** Signed link, only when status is 'done'. */
	downloadUrl?: string;
}

export interface Watermark {
	name: string;
	/** Signed link to the PNG, for thumbnails. */
	url: string;
}

/** Returned by the `create` form action; the browser then uploads the video in parts. */
export interface CreatedUpload {
	id: string;
	/** Signed S3 request that starts the multipart upload. */
	startUrl: string;
	partSize: number;
}

export const newTaskSchema = z.object({
	label: z
		.string()
		.trim()
		.min(1, 'Añade el ID interno del vídeo')
		.max(200, 'El ID interno no puede superar 200 caracteres'),
	filename: z.string().min(1).max(255),
	size: z.coerce.number().int().positive().max(MAX_SIZE, `El vídeo no puede superar ${MAX_SIZE / GB} GB`),
	duration: z.coerce.number().positive().optional(),
	speed: z.coerce.number().refine((s) => (SPEEDS as readonly number[]).includes(s), 'Elige una aceleración'),
	watermark: z.string().regex(WATERMARK_NAME, 'Elige una marca de agua')
});
