# Mundiagua Video Converter

Web app to upload a video, apply a watermark and speed it up. Output: 1280×720, H.265; audio removed unless the user keeps it (then sped up with the video).

## Structure

| Path | Contents |
|---|---|
| `web/` | SvelteKit app on Cloudflare Workers |
| `container/` | ffmpeg job, runs on AWS Fargate |
| `infra/` | Terraform for the AWS resources and the Cloudflare Worker |

## How it works

1. The web app creates a task in DynamoDB. The browser uploads the video to S3 (`in/<task id>.mp4`) using signed multipart URLs.
2. The completed upload triggers EventBridge, which starts a Fargate task.
3. The container processes the video, writes `<task id>.mp4` to the outputs bucket and updates the task status.

Task status: `created` → `queued` → `processing` → `done` | `failed`.

## Retention

| Data | Deleted after |
|---|---|
| Uploaded videos and custom watermarks | 1 day |
| Processed videos and tasks | 7 days |
| Container logs (CloudWatch) | 14 days |

## Configuration

| Setting | Location |
|---|---|
| Speeds, maximum file size | `web/src/lib/tasks.ts` |
| Watermarks (1280×720 PNG, no spaces in the name) | `web/src/lib/watermarks/` |
| AWS region and resource names | `infra/main.tf` variables, and the Worker variables in Cloudflare |

Watermarks are included in both the web app and the container image. After changing them, push to `main` (web app) and run the AWS deploy workflow (container image).

## Deployment

- **Web app:** deployed by Cloudflare's GitHub integration (Workers Builds) on every push to the selected branch.
- **AWS:** deployed by `.github/workflows/deploy.yml`, run manually from the Actions tab. It runs `terraform apply` in `infra/`, then builds the container image and pushes it to ECR.

### One-time setup

1. Connect the repository to a Cloudflare Worker (Workers & Pages → Create → Import a repository):

   | Setting | Value |
   |---|---|
   | Root directory | `web` |
   | Build command | `npm run build` |
   | Deploy command | `npx wrangler deploy` |

   Note the Worker URL; it's the `WEB_ORIGIN` below.

2. Create an S3 bucket for the Terraform state:

   ```bash
   aws s3 mb s3://<state bucket> --region <region>
   aws s3api put-bucket-versioning --bucket <state bucket> --versioning-configuration Status=Enabled
   ```

3. In the GitHub repository settings, add:

   | Type | Name | Value |
   |---|---|---|
   | Secret | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | AWS user allowed to manage the resources in `infra/` |
   | Variable | `AWS_REGION` | e.g. `eu-west-1` |
   | Variable | `TF_STATE_BUCKET` | The state bucket from step 2 |
   | Variable | `WEB_ORIGIN` | The Worker URL from step 1, e.g. `https://video-converter.<subdomain>.workers.dev` |

4. Run the AWS deploy workflow to create the AWS resources.

5. Create an IAM user for the Worker with the policy below (resource names are the defaults from `infra/main.tf`), create an access key for it and configure the Worker in Cloudflare:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Action": ["s3:PutObject", "s3:AbortMultipartUpload"],
         "Resource": [
           "arn:aws:s3:::video-converter-uploads-<account id>-<region>-an/in/*",
           "arn:aws:s3:::video-converter-uploads-<account id>-<region>-an/watermarks/*"
         ]
       },
       {
         "Effect": "Allow",
         "Action": "s3:GetObject",
         "Resource": "arn:aws:s3:::video-converter-outputs-<account id>-<region>-an/*"
       },
       {
         "Effect": "Allow",
         "Action": ["dynamodb:Scan", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"],
         "Resource": "arn:aws:dynamodb:<region>:<account id>:table/video-converter-tasks"
       }
     ]
   }
   ```

## Local development

Create `web/.dev.vars` with the same variables and secrets as the Worker, then:

```bash
cd web && npm run dev
```

## Logs

- Container: CloudWatch log group `/ecs/video-converter`
- Web app: `npx wrangler tail`

## Known limitations

- If the container is killed before it can report an error (e.g. out of memory), the task stays in `processing`.
- If the browser is closed during an upload, the task stays in `created` until it expires.
