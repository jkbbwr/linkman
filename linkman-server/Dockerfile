# Build Stage
FROM rust:1.85-slim-bookworm AS builder

# Install build dependencies
RUN apt-get update && apt-get install -y 
    pkg-config 
    libssl-dev 
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy the entire project and build the server
COPY . .

# Build the binary with SQLX offline mode
ENV SQLX_OFFLINE=true
RUN cargo build --release

# Final Stage
FROM debian:bookworm-slim

# Install runtime dependencies
RUN apt-get update && apt-get install -y 
    ca-certificates 
    libssl3 
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy the binary from the builder stage
COPY --from=builder /app/target/release/linkman-server /usr/local/bin/linkman-server

# Expose the server port
EXPOSE 3000

# Set the default command to start the server
ENTRYPOINT ["linkman-server"]
CMD ["serve"]
