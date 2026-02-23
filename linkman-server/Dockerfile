# Build Stage
FROM rust:1.85-slim-bookworm AS builder

# Install build dependencies
RUN apt-get update && apt-get install -y \
    pkg-config \
    libssl-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy the source code
# Since we are in the linkman-server directory, this copies the crate contents
COPY . .

# Build the binary in release mode
# Use SQLX offline mode to avoid needing a live DB during build
ENV SQLX_OFFLINE=true
RUN cargo build --release

# Final Stage
FROM debian:bookworm-slim

# Install runtime dependencies:
# - ca-certificates for HTTPS requests
# - libssl3 for openssl support
# - tzdata for timezone support
RUN apt-get update && apt-get install -y \
    ca-certificates \
    libssl3 \
    tzdata \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy the binary from the builder stage
COPY --from=builder /app/target/release/linkman-server /usr/local/bin/linkman-server

# Expose the server port
EXPOSE 3000

# Set the default command to start the server
ENTRYPOINT ["linkman-server"]
CMD ["serve"]
