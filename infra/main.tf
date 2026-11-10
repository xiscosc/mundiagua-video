terraform {
  # State lives in S3 so CI can apply. Bucket and region are passed at init:
  #   terraform init -backend-config="bucket=<state bucket>" -backend-config="region=<region>"
  backend "s3" {
    key          = "video-converter.tfstate"
    use_lockfile = true
  }
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
}

variable "region" { default = "eu-west-1" }
variable "name" {
  description = "Prefix for all resource names"
  default     = "video-converter"
}

variable "web_origin" { description = "URL of the web app (the Cloudflare Worker), allowed to upload to S3 from the browser" }

provider "aws" { region = var.region }

# ---------- storage ----------

# Account-regional namespace: names only have to be unique within this account and region.
data "aws_caller_identity" "current" {}
locals {
  bucket_suffix = "${data.aws_caller_identity.current.account_id}-${var.region}-an"
}

resource "aws_s3_bucket" "uploads" {
  bucket           = "${var.name}-uploads-${local.bucket_suffix}"
  bucket_namespace = "account-regional"
}

resource "aws_s3_bucket" "outputs" {
  bucket           = "${var.name}-outputs-${local.bucket_suffix}"
  bucket_namespace = "account-regional"
}

resource "aws_s3_bucket_cors_configuration" "uploads" {
  bucket = aws_s3_bucket.uploads.id
  cors_rule {
    allowed_methods = ["PUT", "POST", "DELETE"] # the browser starts, uploads, completes and aborts uploads
    allowed_origins = [var.web_origin]
    allowed_headers = ["*"]
    expose_headers  = ["ETag"] # the browser needs each part's ETag to complete the multipart upload
    max_age_seconds = 3600
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "uploads" {
  bucket = aws_s3_bucket.uploads.id
  rule {
    id     = "expire-uploads"
    status = "Enabled"
    filter {}
    expiration { days = 1 }
    abort_incomplete_multipart_upload { days_after_initiation = 1 }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "outputs" {
  bucket = aws_s3_bucket.outputs.id
  rule {
    id     = "expire-outputs"
    status = "Enabled"
    filter {}
    expiration { days = 7 }
  }
}

resource "aws_s3_bucket_notification" "uploads" {
  bucket      = aws_s3_bucket.uploads.id
  eventbridge = true
}

resource "aws_dynamodb_table" "tasks" {
  name         = "${var.name}-tasks"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "id"
  attribute {
    name = "id"
    type = "S"
  }
  ttl {
    attribute_name = "ttl" # epoch seconds, written by the web app
    enabled        = true
  }
}

# ---------- processing (Fargate) ----------

resource "aws_ecr_repository" "ffmpeg" {
  name         = var.name
  force_delete = true
}

# Each deploy moves `latest` to the new image; delete the untagged previous ones.
resource "aws_ecr_lifecycle_policy" "ffmpeg" {
  repository = aws_ecr_repository.ffmpeg.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Expire untagged images"
      selection    = { tagStatus = "untagged", countType = "sinceImagePushed", countUnit = "days", countNumber = 1 }
      action       = { type = "expire" }
    }]
  })
}

resource "aws_cloudwatch_log_group" "ffmpeg" {
  name              = "/ecs/${var.name}"
  retention_in_days = 14
}

resource "aws_ecs_cluster" "main" { name = var.name }

data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${var.name}-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role" "task" {
  name               = "${var.name}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy" "task" {
  role = aws_iam_role.task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = "s3:GetObject", Resource = ["${aws_s3_bucket.uploads.arn}/in/*", "${aws_s3_bucket.uploads.arn}/watermarks/*"] },
      { Effect = "Allow", Action = "s3:PutObject", Resource = "${aws_s3_bucket.outputs.arn}/*" },
      { Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:UpdateItem"], Resource = aws_dynamodb_table.tasks.arn },
    ]
  })
}

resource "aws_ecs_task_definition" "ffmpeg" {
  family                   = var.name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 4096
  memory                   = 8192 # 4 vCPU on Fargate needs at least 8 GB
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn
  ephemeral_storage {
    size_in_gib = 60 # input (up to MAX_SIZE in web/src/lib/tasks.ts, 50 GB) + output
  }
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64" # cheaper than x86 on Fargate; build the image on an arm64 Mac or with --platform linux/arm64
  }
  container_definitions = jsonencode([{
    name      = "ffmpeg"
    image     = "${aws_ecr_repository.ffmpeg.repository_url}:latest"
    essential = true
    environment = [
      { name = "UPLOAD_BUCKET", value = aws_s3_bucket.uploads.id },
      { name = "OUTPUT_BUCKET", value = aws_s3_bucket.outputs.id },
      { name = "TABLE", value = aws_dynamodb_table.tasks.name },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.ffmpeg.name
        awslogs-region        = var.region
        awslogs-stream-prefix = "ffmpeg"
      }
    }
  }])
}

# Default VPC subnets are public: the task gets a public IP, so no NAT Gateway charges on the S3 download.
data "aws_vpc" "default" { default = true }
data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

resource "aws_security_group" "task" {
  name   = "${var.name}-task"
  vpc_id = data.aws_vpc.default.id
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# ---------- trigger: upload to in/ -> RunTask ----------

resource "aws_cloudwatch_event_rule" "uploaded" {
  name = "${var.name}-uploaded"
  event_pattern = jsonencode({
    source        = ["aws.s3"]
    "detail-type" = ["Object Created"]
    detail = {
      bucket = { name = [aws_s3_bucket.uploads.id] }
      object = { key = [{ prefix = "in/" }] }
    }
  })
}

resource "aws_iam_role" "events" {
  name = "${var.name}-events"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = "sts:AssumeRole", Principal = { Service = "events.amazonaws.com" } }]
  })
}

resource "aws_iam_role_policy" "events" {
  role = aws_iam_role.events.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = "ecs:RunTask", Resource = "${aws_ecs_task_definition.ffmpeg.arn_without_revision}:*" },
      { Effect = "Allow", Action = "iam:PassRole", Resource = [aws_iam_role.execution.arn, aws_iam_role.task.arn] },
    ]
  })
}

resource "aws_cloudwatch_event_target" "run" {
  rule     = aws_cloudwatch_event_rule.uploaded.name
  arn      = aws_ecs_cluster.main.arn
  role_arn = aws_iam_role.events.arn
  ecs_target {
    task_definition_arn = aws_ecs_task_definition.ffmpeg.arn
    launch_type         = "FARGATE"
    task_count          = 1
    network_configuration {
      subnets          = data.aws_subnets.default.ids
      security_groups  = [aws_security_group.task.id]
      assign_public_ip = true
    }
  }
  input_transformer {
    input_paths    = { key = "$.detail.object.key" }
    input_template = <<-EOT
      {"containerOverrides":[{"name":"ffmpeg","environment":[{"name":"KEY","value":<key>}]}]}
    EOT
  }
}

output "ecr_repo" { value = aws_ecr_repository.ffmpeg.repository_url }
output "upload_bucket" { value = aws_s3_bucket.uploads.id }
output "output_bucket" { value = aws_s3_bucket.outputs.id }
output "table" { value = aws_dynamodb_table.tasks.name }
