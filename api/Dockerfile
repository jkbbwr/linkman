# Stage 1: Build
FROM rust:1.88-slim-bookworm AS builder

WORKDIR /app
RUN apt-get update && apt-get install -y pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*

# Copy the entire workspace (or just the api folder if you prefer)
COPY . .

WORKDIR /app/api
RUN cargo build --release

# Stage 2: Runtime
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y libssl3 ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /app/api/target/release/api /app/linkman-api

EXPOSE 3000
CMD ["./linkman-api"]
