#!/bin/sh
# One Fargate task per upload. KEY=in/<task id>[.<original extension>] comes from EventBridge;
# UPLOAD_BUCKET, OUTPUT_BUCKET and TABLE come from the task definition.
set -euf # -f: no globbing, so the unquoted $audio and $wm_input below stay as written
: "${UPLOAD_BUCKET:?}" "${OUTPUT_BUCKET:?}" "${TABLE:?}" "${KEY:?}"
id=$(basename "$KEY")
id=${id%.*}
echo "$id" | grep -Eq '^[0-9a-f-]{36}$' || { echo "bad key: $KEY" >&2; exit 1; }
k="{\"id\":{\"S\":\"$id\"}}"

status() {
  # attribute_exists: never resurrect a task the webapp didn't create (or that already expired).
  aws dynamodb update-item --table-name "$TABLE" --key "$k" --condition-expression 'attribute_exists(id)' \
    --update-expression 'SET #s = :s, updatedAt = :t' --expression-attribute-names '{"#s":"status"}' \
    --expression-attribute-values "{\":s\":{\"S\":\"$1\"},\":t\":{\"N\":\"$(date +%s)000\"}}"
}
trap 'rc=$?; [ $rc -eq 0 ] || status failed || true; exit $rc' EXIT

set -- $(aws dynamodb get-item --table-name "$TABLE" --key "$k" --query '[Item.speed.N, Item.watermark.S, Item.removeAudio.BOOL, Item.timestamp.BOOL]' --output text)
speed=$1 wm=$2 remove_audio=$3 timestamp=$4
# speed goes into the ffmpeg filter string and wm into a file path, so re-check both here.
echo "$speed" | grep -Eq '^[1-9][0-9]?$' || { echo "bad speed: $speed" >&2; exit 1; }
[ "$wm" = none ] || [ "$wm" = custom ] || echo "$wm" | grep -Eq '^[^/[:space:]]+\.png$' || { echo "bad watermark: $wm" >&2; exit 1; }

# Keep the audio only when explicitly asked (older tasks have no removeAudio and lose it as before).
# atempo speeds it up by the same factor, so it stays in sync with the video.
if [ "$remove_audio" = False ]; then
  audio="-map 0:a? -filter:a atempo=$speed -c:a aac -b:a 128k"
else
  audio="-an"
fi

# Scale to 720p (letterboxed to 16:9), then overlay the full-frame watermark unless there is none.
# Built-in watermarks ship in the image; a custom one was uploaded by the browser before the video.
# The elapsed time is drawn before the speed-up, so it shows the original video's time (HH:MM:SS).
# Off for older tasks, which have no timestamp field.
clock=""
if [ "$timestamp" = True ]; then
  clock="setpts=PTS-STARTPTS,drawtext=fontfile=/usr/share/fonts/dejavu/DejaVuSans.ttf:text='%{pts\\:gmtime\\:0\\:%H\\\\\\:%M\\\\\\:%S}':x=w/40:y=h-th-h/40:fontsize=h/18:fontcolor=white:box=1:boxcolor=black@0.5:boxborderw=h/90,"
fi
video="[0:v]${clock}setpts=PTS/$speed,fps=30,scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1"
if [ "$wm" = none ]; then
  wm_input=""
  graph="$video[out]"
elif [ "$wm" = custom ]; then
  aws s3 cp --only-show-errors "s3://$UPLOAD_BUCKET/watermarks/$id.png" wm.png
  wm_input="-i wm.png"
  graph="$video[v];[1:v]format=rgba,scale=1280:720[wm];[v][wm]overlay=0:0:format=auto[out]"
else
  wm_input="-i /watermarks/$wm"
  graph="$video[v];[1:v]format=rgba,scale=1280:720[wm];[v][wm]overlay=0:0:format=auto[out]"
fi

status processing
echo "task $id: ${speed}x with $wm, audio: $audio, timestamp: $timestamp"
# Any container ffmpeg can read (MP4, MOV, MKV, AVI...); no extension, ffmpeg detects the format from the content.
aws s3 cp --only-show-errors "s3://$UPLOAD_BUCKET/$KEY" in

# pools=$(nproc): x265 can't detect CPUs via libnuma inside containers and silently drops its thread pool.
ffmpeg -nostdin -hide_banner -loglevel warning -y -i in $wm_input -filter_complex "$graph" \
  -map "[out]" $audio -c:v libx265 -x265-params "pools=$(nproc):log-level=error" -preset fast -crf 28 -tag:v hvc1 -pix_fmt yuv420p -movflags +faststart out.mp4

aws s3 cp --only-show-errors out.mp4 "s3://$OUTPUT_BUCKET/$id.mp4"
status done
echo "task $id done ($(du -h out.mp4 | cut -f1))"
