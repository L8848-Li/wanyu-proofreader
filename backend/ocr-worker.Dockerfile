FROM golang:1.27.4-alpine AS builder
WORKDIR /src
COPY go.mod go.sum ./
COPY ocrengine/ ./ocrengine/
COPY cmd/ocrworker/ ./cmd/ocrworker/
ENV GOMAXPROCS=1 GOFLAGS="-p=1"
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/ocrworker ./cmd/ocrworker

FROM alpine:3.24
ARG ALPINE_MIRROR=https://dl-cdn.alpinelinux.org/alpine
RUN sed -i "s|https://dl-cdn.alpinelinux.org/alpine|${ALPINE_MIRROR}|g" /etc/apk/repositories
RUN --mount=type=cache,target=/var/cache/apk,sharing=locked apk add --update-cache poppler-utils tesseract-ocr tesseract-ocr-data-eng tesseract-ocr-data-chi_sim \
 && addgroup -g 10001 ocr && adduser -D -u 10001 -G ocr ocr
COPY --from=builder /out/ocrworker /usr/local/bin/ocrworker
COPY ocrengine/licenses/ /usr/share/licenses/wanyu-ocr/
USER 10001:10001
WORKDIR /tmp
CMD ["/usr/local/bin/ocrworker"]
