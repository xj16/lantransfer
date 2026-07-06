# Build a static relay binary, then ship it on a scratch image.
FROM golang:1.22-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /out/relay ./cmd/relay

FROM gcr.io/distroless/static-debian12
COPY --from=build /out/relay /relay
EXPOSE 8080
ENV LANTRANSFER_ADDR=:8080
ENTRYPOINT ["/relay"]
