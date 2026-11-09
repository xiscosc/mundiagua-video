# Build from the repo root so the watermarks can be copied in:
#   docker build -f container/Dockerfile .
FROM alpine:3.22
RUN apk add --no-cache ffmpeg aws-cli
COPY web/src/lib/watermarks/ /watermarks/
COPY container/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
WORKDIR /work
ENTRYPOINT ["/entrypoint.sh"]
