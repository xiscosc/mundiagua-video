#!/bin/sh
# One Fargate task per upload. KEY=in/<task id>.mp4 comes from EventBridge;
# UPLOAD_BUCKET, OUTPUT_BUCKET and TABLE come from the task definition.
set -eu
: "${UPLOAD_BUCKET:?}" "${OUTPUT_BUCKET:?}" "${TABLE:?}" "${KEY:?}"
id=$(basename "$KEY" .mp4)
echo "$id" | grep -Eq '^[0-9a-f-]{36}$' || { echo "bad key: $KEY" >&2; exit 1; }
k="{\"id\":{\"S\":\"$id\"}}"

status() {
  # attribute_exists: never resurrect a task the webapp didn't create (or that already expired).
  aws dynamodb update-item --table-name "$TABLE" --key "$k" --condition-expression 'attribute_exists(id)' \
    --update-expression 'SET #s = :s, updatedAt = :t' --expression-attribute-names '{"#s":"status"}' \
    --expression-attribute-values "{\":s\":{\"S\":\"$1\"},\":t\":{\"N\":\"$(date +%s)000\"}}"
}
trap 'rc=$?; [ $rc -eq 0 ] || status failed || true; exit $rc' EXIT

set -- $(aws dynamodb get-item --table-name "$TABLE" --key "$k" --query '[Item.speed.N, Item.watermark.S]' --output text)
speed=$1 wm=$2
# speed goes into the ffmpeg filter string and wm into a file path, so re-check both here.
echo "$speed" | grep -Eq '^[1-9][0-9]?$' || { echo "bad speed: $speed" >&2; exit 1; }
echo "$wm" | grep -Eq '^[^/[:space:]]+\.png$' || { echo "bad watermark: $wm" >&2; exit 1; }

status processing
echo "task $id: ${speed}x with $wm"
aws s3 cp --only-show-errors "s3://$UPLOAD_BUCKET/$KEY" in.mp4

# pools=$(nproc): x265 can't detect CPUs via libnuma inside containers and silently drops its thread pool.
ffmpeg -nostdin -hide_banner -loglevel warning -y -i in.mp4 -i "/watermarks/$wm" -filter_complex \
  "[0:v]setpts=PTS/$speed,fps=30,scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1[v];[1:v]format=rgba,scale=1280:720[wm];[v][wm]overlay=0:0:format=auto" \
  -an -c:v libx265 -x265-params "pools=$(nproc):log-level=error" -preset medium -crf 28 -tag:v hvc1 -pix_fmt yuv420p -movflags +faststart out.mp4

aws s3 cp --only-show-errors out.mp4 "s3://$OUTPUT_BUCKET/$id.mp4"
status done
echo "task $id done ($(du -h out.mp4 | cut -f1))"
