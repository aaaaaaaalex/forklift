# 1) Compile the TypeScript frontend (src/*.ts -> static/{app,graph,types}.js).
FROM node:20-slim AS frontend
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# 2) Build the static Go binary, embedding static/ (incl. the compiled JS).
FROM golang:1.24 AS build
WORKDIR /src
COPY go.mod ./
COPY *.go ./
COPY static ./static
COPY --from=frontend /src/static/app.js /src/static/graph.js /src/static/types.js ./static/
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/flui .

# 3) Minimal runtime. distroless ships the cluster CA trust store and runs nonroot.
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/flui /flui
EXPOSE 8080
USER 65532:65532
ENTRYPOINT ["/flui"]
